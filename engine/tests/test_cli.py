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

from conftest import free_port
from localcut_engine import cli


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
    port = free_port()
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

    port = free_port()
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
                str(free_port()),
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


def _cp1252_stream():
    """A stdout exactly like the one Windows hands a piped/service process:
    cp1252, strict. A real console gets UTF-8 via WriteConsoleW, so this only
    ever bites headless — which is the deployment the pairing block is for."""
    import io

    return io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict", newline="")


def _serve_on(stream, tmp_path, monkeypatch) -> int:
    """`serve --host 0.0.0.0` with the server stubbed out, printing to
    `stream`. The network bind is what triggers the pairing block."""
    import uvicorn

    from localcut_engine import tls
    from localcut_engine.api import app as app_module

    monkeypatch.setattr(app_module, "create_app", lambda config=None: None)
    monkeypatch.setattr(uvicorn.Server, "run", lambda self, sockets=None: None)
    # Real key generation is seconds of CPU and proves nothing here; the
    # fingerprint is only needed so the TLS headline is the one printed.
    cert = tmp_path / "c.pem"
    cert.write_text("x", encoding="utf-8")
    monkeypatch.setattr(tls, "ensure_certificate", lambda *a, **k: (cert, cert, "a" * 64))
    monkeypatch.setattr(cli.sys, "stdout", stream)

    return cli.main(
        [
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            str(free_port()),
            "--token",
            "shell-token",
            "--data-dir",
            str(tmp_path),
            "--backend",
            "mock",
        ]
    )


def test_the_pairing_block_reads_correctly_on_a_cp1252_console(tmp_path, monkeypatch):
    """The block used to carry `→`, which cp1252 cannot encode: printing it
    raised UnicodeEncodeError and killed the engine at startup, before uvicorn
    ever ran, on exactly the headless network bind the block exists for.

    Retuning the streams stopped the crash but printed `\\u2192` in its place —
    a mangled escape in the one instruction the operator has to follow. So the
    block is ASCII now, and this is what holds it there: `errors="strict"`
    means a re-introduced arrow fails at the encode, and the escape assertion
    catches one that the guard degraded instead."""
    stream = _cp1252_stream()

    assert _serve_on(stream, tmp_path, monkeypatch) == 0

    stream.flush()
    printed = stream.buffer.getvalue().decode("cp1252")
    assert "Remote engine ready" in printed
    assert "Settings > Remote engine" in printed
    assert "pairing code:" in printed
    assert "LOCALCUT_ENGINE " in printed
    # Nothing was degraded on the way out — the block is legible, not merely
    # survivable.
    assert "\\u" not in printed, printed


def test_serve_retunes_the_console_before_it_prints(tmp_path, monkeypatch):
    """The pairing block is ASCII by construction now, but it is not the only
    thing this process writes: uvicorn's own logs, an OSError's strerror on a
    localised Windows, and any future string all go to the same stream. The
    guard has to stay installed on the startup path, so assert the wiring
    rather than a crash the block can no longer cause."""
    stream = _cp1252_stream()

    assert _serve_on(stream, tmp_path, monkeypatch) == 0

    assert stream.errors == "backslashreplace"


def test_a_retuned_stream_degrades_an_impossible_character(monkeypatch):
    """What the guard buys: text cp1252 cannot represent costs a legible
    escape, not the process."""
    stream = _cp1252_stream()
    monkeypatch.setattr(cli.sys, "stdout", stream)

    cli._survive_console_encoding()
    print("shutting down → goodbye", file=cli.sys.stdout, flush=True)

    assert stream.buffer.getvalue().decode("cp1252") == "shutting down \\u2192 goodbye\n"


@pytest.mark.parametrize("module", ["cli", "automation", "mcp_server"])
def test_every_string_the_cli_can_print_is_ascii(module):
    """The rule, rather than the instances of it.

    Everything these modules put in a string literal reaches a console: the
    pairing block, the bind-failure advice, every argparse help line, every
    error the automation client raises. On a headless Windows box stdout is
    the ANSI code page (cp1252 piped, cp850 in a bare cmd.exe), and
    `_survive_console_encoding` turns anything it cannot encode into a
    `\\uXXXX` escape — so a non-ASCII character here does not crash any more,
    it just makes an operator-facing message unreadable in the deployment
    that needs it most. Docstrings are exempt: they are read in the source,
    never printed.
    """
    import ast
    import importlib
    from pathlib import Path as _Path

    target = importlib.import_module(f"localcut_engine.{module}")
    source = _Path(target.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and ast.get_docstring(node) is not None
    }
    offenders = [
        (node.lineno, ascii(char), node.value[:70])
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
        for char in node.value
        if not char.isascii()
    ]
    assert not offenders, f"non-ASCII in printable strings: {offenders}"


def test_survive_console_encoding_is_safe_on_a_stream_it_cannot_retune(monkeypatch):
    """Never turn a logging concern into a startup failure of its own."""
    import io

    monkeypatch.setattr(cli.sys, "stdout", io.StringIO())
    monkeypatch.setattr(cli.sys, "stderr", None)
    cli._survive_console_encoding()  # must not raise


def test_a_cleartext_pairing_block_says_the_app_will_refuse_it(capsys):
    """--no-tls prints a pairing code the desktop rejects outright
    (parsePairingCode allows http only to loopback). Printing it with no
    explanation sends the operator to an error message in a different
    codebase."""
    cli._print_pairing("http", "192.168.1.50", 7830, "tok", None)

    printed = capsys.readouterr().out
    assert "REFUSE" in printed
    assert "--no-tls" in printed


def test_a_tls_pairing_block_does_not_carry_the_warning(capsys):
    cli._print_pairing("https", "192.168.1.50", 7830, "tok", "a" * 64)

    printed = capsys.readouterr().out
    assert "REFUSE" not in printed
    assert "fingerprint:" in printed


def test_a_second_engine_cannot_share_a_data_directory(tmp_path):
    """The port is not what has to be exclusive — the DATA DIRECTORY is.

    Binding first stops two engines on one host:port, but two on different
    ports shared one queue.db and one project tree: the same job rendered
    twice on one GPU, both wrote the same project.json, and status flipped
    between them with nothing on screen to say so. The bind message even
    sent people there, by offering a different --port as the remedy.
    """
    from localcut_engine.cli import DataDirBusy, _hold_data_dir

    held = _hold_data_dir(tmp_path)
    try:
        with pytest.raises(DataDirBusy):
            _hold_data_dir(tmp_path)
    finally:
        held.close()

    # Released with the handle, so quitting the first engine frees it.
    again = _hold_data_dir(tmp_path)
    again.close()


def test_the_bind_clash_message_does_not_send_you_to_a_shared_data_dir():
    """ "Pass a different --port" was advice that walked the user straight
    into the unprotected case."""
    from pathlib import Path

    from localcut_engine import cli

    source = Path(cli.__file__).read_text(encoding="utf-8")
    assert "quit it, or pass a different --port" not in source
    assert "different --data-dir" in source
