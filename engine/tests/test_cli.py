"""The `serve` startup sequence.

The ordering here is the whole of DUR-3 and it is invisible in a diff: the
port must be claimed BEFORE create_app runs, because create_app builds the
JobQueue and JobQueue.__init__ recovers interrupted jobs by flipping every
RENDERING row back to QUEUED. When create_app(config) was passed as an
*argument* to uvicorn.run it was evaluated first, so a second engine that was
about to exit with "address in use" had already resurrected the first
engine's in-flight job — and both then rendered it.

Nothing else in the suite reaches this path: it lives above the FastAPI app
the API tests build directly, and it ends in a blocking server.run.
"""

from __future__ import annotations

import socket

import pytest

from localcut_engine import cli


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def spy_create_app(monkeypatch):
    """Record whether create_app ran, without letting it actually run.

    Patched on the module rather than on cli, because cli imports it inside
    main() — the import happens per call and picks this up.
    """
    from localcut_engine.api import app as app_module

    calls: list[object] = []

    def recording(config=None):
        calls.append(config)
        raise AssertionError("create_app must not run when the port is already held")

    monkeypatch.setattr(app_module, "create_app", recording)
    return calls


def test_a_held_port_exits_cleanly_without_building_the_app(tmp_path, spy_create_app, capsys):
    """The defect this encodes: a second engine touched the first engine's
    queue on its way to failing."""
    port = _free_port()
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("127.0.0.1", port))
    holder.listen(1)
    try:
        code = cli.main(
            ["serve", "--port", str(port), "--data-dir", str(tmp_path), "--backend", "mock"]
        )
    finally:
        holder.close()

    assert code == 1
    assert spy_create_app == [], "the app was built despite the bind failing"
    error = capsys.readouterr().err
    # The message has to name the port and say what to do — "address in use"
    # on its own sends people to a search engine.
    assert str(port) in error
    assert "already running" in error


def test_a_free_port_reaches_the_server_with_the_socket_already_bound(tmp_path, monkeypatch):
    """The other half of the ordering: on the happy path the app IS built,
    and the socket handed to uvicorn is the one the CLI bound itself — not a
    second bind uvicorn does later, which would reopen the race."""
    import uvicorn

    from localcut_engine.api import app as app_module

    built: list[object] = []
    monkeypatch.setattr(app_module, "create_app", lambda config=None: built.append(config))

    served: dict = {}

    def fake_run(self, sockets=None):
        served["sockets"] = sockets

    monkeypatch.setattr(uvicorn.Server, "run", fake_run)

    port = _free_port()
    code = cli.main(
        ["serve", "--port", str(port), "--data-dir", str(tmp_path), "--backend", "mock"]
    )

    assert code == 0
    assert len(built) == 1, "the app was not built on the happy path"
    assert served["sockets"] and len(served["sockets"]) == 1
    listening = served["sockets"][0]
    assert listening.getsockname()[1] == port
    listening.close()


def test_the_connection_line_the_desktop_shell_parses_is_still_printed(tmp_path, monkeypatch):
    """The shell reads `LOCALCUT_ENGINE {json}` off stdout to learn the url
    and token. Moving the bind ahead of it must not have moved it after the
    blocking run, or the app would never connect."""
    import contextlib
    import io
    import json

    import uvicorn

    from localcut_engine.api import app as app_module

    monkeypatch.setattr(app_module, "create_app", lambda config=None: None)
    monkeypatch.setattr(uvicorn.Server, "run", lambda self, sockets=None: None)

    # redirect_stdout rather than capsys: argparse and logging both write
    # during main(), and capsys interleaves them awkwardly with the one line
    # under test.
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        cli.main(
            [
                "serve",
                "--port",
                str(_free_port()),
                "--data-dir",
                str(tmp_path),
                "--backend",
                "mock",
                "--token",
                "shell-token",
            ]
        )
    line = next(a for a in buffer.getvalue().splitlines() if a.startswith("LOCALCUT_ENGINE "))
    payload = json.loads(line.removeprefix("LOCALCUT_ENGINE "))
    assert payload["token"] == "shell-token"
    assert payload["host"] == "127.0.0.1"


def test_a_network_bind_without_a_token_is_refused(tmp_path, monkeypatch):
    """An empty token counts as unconfigured — `--token ""` would otherwise
    put the engine on the LAN with a secret compare_digest accepts from
    anyone."""
    monkeypatch.delenv("LOCALCUT_TOKEN", raising=False)
    with pytest.raises(SystemExit):
        cli.main(["serve", "--host", "0.0.0.0", "--token", "", "--data-dir", str(tmp_path)])
