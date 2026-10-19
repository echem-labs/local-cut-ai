"""LocalCut's own Ollama: set up from the pinned build, run while the engine
runs, and the script model pulled into it.

Every test serves its archive from a loopback HTTP server and points the
pin at it, so nothing downloads the real 1.4 GB build. The archive's Ollama
is tests/fake_ollama.py, which answers the routes LocalCut asks and keeps
what it pulls the way Ollama does; the engine runs it with the Python
running the tests. Each engine asks for its LLM server on a fresh loopback
port, never 11434, so an Ollama of the machine's own is never touched.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import psutil
import pytest
from conftest import free_port, pin_hardware
from test_programs import TOKEN, _Archives, _program_events, _row, _ws_url

from localcut_engine.api.app import WS_TOKEN_SUBPROTOCOL, EngineServer, create_app
from localcut_engine.config import EngineConfig
from localcut_engine.manifest import downloads as downloads_module
from localcut_engine.programs import (
    SERVER_REASONS,
    SERVER_STATES,
    SETUP_FAILURES,
    SETUP_PHASES,
)
from localcut_engine.programs import manifest as program_manifest
from localcut_engine.programs import server as managed_server
from localcut_engine.programs import setup as program_setup
from localcut_engine.programs.manifest import parse_programs_manifest

_FAKE = Path(__file__).with_name("fake_ollama.py")
_WINDOWS = os.name == "nt"
_BINARY = "ollama.exe" if _WINDOWS else "bin/ollama"
# The model these engines write scripts with. Not in the catalog, so a setup
# adds no estimate for it to the disk it asks for.
_MODEL = "tiny:1b"


@pytest.fixture
def archives(tmp_path):
    root = tmp_path / "served"
    root.mkdir()
    server = _Archives(root)
    yield server
    server.close()


def _members() -> tuple[dict[str, bytes], dict[str, str]]:
    """What the test build's archive holds: the binary, a library, its
    licence, and on POSIX a library's soname as a link to it, the way
    Ollama's Linux build ships them. Plus a file LocalCut does not keep."""
    files = {
        _BINARY: _FAKE.read_bytes(),
        "lib/ollama/LICENSE": b"MIT License",
        "lib/ollama/libggml-base.so.0.26.0": b"\x7fELF not really" * 100,
        "docs/README.md": b"not kept",
    }
    links = {} if _WINDOWS else {"lib/ollama/libggml-base.so.0": "libggml-base.so.0.26.0"}
    return files, links


def _write_archive(path: Path, fmt: str, files: dict[str, bytes], links: dict[str, str]) -> None:
    if fmt == "zip":
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return
    with tarfile.open(path, "w:zst") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(data))
        for name, target in links.items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            archive.addfile(info)


def _pin_ollama(monkeypatch, archives: _Archives) -> dict:
    """Builds the test Ollama archive, serves it, and pins it for this
    machine, the way the real pin is written: a zip on Windows and a
    zstd tarball elsewhere, every kept file by its exact member name."""
    fmt = "zip" if _WINDOWS else "tar.zst"
    name = f"ollama-test.{fmt}"
    files, links = _members()
    archive = archives.root / name
    _write_archive(archive, fmt, files, links)
    kept = [
        {"member": path, "path": path, "size": len(data)}
        for path, data in files.items()
        if not path.startswith("docs/")
    ] + [
        {"member": path, "path": path, "size": 0, "link": target} for path, target in links.items()
    ]
    asset = {
        "platform": program_manifest.platform_key(),
        "url": f"{archives.url}/{name}",
        "size": archive.stat().st_size,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "format": fmt,
        "files": kept,
    }
    document = {
        "schema_version": 1,
        "programs": [{"id": "ollama", "version": "0.40.4", "license": "MIT", "assets": [asset]}],
    }
    pins = parse_programs_manifest(json.dumps(document))
    monkeypatch.setattr(program_manifest, "load_programs_manifest", lambda: pins)
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    # The archive's "binary" is a Python script, started with this Python.
    monkeypatch.setattr(
        program_setup.OllamaInstaller,
        "command",
        lambda self, binary: [sys.executable, str(binary), "serve"],
    )
    monkeypatch.delenv("FAKE_OLLAMA", raising=False)
    return asset


def _behave(monkeypatch, **behaviour) -> None:
    """How every fake Ollama started from now on behaves (fake_ollama.py)."""
    monkeypatch.setenv("FAKE_OLLAMA", json.dumps(behaviour))


def _config(data: Path, port: int, **overrides) -> EngineConfig:
    return EngineConfig(
        **{
            "data_dir": data,
            "token": TOKEN,
            "backend": "llm,mock",
            "llm_url": f"http://127.0.0.1:{port}/v1",
            "comfyui_url": "http://127.0.0.1:9",
            "llm_model": _MODEL,
            **overrides,
        }
    )


@contextlib.contextmanager
def _live(config: EngineConfig, threads: list | None = None):
    """A live engine on loopback, its lifespan run by uvicorn as `localcut
    serve` runs it, with a client. Shut down on the way out, which is what
    stops LocalCut's Ollama. `threads` gets the thread it runs on, for a
    test that stops it another way and waits for it."""
    import uvicorn

    server = EngineServer(
        uvicorn.Config(create_app(config), host="127.0.0.1", port=free_port(), log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    if threads is not None:
        threads.append(thread)
    deadline = time.monotonic() + 20
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "the test engine never came up"
    url = f"http://127.0.0.1:{server.config.port}"
    try:
        with httpx.Client(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}) as http:
            yield url, http
    finally:
        server.should_exit = True
        thread.join(timeout=40)
        assert not thread.is_alive(), "the test engine did not shut down"


def _ollama(http: httpx.Client) -> dict:
    return _row(http.get("/programs").json(), "ollama")


def _wait_for(http: httpx.Client, done, timeout_s: float = 60) -> dict:
    """The Ollama row, once `done(row)` holds."""
    deadline = time.monotonic() + timeout_s
    while True:
        row = _ollama(http)
        if done(row):
            return row
        assert time.monotonic() < deadline, f"gave up waiting; the row is {row}"
        time.sleep(0.1)


def _server_state(row: dict) -> tuple[str, str | None]:
    server = (row.get("managed") or {}).get("server") or {}
    return server.get("state"), server.get("reason")


def _gone(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


def _install_from(root: Path, data: Path) -> Path:
    """Unpack the pinned build from `root` (the served folder) into
    <data>/programs/ollama with its record, the state a finished setup
    leaves. Returns the folder."""
    pins = program_manifest.load_programs_manifest()
    pin = pins.program("ollama")
    asset = pin.assets[0]
    archive = root / asset.url.rsplit("/", 1)[1]
    folder = data / "programs" / "ollama"
    program_setup._unpack_files(archive, asset, folder, lambda done: None, threading.Event())
    program_setup._write_record(folder, pin, asset)
    assert program_setup.is_current(folder, asset)
    return folder


def _start_fake(port: int, models: Path, **behaviour) -> subprocess.Popen:
    """A fake Ollama started by hand: the user's own, or an orphan."""
    environment = {
        **os.environ,
        "OLLAMA_HOST": f"127.0.0.1:{port}",
        "OLLAMA_MODELS": str(models),
        "FAKE_OLLAMA": json.dumps(behaviour),
    }
    process = subprocess.Popen(
        [sys.executable, str(_FAKE), "serve"],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/api/version", timeout=1).status_code == 200:
                return process
        except httpx.HTTPError:
            pass
        time.sleep(0.05)
    process.kill()
    raise AssertionError("the fake Ollama did not come up")


# -- the pins --------------------------------------------------------------------


def test_the_packaged_ollama_pins_are_exact_release_assets():
    """What the setup screen prints is read off these entries: the release
    asset's own size and the SHA-256 GitHub publishes for it, and every file
    kept from it with its size. Both builds keep the binary where it is
    started from and the whole lib/ollama tree it loads, licences included,
    and every link points at a file kept beside it."""
    pin = program_manifest.load_programs_manifest().program("ollama")
    assert pin is not None
    assert pin.license == "MIT"
    assert {asset.platform for asset in pin.assets} == {"windows-x64", "linux-x64"}
    for asset in pin.assets:
        windows = asset.platform == "windows-x64"
        name = "ollama-windows-amd64.zip" if windows else "ollama-linux-amd64.tar.zst"
        assert asset.url == (
            f"https://github.com/ollama/ollama/releases/download/v{pin.version}/{name}"
        )
        assert asset.format == ("zip" if windows else "tar.zst")
        assert asset.gpu is None, "AMD cards run on the base build, through Vulkan"
        paths = {kept.path for kept in asset.files}
        assert ("ollama.exe" if windows else "bin/ollama") in paths
        assert all(kept.member == kept.path for kept in asset.files)
        assert all(
            path in ("ollama.exe", "bin/ollama") or path.startswith("lib/ollama/") for path in paths
        )
        assert "lib/ollama/GO_LICENSE" in paths
        assert any(path.startswith("lib/ollama/vulkan/") for path in paths)
        assert asset.install_bytes == sum(kept.size for kept in asset.files if kept.link is None)
        assert program_setup.INSTALLERS["ollama"].fits(asset)


@pytest.mark.parametrize(
    ("fmt", "link", "target"),
    [("zip", "lib/ollama/a.so", "a.so.1"), ("tar.zst", "lib/ollama/a.so", "b.so.1")]
    + [("tar.zst", "lib/ollama/a.so", "../../etc/passwd")],
)
def test_a_link_only_points_at_a_file_kept_beside_it(fmt, link, target):
    """A link is made from the pin, and only to a kept file in the same
    folder: never out of the program's folder, and never from a zip, which
    keeps none."""
    document = {
        "schema_version": 1,
        "programs": [
            {
                "id": "ollama",
                "version": "1",
                "assets": [
                    {
                        "platform": "linux-x64",
                        "url": "https://example.com/a",
                        "size": 1,
                        "sha256": "0" * 64,
                        "format": fmt,
                        "files": [
                            {"member": "bin/ollama", "path": "bin/ollama", "size": 1},
                            {"member": "lib/ollama/a.so.1", "path": "lib/ollama/a.so.1", "size": 1},
                            {"member": link, "path": link, "size": 0, "link": target},
                        ],
                    }
                ],
            }
        ],
    }
    with pytest.raises(ValueError):
        parse_programs_manifest(json.dumps(document))


# -- setting it up -----------------------------------------------------------------


def test_setup_runs_ollama_and_pulls_the_script_model(tmp_path, monkeypatch, archives):
    """The whole promise. Before it, scripts would go to the stand-in and
    the readiness report offers the setup as the fix. The setup streams
    every phase over /ws: the five of a program's files, then starting
    LocalCut's copy and pulling the script model into it. Then the copy is
    the server scripts are written with, the script stage is ready, and
    shutting the engine down stops it. A second engine on the same data
    starts the copy by itself. Quitting the way the desktop does, with POST
    /shutdown, stops the copy within the time the desktop gives the engine."""
    from websockets.sync.client import connect

    asset = _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    config = _config(data, free_port())
    threads: list = []

    with _live(config, threads) as (url, http):
        before = _ollama(http)
        assert (before["state"], before["problem"]) == ("missing", "unreachable")
        assert before["setup"]["available"] and before["setup"]["takes_effect"]
        assert before["setup"]["pull"] == {"model": _MODEL, "bytes": None}
        script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
        assert (script["verdict"], script["reason"]) == ("placeholder", "llm_server_down")
        assert script["fix"] == {
            "type": "setup_program",
            "program": "ollama",
            "size_bytes": asset["size"],
        }

        with connect(_ws_url(url), subprotocols=[WS_TOKEN_SUBPROTOCOL, TOKEN]) as ws:
            assert http.post("/programs/ollama/setup").json()["status"] == "started"
            events = _program_events(ws, "ollama")

        phases = [event["phase"] for event in events if event["type"] == "program.setup.progress"]
        assert [phase for i, phase in enumerate(phases) if phases.index(phase) == i] == list(
            SETUP_PHASES
        ), "every phase, in order"
        pulled = [
            event
            for event in events
            if event["type"] == "program.setup.progress" and event["phase"] == "pulling"
        ]
        assert any(event["total"] == 3000 for event in pulled)
        assert all(0 <= event["done"] <= event["total"] for event in pulled)
        # The pull is most of what a setup downloads, so it has a speed like
        # the archive's: the desktop prices the time left from it.
        assert any(event["bytes_per_s"] for event in pulled), pulled
        done = events[-1]
        assert done["type"] == "program.setup.done", done
        assert (done["version"], done["model"], done["in_use"]) == ("0.40.4", _MODEL, True)

        row = _ollama(http)
        assert (row["state"], row["source"], row["version"]) == ("ready", "managed", "0.40.4")
        assert row["checks"]["model_present"] is True
        assert row["setup"]["pull"] is None
        assert row["managed"]["in_use"] is True
        assert _server_state(row) == ("running", None)
        pid = row["managed"]["server"]["pid"]
        assert pid and not _gone(pid)

        folder = data / "programs" / "ollama"
        assert (folder / _BINARY).is_file()
        assert not (folder / "docs").exists(), "only the pinned files are kept"
        if not _WINDOWS:
            assert os.readlink(folder / "lib/ollama/libggml-base.so.0") == "libggml-base.so.0.26.0"
        # The models live with the other weights, not in the program.
        store = data / "models" / "ollama"
        assert (store / "manifests/registry.ollama.ai/library/tiny/1b").is_file()
        assert "Listening on" in (data / "logs" / "ollama.log").read_text()
        assert "Listening on" in http.get("/programs/ollama/log").text
        assert (data / "run" / "ollama.json").is_file()

        script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
        assert (script["verdict"], script["backend"], script["model"]) == ("ready", "llm", _MODEL)
        assert http.post("/programs/ollama/setup").json() == {"status": "installed"}

        # A normal quit: the desktop asks the engine to stop, and kills it
        # STOP_GRACE_MS later. The lifespan's exit stops LocalCut's copy
        # well inside that, with nothing left to kill.
        asked = time.monotonic()
        assert http.post("/shutdown").status_code == 202
        threads[0].join(timeout=10)
        assert not threads[0].is_alive(), "the engine did not stop within the desktop's grace"
        took = time.monotonic() - asked

    assert _gone(pid), "the engine's shutdown stops LocalCut's Ollama"
    assert took < 10
    assert not (data / "run" / "ollama.json").exists()

    with _live(config) as (_, http):
        row = _wait_for(http, lambda row: _server_state(row)[0] == "running", timeout_s=90)
        assert (row["state"], row["source"]) == ("ready", "managed")
        again = row["managed"]["server"]["pid"]
    assert _gone(again)


def test_the_script_rows_setup_fix_counts_the_model_the_setup_pulls(
    tmp_path, monkeypatch, archives
):
    """The render gate and the board's banner show the readiness fix's size
    on their Set up Ollama button, and the Programs screens show the
    setup's: the archive plus the script model it pulls. For `qwen3:8b`
    that is 1.3 GiB against 6.3, so the two have to be the same figure."""
    asset = _pin_ollama(monkeypatch, archives)
    config = _config(tmp_path / "engine", free_port(), llm_model="qwen3:8b")
    with _live(config) as (_, http):
        setup = _ollama(http)["setup"]
        assert setup["pull"]["model"] == "qwen3:8b"
        assert setup["pull"]["bytes"], "the catalog sizes the model"
        script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
        assert script["reason"] == "llm_server_down"
        assert script["fix"]["type"] == "setup_program"
        assert script["fix"]["size_bytes"] == setup["download_bytes"] + setup["pull"]["bytes"]
        assert script["fix"]["size_bytes"] > asset["size"]


def test_every_ollama_localcut_starts_has_its_cloud_features_off(tmp_path, monkeypatch, archives):
    """With its cloud features on, Ollama calls ollama.com by itself: for
    model recommendations as it starts and every few hours after. As it
    starts it also asks for the list of its cloud models. LocalCut tells
    people nothing leaves their machine, so both the setup's check and the
    copy it runs start with them off, even under an environment that turns
    them on for an Ollama of the user's own. The pull the setup asks for is
    its one call out."""
    _pin_ollama(monkeypatch, archives)
    monkeypatch.setenv("OLLAMA_NO_CLOUD", "0")
    starts = tmp_path / "starts.jsonl"
    _behave(monkeypatch, env_to=str(starts))
    data = tmp_path / "engine"
    with _live(_config(data, free_port())) as (_, http):
        assert http.post("/programs/ollama/setup").json()["status"] == "started"
        row = _wait_for(http, lambda row: (row["setup"]["last"] or {}).get("outcome"))
        assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]

    settings = [json.loads(line) for line in starts.read_text().splitlines()]
    store = str((data / "models" / "ollama").resolve())
    assert [run["OLLAMA_MODELS"] == store for run in settings] == [False, True], (
        "the check on a scratch store, then the copy on LocalCut's"
    )
    assert [run.get("OLLAMA_NO_CLOUD") for run in settings] == ["1", "1"]


def test_a_server_of_the_users_own_is_used_and_left_alone(tmp_path, monkeypatch, archives):
    """LocalCut's copy is set up, and the user's own Ollama answers at the
    address when the engine starts: LocalCut uses theirs, never starts its
    own, and a setup leaves theirs alone too."""
    _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    port = free_port()
    theirs = _start_fake(port, tmp_path / "their-models")
    try:
        with _live(_config(data, port)) as (_, http):
            row = _wait_for(http, lambda row: _server_state(row)[0] != "starting")
            assert _server_state(row) == ("stopped", "own_server")
            assert (row["state"], row["source"]) == ("ready", "configured")
            assert row["managed"]["in_use"] is False
            assert http.post("/programs/ollama/setup").json() == {"status": "installed"}
            assert not (data / "logs" / "ollama.log").exists(), "LocalCut's copy never ran"
        assert theirs.poll() is None, "the engine's shutdown leaves the user's Ollama running"
    finally:
        theirs.kill()
        theirs.wait()


def test_an_address_something_else_holds_is_reported_not_fought(tmp_path, monkeypatch, archives):
    """Something that is not Ollama answers at the address: LocalCut's copy
    is not started there, and the report says why."""

    class NotOllama(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    other = ThreadingHTTPServer(("127.0.0.1", 0), NotOllama)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    try:
        with _live(_config(data, other.server_address[1])) as (_, http):
            row = _wait_for(http, lambda row: _server_state(row)[0] not in (None, "starting"))
            assert _server_state(row) == ("crashed", "port_in_use")
            assert row["managed"]["server"]["pid"] is None
            assert (row["state"], row["problem"]) == ("broken", "unexpected_response")
            assert not (data / "logs" / "ollama.log").exists()
    finally:
        other.shutdown()
        other.server_close()


def test_an_orphan_of_localcuts_copy_is_stopped_not_taken_for_the_users(
    tmp_path, monkeypatch, archives
):
    """An engine that died without stopping its Ollama leaves it running,
    and its run file says which process it is. The next engine stops that
    one and starts its own, rather than reading it as the user's install."""
    _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    port = free_port()
    orphan = _start_fake(port, data / "models" / "ollama")
    # Written the way the engine writes it: the binary as the system names
    # the running process, which for a Python script is the interpreter.
    planted = psutil.Process(orphan.pid)
    (data / "run").mkdir(parents=True)
    (data / "run" / "ollama.json").write_text(
        json.dumps(
            {
                "format": 1,
                "pid": orphan.pid,
                "create_time": planted.create_time(),
                "binary": planted.exe(),
            }
        )
    )
    try:
        with _live(_config(data, port)) as (_, http):
            row = _wait_for(http, lambda row: _server_state(row)[0] not in (None, "starting"))
            assert _server_state(row) == ("running", None)
            assert row["source"] == "managed"
            assert row["managed"]["server"]["pid"] != orphan.pid
            assert orphan.wait(timeout=20) is not None, "the orphan was stopped"
    finally:
        if orphan.poll() is None:
            orphan.kill()


# `localcut serve` itself, its Ollama the fake planted where a setup puts the
# binary and run with this Python.
_ENGINE_WITH_THE_FAKE = """
import sys

from localcut_engine.cli import main
from localcut_engine.programs.setup import OllamaInstaller

OllamaInstaller.command = lambda self, binary: [sys.executable, str(binary), "serve"]
sys.exit(main(sys.argv[1:]))
"""


def test_a_killed_engine_leaves_its_port_to_the_next_one(tmp_path):
    """An engine killed outright (SIGKILL, TerminateProcess) leaves its Ollama
    running, for the next engine to stop once it has bound its own port. So
    the copy must hold nothing of the engine's socket: one that does keeps
    the port in LISTEN with the engine gone. The next engine then exits on
    the bind with the copy still running."""
    data = tmp_path / "engine"
    binary = data / "programs" / "ollama" / _BINARY
    binary.parent.mkdir(parents=True)
    shutil.copyfile(_FAKE, binary)
    port = free_port()
    # Nothing from the developer's own shell. The LLM address is one of its
    # own, never 11434, where the machine's own Ollama may be.
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("LOCALCUT_", "FAKE_OLLAMA"))
    }
    environment.update(
        LOCALCUT_TOKEN=TOKEN,
        LOCALCUT_LLM_URL=f"http://127.0.0.1:{free_port()}/v1",
        LOCALCUT_COMFYUI_URL="http://127.0.0.1:9",
    )
    command = [sys.executable, "-c", _ENGINE_WITH_THE_FAKE, "serve", "--port", str(port)]
    command += ["--data-dir", str(data), "--backend", "mock"]
    engines: list[subprocess.Popen] = []

    def start(log: Path) -> subprocess.Popen:
        with log.open("wb") as out:
            engine = subprocess.Popen(
                command, env=environment, stdout=out, stderr=subprocess.STDOUT
            )
        engines.append(engine)
        return engine

    def polled(engine: subprocess.Popen, log: Path, ask, what: str):
        """What `ask(http)` returns once it is anything but None. The client
        closes its connection first, so the engine's end of it never waits in
        TIME_WAIT on the port the next engine binds."""
        deadline = time.monotonic() + 90
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", headers={"Authorization": f"Bearer {TOKEN}"}
        ) as http:
            while time.monotonic() < deadline:
                assert engine.poll() is None, f"the engine exited:\n{log.read_text()}"
                with contextlib.suppress(httpx.HTTPError):
                    found = ask(http)
                    if found is not None:
                        return found
                time.sleep(0.1)
        raise AssertionError(f"gave up waiting for {what}:\n{log.read_text()}")

    def running_copy(http: httpx.Client) -> int | None:
        server = (_ollama(http).get("managed") or {}).get("server") or {}
        return server["pid"] if server.get("state") == "running" else None

    def answers(http: httpx.Client) -> bool | None:
        return True if http.get("/health").status_code == 200 else None

    try:
        first = start(tmp_path / "first.log")
        orphan = polled(first, tmp_path / "first.log", running_copy, "its Ollama to run")
        first.kill()
        first.wait(timeout=30)
        assert not _gone(orphan), "the killed engine's Ollama is left running"

        second = start(tmp_path / "second.log")
        assert polled(second, tmp_path / "second.log", answers, "the next engine to answer")
    finally:
        for engine in engines:
            if engine.poll() is None:
                engine.kill()
            engine.wait(timeout=30)
        # Every copy started from the planted binary: the orphan and any copy
        # the next engine started in its place.
        planted = {str(binary), str(binary.resolve())}
        for process in psutil.process_iter(["cmdline"]):
            with contextlib.suppress(psutil.Error):
                if planted & set(process.info["cmdline"] or []):
                    process.kill()


def test_a_copy_that_keeps_stopping_is_restarted_then_left_crashed(tmp_path, monkeypatch, archives):
    """A copy that stops by itself is started again, a few times. After
    that it is reported crashed with the reason and what it printed last,
    and a start through the API gives it its restarts back."""
    _pin_ollama(monkeypatch, archives)
    monkeypatch.setattr(managed_server, "_RESTART_PAUSE_S", 0.01)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    _behave(monkeypatch, exit=3, exit_after=0.3)
    with _live(_config(data, free_port())) as (_, http):
        row = _wait_for(http, lambda row: _server_state(row)[0] == "crashed", timeout_s=90)
        server = row["managed"]["server"]
        assert (server["reason"], server["restarts"]) == ("exited", 3)
        assert "something went wrong" in server["error"]
        assert server["state"] in SERVER_STATES and server["reason"] in SERVER_REASONS
        assert (data / "logs" / "ollama.log").read_text().count("Listening on") == 4

        monkeypatch.delenv("FAKE_OLLAMA")
        started = http.post("/programs/ollama/start", timeout=90).json()
        assert (started["state"], started["restarts"]) == ("running", 0)


def test_stop_and_start_through_the_api(tmp_path, monkeypatch, archives):
    """Settings stops and starts LocalCut's copy; a stopped copy stays
    stopped, and is not restarted behind the user's back."""
    _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    with _live(_config(data, free_port())) as (_, http):
        row = _wait_for(http, lambda row: _server_state(row)[0] == "running")
        pid = row["managed"]["server"]["pid"]
        stopped = http.post("/programs/ollama/stop", timeout=30).json()
        assert (stopped["state"], stopped["reason"], stopped["pid"]) == ("stopped", "stopped", None)
        assert _gone(pid)
        time.sleep(0.5)
        row = _ollama(http)
        assert (row["state"], row["source"]) == ("missing", "configured")
        assert _server_state(row) == ("stopped", "stopped")

        started = http.post("/programs/ollama/start", timeout=90).json()
        assert started["state"] == "running"
        assert http.post("/programs/ffmpeg/start").status_code == 409
        assert http.post("/programs/nonesuch/stop").status_code == 404


def test_remove_stops_the_copy_and_keeps_its_models(tmp_path, monkeypatch, archives):
    """Removing LocalCut's Ollama stops it first (a running copy holds its
    files open), and leaves the models it pulled: they are weights like any
    other, in the models folder, and a reinstall would fetch them again."""
    _pin_ollama(monkeypatch, archives)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    with _live(_config(data, free_port())) as (_, http):
        row = _wait_for(http, lambda row: _server_state(row)[0] == "running")
        pid = row["managed"]["server"]["pid"]
        assert http.post("/programs/ollama/pull").json()["status"] == "started"
        _wait_for(http, lambda row: row["setup"]["last"] is not None)
        removed = http.delete("/programs/ollama", timeout=30)
        assert removed.status_code == 200 and removed.json()["freed_bytes"] > 0
        assert _gone(pid)
        assert not (data / "programs" / "ollama").exists()
        assert (data / "models/ollama/manifests/registry.ollama.ai/library/tiny/1b").is_file()
        assert _ollama(http)["managed"] is None


# -- the GPU it looks for ------------------------------------------------------------


@pytest.mark.parametrize(
    ("vendor", "driver", "compute", "runs"),
    [
        ("nvidia", "595.99.02", "8.6", True),
        ("nvidia", "581.57", "8.6", True),
        ("nvidia", "550.54.14", "7.5", True),
        ("nvidia", "550.54.14", "6.1", False),
        ("nvidia", "570.86.10", "6.1", True),
        ("nvidia", "570.86.10", "5.0", True),
        ("nvidia", "570.86.10", "3.7", False),
        ("nvidia", "545.29.06", "8.9", False),
        ("nvidia", None, "8.6", False),
        ("nvidia", "595.99.02", None, False),
        ("nvidia", "[N/A]", "garbage", False),
        ("amd", None, None, False),
        ("intel", None, None, False),
    ],
)
def test_cuda_is_counted_on_only_for_a_card_ollamas_cuda_libraries_run(
    vendor, driver, compute, runs
):
    """Ollama 0.40.4 ships CUDA 12.8 and CUDA 13 libraries. Its own check
    drops every CUDA device under a driver older than 550. Under one older
    than 570 it drops the cards older than compute 7.0 too. CUDA 12.8 is
    built for compute 5.0 and up. A figure the
    probe could not read counts as not met: wrongly counting on CUDA would
    leave the card unused, where wrongly not counting on it costs seconds."""
    from localcut_engine.hardware.probe import GPU
    from localcut_engine.programs import ollama

    backend = {"nvidia": "cuda", "amd": "rocm", "intel": "xpu"}[vendor]
    card = GPU(
        vendor=vendor,
        name="test card",
        vram_gb=8.0,
        backend=backend,
        driver_version=driver,
        compute_capability=compute,
    )
    assert ollama.cuda_runs(card) is runs


@pytest.mark.parametrize(
    ("vendor", "driver", "compute", "vulkan"),
    [
        ("nvidia", "595.99.02", "8.6", "0"),
        ("nvidia", "545.29.06", "8.6", None),
        ("amd", None, None, None),
        ("intel", None, None, None),
    ],
)
def test_the_copy_skips_vulkan_only_where_cuda_runs_the_card(
    tmp_path, monkeypatch, archives, vendor, driver, compute, vulkan
):
    """On a laptop whose NVIDIA card Ollama runs on CUDA, its Vulkan pass at
    every start finds that card again and the Intel graphics beside it, and
    drops both. Where the hardware probe finds an NVIDIA card CUDA runs,
    LocalCut's copy starts with Vulkan off, from the engine's first start
    on, before anything else has asked about the hardware. Everywhere else
    Vulkan is left as Ollama has it, since it is how an AMD or Intel card,
    or an NVIDIA card CUDA does not run, gets the GPU."""
    _pin_ollama(monkeypatch, archives)
    monkeypatch.delenv("OLLAMA_VULKAN", raising=False)
    pin_hardware(monkeypatch, 8.0, vendor=vendor, driver=driver, compute=compute)
    data = tmp_path / "engine"
    _install_from(archives.root, data)
    with _live(_config(data, free_port())) as (_, http):
        row = _wait_for(http, lambda row: _server_state(row)[0] == "running")
        environment = psutil.Process(row["managed"]["server"]["pid"]).environ()
    assert environment.get("OLLAMA_VULKAN") == vulkan


# -- when it goes wrong --------------------------------------------------------------


def test_a_build_that_does_not_answer_is_never_installed(tmp_path, monkeypatch, archives):
    """The unpacked copy has to serve and answer before it replaces
    anything; one that hangs fails the setup with does_not_run, and leaves
    nothing behind."""
    _pin_ollama(monkeypatch, archives)
    monkeypatch.setattr(managed_server, "START_TIMEOUT_S", 2.0)
    _behave(monkeypatch, silent=True)
    data = tmp_path / "engine"
    with _live(_config(data, free_port())) as (_, http):
        http.post("/programs/ollama/setup")
        row = _wait_for(http, lambda row: row["setup"]["last"] is not None)
    last = row["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "does_not_run")
    assert not (data / "programs" / "ollama").exists()
    assert [entry.name for entry in (data / "programs").iterdir()] == []


def test_a_pull_ollama_refuses_fails_the_setup_and_keeps_the_program(
    tmp_path, monkeypatch, archives
):
    """Ollama's own error comes through, and Ollama itself stays set up and
    running: Try again pulls, and nothing downloads twice."""
    _pin_ollama(monkeypatch, archives)
    _behave(monkeypatch, pull_error="pull model manifest: file does not exist")
    data = tmp_path / "engine"
    with _live(_config(data, free_port())) as (_, http):
        http.post("/programs/ollama/setup")
        row = _wait_for(http, lambda row: row["setup"]["last"] is not None, timeout_s=90)
        last = row["setup"]["last"]
        assert (last["outcome"], last["reason"]) == ("failed", "pull_failed")
        assert "file does not exist" in last["error"]
        assert last["reason"] in SETUP_FAILURES
        assert (row["state"], row["source"]) == ("ready", "managed")
        assert row["checks"]["model_present"] is False
        # The gate and the board say what the Programs well says: the copy
        # runs and the model is the thing to get, not a server that is down.
        script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
        assert (script["reason"], script["fix"]["type"]) == ("llm_model_missing", "pull_model")
        picker = http.get("/llm/models")
        assert picker.status_code == 200
        assert picker.json()["models"] == []
        served = len(archives.requests)

        # The copy restarts with the error gone, the way a fixed link would
        # let it pull; Try again is the same setup route.
        monkeypatch.delenv("FAKE_OLLAMA")
        http.post("/programs/ollama/stop", timeout=30)
        assert http.post("/programs/ollama/setup").json()["status"] == "started"
        row = _wait_for(http, lambda row: row["setup"]["job"] is None, timeout_s=90)
        assert row["setup"]["last"]["outcome"] == "done"
        assert row["checks"]["model_present"] is True
        assert len(archives.requests) == served, "the program was not downloaded again"


def test_a_model_that_would_fill_the_disk_is_not_pulled(tmp_path, monkeypatch, archives):
    """LocalCut's copy keeps its models where the engine can measure, so
    each layer Ollama names is held against the free space there, and the
    pull stops before the disk fills."""
    _pin_ollama(monkeypatch, archives)
    _behave(monkeypatch, layer=10**15)
    data = tmp_path / "engine"
    with _live(_config(data, free_port())) as (_, http):
        http.post("/programs/ollama/setup")
        row = _wait_for(http, lambda row: row["setup"]["last"] is not None, timeout_s=90)
    last = row["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "no_space")
    assert "tiny:1b" in last["error"]


# -- the pull on its own --------------------------------------------------------------


def test_a_users_ollama_without_the_model_is_offered_the_pull(tmp_path, monkeypatch):
    """The usual gap after installing Ollama by hand: it runs, and lacks the
    model. The readiness row offers the pull, the pull route fetches it
    through the user's own server with progress like a setup's, and then
    the script stage is ready."""
    monkeypatch.delenv("FAKE_OLLAMA", raising=False)
    port = free_port()
    theirs = _start_fake(port, tmp_path / "their-models")
    data = tmp_path / "engine"
    try:
        with _live(_config(data, port)) as (_, http):
            script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
            assert (script["verdict"], script["reason"]) == ("will_fail", "llm_model_missing")
            assert script["fix"] == {
                "type": "pull_model",
                "program": "ollama",
                "model": _MODEL,
                "size_bytes": None,
            }
            started = http.post("/programs/ollama/pull").json()
            assert (started["status"], started["model"]) == ("started", _MODEL)
            row = _wait_for(http, lambda row: row["setup"]["job"] is None)
            assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
            assert row["checks"]["model_present"] is True
            assert row["managed"] is None, "LocalCut set nothing up of its own"
            script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
            assert script["verdict"] == "ready"
            again = http.post("/programs/ollama/pull").json()
            assert again == {"status": "present", "model": _MODEL}
        assert (tmp_path / "their-models/manifests/registry.ollama.ai/library/tiny/1b").is_file()
        assert not (data / "models" / "ollama").exists()
    finally:
        theirs.kill()
        theirs.wait()


def test_the_pull_route_refuses_what_it_cannot_do(tmp_path, monkeypatch):
    port = free_port()
    with _live(_config(tmp_path / "engine", port)) as (_, http):
        assert http.post("/programs/ollama/pull").status_code == 409, "nothing answers"
        assert http.post("/programs/ffmpeg/pull").status_code == 409
        assert http.post("/programs/nonesuch/pull").status_code == 404
        for name in ("qwen3:8b\n", "../x", "a b", ":8b", "x" * 400):
            refused = http.post("/programs/ollama/pull", json={"model": name})
            assert refused.status_code == 422, name


def test_no_setup_is_offered_for_an_address_on_another_machine(tmp_path, monkeypatch, archives):
    """A copy here cannot serve an LLM server on another machine, so the
    setup would change nothing there and is not offered."""
    _pin_ollama(monkeypatch, archives)
    config = _config(tmp_path / "engine", 0, llm_url="http://192.0.2.1:11434/v1")
    with _live(config) as (_, http):
        setup = _ollama(http)["setup"]
        assert (setup["available"], setup["takes_effect"]) == (True, False)
        script = http.get("/readiness", params={"kinds": "script"}).json()["rows"][0]
        assert script["reason"] == "llm_server_down"
        assert script["fix"] is None


def test_the_cli_sets_up_pulls_stops_and_starts_ollama(tmp_path, monkeypatch, archives, capsys):
    """A headless box gets its script model from its own terminal: the
    setup waits through the pull, `pull` fetches another model, and `stop`
    and `start` act on LocalCut's copy alone. Exit 0 when it worked, 1 when
    it did not."""
    from localcut_engine import cli

    _pin_ollama(monkeypatch, archives)
    monkeypatch.setattr(cli, "_SETUP_POLL_S", 0.05)
    with _live(_config(tmp_path / "engine", free_port())) as (url, _):

        def run(*args: str) -> int:
            return cli.main(["programs", *args, "--engine", url, "--token", TOKEN])

        assert run("setup", "ollama") == 0
        assert "ollama is set up" in capsys.readouterr().out
        assert run("list") == 0
        assert "LocalCut's copy: running" in capsys.readouterr().out

        assert run("pull", "ollama", "--model", "other:2b") == 0
        assert "ollama has other:2b" in capsys.readouterr().out
        assert run("pull", "ollama", "--model", "other:2b") == 0
        assert "has other:2b already" in capsys.readouterr().out

        assert run("stop", "ollama") == 0
        assert "LocalCut's ollama: stopped" in capsys.readouterr().out
        assert run("pull", "ollama") == 1, "nothing answers to pull through"
        capsys.readouterr()
        assert run("start", "ollama", "--json") == 0
        assert json.loads(capsys.readouterr().out)["state"] == "running"
        assert run("start", "ffmpeg") == 1
