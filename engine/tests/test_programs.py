"""The programs LocalCut runs, and LocalCut's own copy of FFmpeg.

GET /programs reports FFmpeg, the LLM server and ComfyUI as this engine finds
them, and POST /programs/ffmpeg/setup puts a pinned FFmpeg build into
<data_dir>/programs/ffmpeg while the engine runs. Every test here serves its
archive from a loopback HTTP server and points the pinned entry at it, so
nothing downloads the real 170 MB build. The real pins are checked as data.

Tests that look ffmpeg up by name set PATH to one empty directory, so a
machine with ffmpeg installed system-wide runs them exactly as one without.
"""

from __future__ import annotations

import asyncio
import calendar
import contextlib
import hashlib
import io
import itertools
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import tarfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from conftest import pin_hardware, serve_engine

from localcut_engine import cli
from localcut_engine.api.app import WS_TOKEN_SUBPROTOCOL, create_app
from localcut_engine.automation import outstanding_jobs
from localcut_engine.backends import ffmpeg as ffmpeg_backend
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.config import EngineConfig
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.manifest import downloads as downloads_module
from localcut_engine.programs import (
    PROGRAM_IDS,
    PROGRAM_PROBLEMS,
    PROGRAM_SOURCES,
    PROGRAM_STATES,
    SETUP_FAILURES,
    SETUP_PHASES,
)
from localcut_engine.programs import manifest as program_manifest
from localcut_engine.programs import setup as program_setup
from localcut_engine.programs.manifest import ManifestTooNew, parse_programs_manifest
from localcut_engine.programs.status import version_number

TOKEN = "programs-token"
_EXE = ".exe" if os.name == "nt" else ""
# Looked up at import, before any test narrows PATH.
_REAL_FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")
_REAL_PAIR = (
    _REAL_FFMPEG is not None
    and Path(_REAL_FFMPEG).with_name(f"ffprobe{Path(_REAL_FFMPEG).suffix}").is_file()
)
# The folder every test archive unpacks from, the way BtbN's do.
_TOP = "ffmpeg-n0.0-test-build"
# What a held response sends before it stops, so the setup has bytes on disk
# to report.
_FIRST_CHUNK = 2 << 20
_TERMINAL = ("program.setup.done", "program.setup.failed", "program.setup.cancelled")


def _without_ffmpeg_on_path(tmp_path: Path, monkeypatch) -> None:
    """PATH is one empty directory, so a bare `ffmpeg` finds nothing. Unset
    would not do: `shutil.which` then falls back to the system's default
    path, which is where a distribution's ffmpeg lives."""
    empty = tmp_path / "empty-path"
    empty.mkdir(exist_ok=True)
    monkeypatch.setenv("PATH", str(empty))


def _plant(path: Path, content: bytes) -> Path:
    """A file with the executable bit, which `shutil.which` wants on POSIX."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(0o755)
    return path


class _Archives:
    """Serves the files in one folder over loopback HTTP, and records every
    path it is asked for and the Range each request carried. A Range of
    `bytes=N-` gets a 206 with the rest of the file, the way GitHub's CDN
    answers it.

    While `hold()` is in force each response stops after its first chunk
    until `release()`, so a setup can be caught in the middle of its
    download. Each entry in `drops` ends one response after `drop_after`
    bytes of its body, the way a flaky link ends it: `closed` before the
    body is complete, `reset`, or `stalled` with the connection left open.
    `answer_range` is what a Range gets instead of the rest of the file:
    `ignored` sends the whole file with a 200, `misplaced` a 206 that starts
    somewhere else. `pace` sends the body a piece at a time, as a slow link
    delivers it, and `paced` notes when the request came in, then when each
    piece started out and how much of the body had gone once it had. Each
    entry in `statuses` answers one request with that status and no file,
    before any of the others."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.requests: list[str] = []
        self.ranges: list[str | None] = []
        self.drops: list[str] = []
        self.drop_after = _FIRST_CHUNK
        self.answer_range = "honoured"
        self.pace: tuple[int, float] | None = None
        self.paced: list[tuple[float, int]] = []
        self.statuses: list[int] = []
        self._gate: threading.Event | None = None
        self._closing = threading.Event()
        self._resets: set[socket.socket] = set()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                arrived = time.monotonic()
                outer.requests.append(self.path)
                asked = self.headers.get("Range")
                outer.ranges.append(asked)
                if outer.statuses:
                    self.send_response(outer.statuses.pop(0))
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                path = outer.root / self.path.lstrip("/")
                if not path.is_file():
                    self.send_error(404)
                    return
                size = path.stat().st_size
                start = int(asked.removeprefix("bytes=").split("-")[0]) if asked else 0
                if start and outer.answer_range != "ignored":
                    if outer.answer_range == "misplaced":
                        start //= 2
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
                else:
                    start = 0
                    self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size - start))
                self.end_headers()
                drop = outer.drops.pop(0) if outer.drops else None
                gate = outer._gate
                try:
                    with path.open("rb") as source:
                        source.seek(start)
                        if drop is not None:
                            self.wfile.write(source.read(outer.drop_after))
                            self.wfile.flush()
                            self._drop(drop)
                            return
                        if gate is not None:
                            self.wfile.write(source.read(_FIRST_CHUNK))
                            self.wfile.flush()
                            gate.wait(timeout=60)
                        if outer.pace is None:
                            shutil.copyfileobj(source, self.wfile)
                            return
                        piece, every = outer.pace
                        outer.paced.append((arrived, 0))
                        while chunk := source.read(piece):
                            outer.paced.append((time.monotonic(), outer.paced[-1][1] + len(chunk)))
                            self.wfile.write(chunk)
                            self.wfile.flush()
                            time.sleep(every)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def _drop(self, how: str) -> None:
                self.close_connection = True
                if how == "stalled":
                    # Nothing more, with the connection open: only the
                    # client's read timeout ends this one.
                    outer._closing.wait(timeout=30)
                elif how == "reset":
                    # A reset throws away whatever the client has not read
                    # yet, so it gets a moment to read what was sent. Then
                    # closing with a zero linger sends the reset, not a FIN.
                    time.sleep(0.3)
                    self.connection.setsockopt(
                        socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
                    )
                    outer._resets.add(self.connection)

            def log_message(self, *args) -> None:
                pass

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def shutdown_request(self, request) -> None:
                if request in outer._resets:
                    # Straight to the close: the shutdown the stdlib does
                    # first would send a FIN ahead of the reset.
                    outer._resets.discard(request)
                    self.close_request(request)
                    return
                super().shutdown_request(request)

        self.httpd = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def hold(self) -> None:
        self._gate = threading.Event()

    def release(self) -> None:
        if self._gate is not None:
            self._gate.set()

    def close(self) -> None:
        self.release()
        self._closing.set()
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def archives(tmp_path):
    root = tmp_path / "served"
    root.mkdir()
    server = _Archives(root)
    yield server
    server.close()


def _write_archive(path: Path, fmt: str, members: dict[str, bytes | Path]) -> None:
    """A zip (stored, so a real binary goes in fast) or a tar.xz."""
    if fmt == "zip":
        with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
            for name, content in members.items():
                if isinstance(content, Path):
                    archive.write(content, name)
                else:
                    archive.writestr(name, content)
        return
    with tarfile.open(path, "w:xz", preset=0) as archive:
        for name, content in members.items():
            data = content.read_bytes() if isinstance(content, Path) else content
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))


def _size_of(content: bytes | Path) -> int:
    return content.stat().st_size if isinstance(content, Path) else len(content)


def _ffmpeg_members(ffmpeg: bytes | Path, ffprobe: bytes | Path) -> dict[str, bytes | Path]:
    """What a build's archive holds: the two binaries LocalCut keeps, and
    things it does not."""
    return {
        f"{_TOP}/LICENSE.txt": b"GNU LESSER GENERAL PUBLIC LICENSE",
        f"{_TOP}/doc/ffmpeg.html": b"<html></html>",
        f"{_TOP}/bin/ffplay{_EXE}": b"not kept",
        f"{_TOP}/bin/ffprobe{_EXE}": ffprobe,
        f"{_TOP}/bin/ffmpeg{_EXE}": ffmpeg,
    }


def _same_file(reported: str, planted: Path) -> bool:
    """A location found on PATH, compared as a file: Windows reports the
    extension in PATHEXT's case."""
    return os.path.samefile(reported, planted)


def _pin(
    monkeypatch,
    archives: _Archives,
    *,
    fmt: str = "zip",
    ffmpeg: bytes | Path = b"stub ffmpeg",
    ffprobe: bytes | Path = b"stub ffprobe",
    name: str | None = None,
    extra: dict[str, bytes] | None = None,
) -> dict:
    """Builds an FFmpeg archive, serves it, and makes it the pinned build for
    this machine. Returns the asset as pinned."""
    name = name or f"ffmpeg-test.{fmt}"
    archive = archives.root / name
    _write_archive(archive, fmt, {**_ffmpeg_members(ffmpeg, ffprobe), **(extra or {})})
    asset = {
        "platform": program_manifest.platform_key(),
        "url": f"{archives.url}/{name}",
        "size": archive.stat().st_size,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "format": fmt,
        "files": [
            {
                "member": f"{_TOP}/bin/ffprobe{_EXE}",
                "path": f"ffprobe{_EXE}",
                "size": _size_of(ffprobe),
            },
            {
                "member": f"{_TOP}/bin/ffmpeg{_EXE}",
                "path": f"ffmpeg{_EXE}",
                "size": _size_of(ffmpeg),
            },
        ],
    }
    document = {
        "schema_version": 1,
        "programs": [
            {"id": "ffmpeg", "version": "8.1.3", "license": "LGPL-3.0-or-later", "assets": [asset]}
        ],
    }
    pins = parse_programs_manifest(json.dumps(document))
    monkeypatch.setattr(program_manifest, "load_programs_manifest", lambda: pins)
    # The loopback server is exactly what the download guard refuses; these
    # tests are about the setup, not that policy (test_downloads.py has it).
    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
    return asset


def _stub_check(monkeypatch, *, draws_text: bool = True) -> list[Path]:
    """Stands in for running the staged binaries, which a stub cannot do.
    Records the folders it was asked about."""
    checked: list[Path] = []

    async def check(self, folder: Path, asset=None) -> dict:  # noqa: ANN001 - a pin
        checked.append(folder)
        assert (folder / f"ffmpeg{_EXE}").is_file()
        assert (folder / f"ffprobe{_EXE}").is_file()
        return {"version": "8.1.3", "draws_text": draws_text}

    monkeypatch.setattr(program_setup.FFmpegInstaller, "check", check)
    return checked


def _stub_probes(monkeypatch) -> None:
    """The report runs `ffmpeg -version` and the text probe, which a stub
    cannot answer either. A binary whose bytes say `draws` draws text; one
    that says `broken` does not run. A bare name is found on PATH, the way
    spawning it would find it."""

    def located(binary: str) -> Path | None:
        found = binary if os.path.dirname(binary) else shutil.which(binary)
        if found is None or not Path(found).is_file():
            return None
        return None if Path(found).read_bytes().startswith(b"broken") else Path(found)

    async def version(binary: str) -> str | None:
        return "n8.1.3-9-g29e619e767-20260930" if located(binary) else None

    async def lit_pixels(self, vf: str) -> int | None:
        binary = located(self.ffmpeg_bin)
        if binary is None:
            return None
        return 500 if b"draws" in binary.read_bytes() else 0

    monkeypatch.setattr(ffmpeg_backend, "probe_version", version)
    monkeypatch.setattr(FFmpegBackend, "_lit_pixels", lit_pixels)


@contextlib.asynccontextmanager
async def _engine(config: EngineConfig):
    app = create_app(config)
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://engine",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as http,
    ):
        async with app.router.lifespan_context(app):
            yield http


def _config(data_dir: Path, **overrides) -> EngineConfig:
    """An engine whose LLM server and ComfyUI are at closed ports, so their
    probes are refused at once."""
    return EngineConfig(
        **{
            "data_dir": data_dir,
            "token": TOKEN,
            "backend": "ffmpeg,mock",
            "llm_url": "http://127.0.0.1:9/v1",
            "comfyui_url": "http://127.0.0.1:9",
            **overrides,
        }
    )


def _row(report: dict, program: str) -> dict:
    return next(row for row in report["programs"] if row["id"] == program)


async def _settled(http: httpx.AsyncClient, program: str = "ffmpeg") -> dict:
    """The program's row once no setup of it is running."""
    async with asyncio.timeout(120):
        while True:
            row = _row((await http.get("/programs")).json(), program)
            if row["setup"]["job"] is None:
                return row
            await asyncio.sleep(0.05)


async def _downloading(http: httpx.AsyncClient) -> dict:
    """The job, once its download has bytes on disk."""
    async with asyncio.timeout(60):
        while True:
            job = _row((await http.get("/programs")).json(), "ffmpeg")["setup"]["job"]
            if job is not None and job["phase"] == "downloading" and job["done"] > 0:
                return job
            await asyncio.sleep(0.05)


def _leftovers(data_dir: Path) -> list[str]:
    """Anything a setup puts beside the program folders while it works."""
    root = data_dir / "programs"
    return (
        sorted(entry.name for entry in root.iterdir() if entry.name.startswith("."))
        if root.is_dir()
        else []
    )


# -- the pins ------------------------------------------------------------------


def test_the_packaged_pins_are_exact_month_end_builds():
    """What the setup screen prints is read straight off these entries, so
    every number has to be the release's own: the asset size and the SHA-256
    GitHub publishes in its `digest` field, and the sizes of the two files
    LocalCut keeps. BtbN deletes every build but the 14 newest and the last
    one of each month, so only a month-end build stays downloadable."""
    pins = program_manifest.load_programs_manifest()
    ffmpeg = pins.program("ffmpeg")
    assert ffmpeg is not None
    platforms = {asset.platform for asset in ffmpeg.assets}
    assert platforms == {"windows-x64", "linux-x64"}

    release = re.compile(
        r"https://github\.com/BtbN/FFmpeg-Builds/releases/download/"
        r"autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}/[^/]+$"
    )
    for asset in ffmpeg.assets:
        tag = release.match(asset.url)
        assert tag, f"{asset.url} is not a BtbN autobuild asset"
        year, month, day = (int(part) for part in tag.groups())
        assert day == calendar.monthrange(year, month)[1], f"{asset.url} is not a month-end build"
        assert re.fullmatch(r"[0-9a-f]{64}", asset.sha256)
        assert asset.size > 0
        exe = ".exe" if asset.platform.startswith("windows") else ""
        assert sorted(kept.path for kept in asset.files) == [f"ffmpeg{exe}", f"ffprobe{exe}"]
        assert all(kept.member.endswith(f"/bin/{kept.path}") for kept in asset.files)
        assert asset.install_bytes == sum(kept.size for kept in asset.files)
        assert asset.format == ("zip" if asset.platform.startswith("windows") else "tar.xz")


def test_a_manifest_from_a_newer_engine_is_refused():
    """Refused, never read as far as this engine understands it: fields it
    does not know about would be dropped without a trace."""
    with pytest.raises(ManifestTooNew):
        parse_programs_manifest(json.dumps({"schema_version": 99, "programs": []}))


@pytest.mark.parametrize(
    "path",
    ["../ffmpeg", "bin/../../ffmpeg", "/bin/ffmpeg", "bin//ffmpeg", "./ffmpeg", "bin/", "..", ""]
    + ["C:ffmpeg", "a\\b", "lib/ollama/a:b"],
)
def test_a_kept_file_lands_inside_its_program_folder(path):
    """Members are taken by exact name, and each is written under a path the
    pin gives it: plain names joined by "/", never absolute, never "..", and
    nothing a drive or an alternate data stream could be read out of. Any
    other path and the pin is refused."""
    document = {
        "schema_version": 1,
        "programs": [
            {
                "id": "ffmpeg",
                "version": "1",
                "assets": [
                    {
                        "platform": "linux-x64",
                        "url": "https://example.com/a.zip",
                        "size": 1,
                        "sha256": "0" * 64,
                        "format": "zip",
                        "files": [{"member": "x/bin/ffmpeg", "path": path, "size": 1}],
                    }
                ],
            }
        ],
    }
    with pytest.raises(ValueError):
        parse_programs_manifest(json.dumps(document))


@pytest.mark.parametrize(
    ("system", "machine", "key"),
    [
        ("Windows", "AMD64", "windows-x64"),
        ("Windows", "ARM64", "windows-arm64"),
        ("Linux", "x86_64", "linux-x64"),
        ("Linux", "aarch64", "linux-arm64"),
        ("Darwin", "arm64", "macos-arm64"),
        ("Darwin", "x86_64", "macos-x64"),
        ("Linux", "riscv64", None),
    ],
)
def test_the_platform_key_names_the_os_and_arch(monkeypatch, system, machine, key):
    monkeypatch.setattr(platform, "system", lambda: system)
    monkeypatch.setattr(platform, "machine", lambda: machine)
    assert program_manifest.platform_key() == key


@pytest.mark.parametrize(
    ("reported", "number"),
    [
        ("n8.1.3-9-g29e619e767-20260930", "8.1.3"),
        ("8.0.1-3ubuntu2", "8.0.1"),
        ("7.1-full_build-www.gyan.dev", "7.1"),
        ("N-125628-ga5e6c0175a-20260715", "N-125628-ga5e6c0175a-20260715"),
    ],
)
def test_a_version_is_reported_as_its_release_number_when_it_has_one(reported, number):
    assert version_number(reported) == number


# -- where the engine finds ffmpeg ---------------------------------------------


def test_the_engine_runs_the_first_ffmpeg_it_finds_in_this_order(tmp_path, monkeypatch):
    """A configured path, then a binary put in <data_dir>/bin by hand, then
    LocalCut's own copy, then PATH. LocalCut's copy outranks PATH because it
    exists only when someone asked LocalCut for it."""
    on_path = _plant(tmp_path / "path-dir" / f"ffmpeg{_EXE}", b"on path")
    _plant(on_path.with_name(f"ffprobe{_EXE}"), b"on path")
    monkeypatch.setenv("PATH", str(on_path.parent))
    config = EngineConfig(data_dir=tmp_path / "data")

    assert config.ffmpeg_lookup == ("path", "ffmpeg")
    assert config.resolved_ffmpeg_bin == "ffmpeg"

    managed = _plant(tmp_path / "data" / "programs" / "ffmpeg" / f"ffmpeg{_EXE}", b"managed")
    assert config.ffmpeg_lookup == ("managed", str(managed))

    by_hand = _plant(tmp_path / "data" / "bin" / f"ffmpeg{_EXE}", b"by hand")
    assert config.ffmpeg_lookup == ("data_dir", str(by_hand))
    assert config.resolved_ffmpeg_bin == str(by_hand)

    configured = config.model_copy(update={"ffmpeg_bin": str(tmp_path / "elsewhere" / "ffmpeg")})
    assert configured.ffmpeg_lookup == ("configured", str(tmp_path / "elsewhere" / "ffmpeg"))


# -- the report ----------------------------------------------------------------


async def test_a_bare_machine_reports_every_program_missing_and_what_setup_takes(
    tmp_path, monkeypatch
):
    """Nothing installed, nothing running: each program says where the
    engine looked, and FFmpeg says exactly what a setup downloads and keeps.
    The report itself never downloads anything."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    # No GPU either, so no local text model is recommended and the script
    # model is the engine's own default.
    pin_hardware(monkeypatch, None)
    monkeypatch.setattr(program_manifest, "platform_key", lambda: "linux-x64")

    def no_downloads(*args, **kwargs):
        raise AssertionError("GET /programs started a download")

    monkeypatch.setattr(downloads_module, "download_file", no_downloads)
    pinned = program_manifest.load_programs_manifest().asset("ffmpeg", "linux-x64")

    async with _engine(_config(tmp_path / "data")) as http:
        response = await http.get("/programs")
        assert response.status_code == 200
        report = response.json()

    assert report["platform"] == "linux-x64"
    assert report["programs_dir"] == str((tmp_path / "data" / "programs").resolve())
    assert report["programs_bytes"] == 0
    assert report["disk_free_bytes"] > 0
    # The two folders a person setting a program up by hand needs named:
    # where a binary of their own outranks LocalCut's copy, and where the
    # weights are that ComfyUI has to be pointed at. Both are the engine
    # machine's own, resolved, which on a paired GPU box is the only place
    # they can come from.
    assert report["bin_dir"] == str((tmp_path / "data" / "bin").resolve())
    assert report["models_dir"] == str((tmp_path / "data" / "models").resolve())
    assert [row["id"] for row in report["programs"]] == list(PROGRAM_IDS)

    ffmpeg = _row(report, "ffmpeg")
    assert ffmpeg == {
        "id": "ffmpeg",
        "state": "missing",
        "problem": "not_found",
        "source": "path",
        "location": "ffmpeg",
        "setting": "LOCALCUT_FFMPEG_BIN",
        "version": None,
        "checks": {"draws_text": None},
        "managed": None,
        "setup": {
            "available": True,
            "unavailable_reason": None,
            "takes_effect": True,
            "version": "8.1.3",
            "url": pinned.url,
            "download_bytes": pinned.size,
            "install_bytes": pinned.install_bytes,
            # One build of FFmpeg serves every card.
            "gpu": None,
            "build": None,
            "builds": [],
            "job": None,
            "last": None,
        },
    }

    ollama = _row(report, "ollama")
    assert (ollama["state"], ollama["problem"], ollama["source"]) == (
        "missing",
        "unreachable",
        "configured",
    )
    assert ollama["location"] == "http://127.0.0.1:9/v1"
    assert ollama["setting"] == "LOCALCUT_LLM_URL"
    assert ollama["checks"] == {"server": None, "model": "qwen3:14b", "model_present": None}
    # LocalCut's own Ollama would listen at that loopback address, and pull
    # the script model into its store, which the catalog sizes.
    ollama_pin = program_manifest.load_programs_manifest().asset("ollama", "linux-x64")
    assert ollama["setup"] == {
        "available": True,
        "unavailable_reason": None,
        "takes_effect": True,
        "version": program_manifest.load_programs_manifest().program("ollama").version,
        "url": ollama_pin.url,
        "download_bytes": ollama_pin.size,
        "install_bytes": ollama_pin.install_bytes,
        # One build of Ollama serves every card.
        "gpu": None,
        "build": None,
        "builds": [],
        "pull": {"model": "qwen3:14b", "bytes": 9 * 2**30},
        "job": None,
        "last": None,
    }

    comfyui = _row(report, "comfyui")
    assert (comfyui["state"], comfyui["problem"]) == ("missing", "unreachable")
    assert comfyui["location"] == "http://127.0.0.1:9"
    assert comfyui["setting"] == "LOCALCUT_COMFYUI_URL"

    for row in report["programs"]:
        assert row["state"] in PROGRAM_STATES
        assert row["problem"] in (None, *PROGRAM_PROBLEMS)
        assert row["source"] in PROGRAM_SOURCES


async def test_setup_is_unavailable_where_no_build_is_pinned(tmp_path, monkeypatch):
    """macOS and Linux on ARM get no managed FFmpeg yet. The report says so,
    for the screen to show only the steps to do by hand, and the route
    refuses rather than fetching something unpinned."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    monkeypatch.setattr(program_manifest, "platform_key", lambda: "macos-arm64")
    async with _engine(_config(tmp_path / "data")) as http:
        setup = _row((await http.get("/programs")).json(), "ffmpeg")["setup"]
        assert setup["available"] is False
        assert setup["unavailable_reason"] == "platform_not_supported"
        assert setup["download_bytes"] is None

        refused = await http.post("/programs/ffmpeg/setup")
        assert refused.status_code == 409
        assert "macos-arm64" in refused.json()["detail"]

        assert (await http.post("/programs/ollama/setup")).status_code == 409
        assert (await http.post("/programs/comfyui/setup")).status_code == 409
        assert (await http.post("/programs/nonesuch/setup")).status_code == 404
    assert not (tmp_path / "data" / "programs" / "ffmpeg").exists()


async def test_where_the_ffmpeg_in_use_comes_from_is_reported(tmp_path, monkeypatch):
    """The screen says whose FFmpeg runs: LocalCut's copy, one put in the
    data folder by hand, the user's own on PATH, or a configured path. When
    a copy LocalCut set up is not the one in use, it says that too."""
    _stub_probes(monkeypatch)
    path_dir = tmp_path / "path-dir"
    on_path = _plant(path_dir / f"ffmpeg{_EXE}", b"draws, on path")
    _plant(path_dir / f"ffprobe{_EXE}", b"ffprobe")
    monkeypatch.setenv("PATH", str(path_dir))
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:

        async def ffmpeg() -> dict:
            return _row((await http.get("/programs")).json(), "ffmpeg")

        found = await ffmpeg()
        assert (found["state"], found["source"]) == ("ready", "path")
        assert _same_file(found["location"], on_path)
        assert found["version"] == "8.1.3"
        assert found["checks"] == {"draws_text": True}

        managed = _plant(data / "programs" / "ffmpeg" / f"ffmpeg{_EXE}", b"draws, managed")
        _plant(managed.with_name(f"ffprobe{_EXE}"), b"ffprobe")
        found = await ffmpeg()
        assert (found["source"], found["location"]) == ("managed", str(managed))
        assert found["managed"]["in_use"] is True
        assert found["managed"]["location"] == str(managed.parent.resolve())
        assert found["managed"]["bytes"] == len(b"draws, managed") + len(b"ffprobe")

        by_hand = _plant(data / "bin" / f"ffmpeg{_EXE}", b"draws, by hand")
        _plant(by_hand.with_name(f"ffprobe{_EXE}"), b"ffprobe")
        found = await ffmpeg()
        assert (found["source"], found["location"]) == ("data_dir", str(by_hand))
        assert found["managed"]["in_use"] is False
        assert found["setup"]["takes_effect"] is False


async def test_an_ffmpeg_that_cannot_do_the_job_says_why(tmp_path, monkeypatch):
    """Found is not the same as working. An ffmpeg with no ffprobe beside it
    cannot assemble, one that does not run cannot do anything, and one that
    runs but draws no text cannot put titles or burned captions on a video."""
    _stub_probes(monkeypatch)
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    data = tmp_path / "data"
    binary = data / "bin" / f"ffmpeg{_EXE}"

    async with _engine(_config(data)) as http:

        async def ffmpeg() -> dict:
            return _row((await http.get("/programs")).json(), "ffmpeg")

        _plant(binary, b"draws")
        found = await ffmpeg()
        assert (found["state"], found["problem"]) == ("broken", "ffprobe_missing")

        _plant(binary.with_name(f"ffprobe{_EXE}"), b"ffprobe")
        _plant(binary, b"broken")
        found = await ffmpeg()
        assert (found["state"], found["problem"]) == ("broken", "does_not_run")

        _plant(binary, b"runs, no text")
        found = await ffmpeg()
        assert (found["state"], found["problem"]) == ("ready", None)
        assert found["checks"] == {"draws_text": False}


class _FakeServers:
    """Answers the way Ollama and ComfyUI answer, or the way an
    OpenAI-compatible server that is not Ollama answers."""

    def __init__(self, *, ollama: bool = True) -> None:
        def answer(path: str) -> tuple[int, dict]:
            if path == "/api/version" and ollama:
                return 200, {"version": "0.35.0"}
            if path == "/v1/models":
                return 200, {"object": "list", "data": [{"id": "llama3.2:latest"}]}
            if path == "/system_stats":
                return 200, {"system": {"comfyui_version": "0.38.0"}, "devices": []}
            return 404, {"error": "not found"}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                status, body = answer(self.path)
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.mark.parametrize("model", ["llama3.2", "qwen3:14b"])
async def test_running_servers_report_their_version_and_the_script_model(tmp_path, model):
    """Ollama and ComfyUI are reported as reachable or not at the configured
    address, with the version they report, and for the LLM server whether
    the model scripts are written with is pulled."""
    servers = _FakeServers()
    try:
        config = _config(
            tmp_path, llm_url=f"{servers.url}/v1", comfyui_url=servers.url, llm_model=model
        )
        async with _engine(config) as http:
            report = (await http.get("/programs")).json()
    finally:
        servers.close()

    ollama = _row(report, "ollama")
    assert (ollama["state"], ollama["problem"], ollama["version"]) == ("ready", None, "0.35.0")
    assert ollama["source"] == "configured"
    assert ollama["checks"] == {
        "server": "ollama",
        "model": model,
        "model_present": model == "llama3.2",
    }
    comfyui = _row(report, "comfyui")
    assert (comfyui["state"], comfyui["version"], comfyui["source"]) == (
        "ready",
        "0.38.0",
        "configured",
    )


async def test_an_llm_server_that_is_not_ollama_still_serves_scripts(tmp_path):
    """Any OpenAI-compatible server writes scripts. One that is not Ollama
    has no version to report, and says it is something else."""
    servers = _FakeServers(ollama=False)
    try:
        config = _config(tmp_path, llm_url=f"{servers.url}/v1", llm_model="llama3.2")
        async with _engine(config) as http:
            ollama = _row((await http.get("/programs")).json(), "ollama")
    finally:
        servers.close()
    assert (ollama["state"], ollama["version"]) == ("ready", None)
    assert ollama["checks"]["server"] == "other"
    assert ollama["checks"]["model_present"] is True


# -- setting FFmpeg up -----------------------------------------------------------


def _ws_url(url: str) -> str:
    return url.replace("http://", "ws://", 1) + "/ws"


def _program_events(
    ws, program: str, timeout_s: float = 180, received: list[float] | None = None
) -> list[dict]:
    """Every event about `program` up to and including its terminal one.
    `received` gets the time each of them arrived."""
    seen: list[dict] = []
    deadline = time.monotonic() + timeout_s
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0, f"no terminal event for {program}; saw {seen}"
        event = json.loads(ws.recv(timeout=remaining))
        if event.get("program") != program:
            continue
        if received is not None:
            received.append(time.monotonic())
        seen.append(event)
        if event["type"] in _TERMINAL:
            return seen


@pytest.mark.skipif(not _REAL_PAIR, reason="ffmpeg not installed")
def test_setup_lands_a_working_ffmpeg_the_engine_renders_with_without_a_restart(
    tmp_path, monkeypatch, archives
):
    """The whole promise, on the chain a machine without models runs. Before
    the setup the export cannot run, and the readiness report offers the
    setup as its fix. The setup streams its progress over /ws through every
    phase, checks the binaries it unpacked by running them, and lands them
    while the engine keeps serving. Then the same engine renders a cut with
    the copy it just set up, which draws titles."""
    from websockets.sync.client import connect

    source = Path(_REAL_FFMPEG)
    asset = _pin(
        monkeypatch,
        archives,
        ffmpeg=source,
        ffprobe=source.with_name(f"ffprobe{source.suffix}"),
    )
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    data = tmp_path / "engine"
    managed = data / "programs" / "ffmpeg" / f"ffmpeg{_EXE}"

    with (
        serve_engine(data, TOKEN, backend="ffmpeg,mock") as url,
        httpx.Client(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}) as http,
    ):
        export = http.get("/readiness", params={"kinds": "export"}).json()["rows"][0]
        assert (export["verdict"], export["reason"]) == ("will_fail", "no_ffmpeg")
        assert export["fix"] == {
            "type": "setup_program",
            "program": "ffmpeg",
            "size_bytes": asset["size"],
        }

        with connect(_ws_url(url), subprotocols=[WS_TOKEN_SUBPROTOCOL, TOKEN]) as ws:
            # A body naming another download changes nothing: only the pin
            # is ever fetched.
            started = http.post(
                "/programs/ffmpeg/setup",
                json={"url": f"{archives.url}/elsewhere.zip", "sha256": "0" * 64},
            )
            assert started.status_code == 200
            assert started.json()["status"] == "started"
            events = _program_events(ws, "ffmpeg")

        assert archives.requests == [f"/{asset['url'].rsplit('/', 1)[1]}"]
        phases = [event["phase"] for event in events if event["type"] == "program.setup.progress"]
        # FFmpeg runs per job, so it has none of a server's phases after
        # installing.
        file_phases = SETUP_PHASES[: SETUP_PHASES.index("installing") + 1]
        assert [phase for i, phase in enumerate(phases) if phases.index(phase) == i] == list(
            file_phases
        ), "every phase, in order"
        for event in events:
            if event["type"] == "program.setup.progress" and event["phase"] == "downloading":
                assert event["total"] == asset["size"]
                assert 0 <= event["done"] <= event["total"]
        done = events[-1]
        assert done == {
            "type": "program.setup.done",
            "program": "ffmpeg",
            "version": done["version"],
            "location": str(managed),
            "in_use": True,
            "draws_text": True,
        }

        row = _row(http.get("/programs").json(), "ffmpeg")
        assert (row["state"], row["source"], row["location"]) == ("ready", "managed", str(managed))
        assert row["checks"] == {"draws_text": True}
        assert row["managed"]["bytes"] >= sum(kept["size"] for kept in asset["files"])
        assert row["managed"]["current"] is True
        assert row["setup"]["last"]["outcome"] == "done"
        assert sorted(path.name for path in managed.parent.iterdir()) == sorted(
            [f"ffmpeg{_EXE}", f"ffprobe{_EXE}", "program.json"]
        )
        assert _leftovers(data) == []

        assert http.get("/system").json()["ffmpeg_drawtext"] is True
        export = http.get("/readiness", params={"kinds": "export"}).json()["rows"][0]
        assert (export["verdict"], export["backend"]) == ("ready", "ffmpeg")

        project = http.post("/projects", json={"prompt": "tides", "target_duration_s": 5}).json()
        deadline = time.monotonic() + 300
        while True:
            jobs = http.get("/jobs", params={"project_id": project["id"]}).json()
            if any(job["spec"]["kind"] == "export" for job in jobs) and not outstanding_jobs(jobs):
                break
            assert time.monotonic() < deadline, "the render did not finish"
            time.sleep(0.2)
        failed = {job["spec"]["node_id"]: job["error"] for job in jobs if job["status"] == "failed"}
        assert failed == {}
        (cut_job,) = [job for job in jobs if job["spec"]["kind"] == "export"]
        assert cut_job["backend"] == "ffmpeg"
        cut = http.get(f"/projects/{project['id']}/artifacts/{cut_job['spec']['output_hash']}")
        assert cut.status_code == 200

    rendered = tmp_path / "cut.mp4"
    rendered.write_bytes(cut.content)
    decode = subprocess.run(
        [str(managed), "-v", "error", "-i", str(rendered), "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    assert (decode.returncode, decode.stderr) == (0, "")


async def test_setup_unpacks_a_tar_xz_and_keeps_only_the_pinned_files(
    tmp_path, monkeypatch, archives
):
    """Members are taken by their exact names, so a member with any other
    name, `../` included, is never written. The binaries are executable on
    the systems that have the bit."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(
        monkeypatch,
        archives,
        fmt="tar.xz",
        ffmpeg=b"ffmpeg " * 1000,
        ffprobe=b"ffprobe",
        extra={"../escaped": b"evil", f"{_TOP}/bin/../../escaped": b"evil"},
    )
    checked = _stub_check(monkeypatch)
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        assert (await http.post("/programs/ffmpeg/setup")).json()["status"] == "started"
        row = await _settled(http)

    assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
    folder = data / "programs" / "ffmpeg"
    assert sorted(path.name for path in folder.iterdir()) == sorted(
        [f"ffmpeg{_EXE}", f"ffprobe{_EXE}", "program.json"]
    )
    assert (folder / f"ffmpeg{_EXE}").read_bytes() == b"ffmpeg " * 1000
    assert not (data / "escaped").exists() and not (data / "programs" / "escaped").exists()
    assert len(checked) == 1 and checked[0] != folder, "checked where it was staged"
    if os.name != "nt":
        assert os.access(folder / "ffmpeg", os.X_OK) and os.access(folder / "ffprobe", os.X_OK)
    assert _leftovers(data) == []


@pytest.mark.parametrize("served", ["longer", "shorter"])
async def test_a_download_of_the_wrong_size_is_refused_and_leaves_nothing(
    tmp_path, monkeypatch, archives, served
):
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    asset = _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    archive = archives.root / "ffmpeg-test.zip"
    body = archive.read_bytes()
    archive.write_bytes(body + b"\0" * 4096 if served == "longer" else body[:-4096])
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        row = await _settled(http)

    last = row["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "size_mismatch")
    assert str(asset["size"]) in last["error"]
    assert row["state"] == "missing"
    assert not (data / "programs" / "ffmpeg").exists()
    assert _leftovers(data) == []


def test_a_download_with_the_wrong_hash_is_refused_and_says_so_over_ws(
    tmp_path, monkeypatch, archives
):
    from websockets.sync.client import connect

    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    archive = archives.root / "ffmpeg-test.zip"
    body = bytearray(archive.read_bytes())
    body[len(body) // 2] ^= 0xFF
    archive.write_bytes(bytes(body))
    data = tmp_path / "engine"

    with (
        serve_engine(data, TOKEN, backend="ffmpeg,mock") as url,
        httpx.Client(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}) as http,
    ):
        with connect(_ws_url(url), subprotocols=[WS_TOKEN_SUBPROTOCOL, TOKEN]) as ws:
            http.post("/programs/ffmpeg/setup")
            failed = _program_events(ws, "ffmpeg")[-1]
        row = _row(http.get("/programs").json(), "ffmpeg")

    assert failed["type"] == "program.setup.failed"
    assert failed["reason"] == "checksum_mismatch"
    assert failed["reason"] in SETUP_FAILURES
    assert "SHA-256" in failed["error"]
    assert row["setup"]["job"] is None, "bookkeeping cleared before the event went out"
    assert not (data / "programs" / "ffmpeg").exists()
    assert _leftovers(data) == []


async def test_cancel_stops_the_download_and_removes_what_it_wrote(tmp_path, monkeypatch, archives):
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    _stub_check(monkeypatch)
    archives.hold()
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        await _downloading(http)
        assert _leftovers(data), "the download is somewhere while it runs"

        cancelled = await http.delete("/programs/ffmpeg/setup")
        assert cancelled.status_code == 200
        row = await _settled(http)
        assert row["setup"]["last"]["outcome"] == "cancelled"
        assert (await http.delete("/programs/ffmpeg/setup")).status_code == 409

    archives.release()
    assert not (data / "programs" / "ffmpeg").exists()
    assert _leftovers(data) == []


@pytest.mark.parametrize("drop", ["closed", "reset", "stalled"])
async def test_a_download_that_drops_picks_up_from_the_bytes_it_has(
    tmp_path, monkeypatch, archives, drop
):
    """A slow or flaky link ends a long download partway: the connection
    closes before the body is complete, is reset, or stalls past the read
    timeout. Each time, the setup asks for the rest with a Range request
    from where the bytes on disk end, further on every time and never from
    the start. More drops than the setup retries a link that brings nothing,
    because each of these brought something. (A reset loses what the client
    had not read yet, so where each resume starts is not a fixed number.)"""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    _stub_check(monkeypatch)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    monkeypatch.setattr(program_setup, "_READ_TIMEOUT_S", 0.5)
    piece = 512 << 10
    drops = downloads_module._RETRIES + 2
    archives.drops = [drop] * drops
    archives.drop_after = piece
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        assert (await http.post("/programs/ffmpeg/setup")).json()["status"] == "started"
        row = await _settled(http)

    assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
    assert archives.ranges[0] is None
    resumed_from = [int(asked.removeprefix("bytes=").rstrip("-")) for asked in archives.ranges[1:]]
    assert len(resumed_from) == drops, archives.ranges
    assert 0 < resumed_from[0] and all(a < b for a, b in itertools.pairwise(resumed_from))
    assert (data / "programs" / "ffmpeg" / f"ffmpeg{_EXE}").read_bytes() == b"x" * (4 << 20)
    assert _leftovers(data) == []


@pytest.mark.parametrize("answer", ["ignored", "misplaced"])
async def test_a_resume_the_server_does_not_answer_exactly_starts_over(
    tmp_path, monkeypatch, archives, answer
):
    """Bytes are added to a partial download only from a 206 whose
    Content-Range starts where the partial ends. A server that ignores the
    Range and sends the whole file with a 200 is read from its first byte.
    A 206 from anywhere else is not used at all, and the next attempt asks
    for the whole file."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    _stub_check(monkeypatch)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    archives.drops = ["closed"]
    archives.answer_range = answer
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        row = await _settled(http)

    assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
    resumed = f"bytes={_FIRST_CHUNK}-"
    assert archives.ranges == ([None, resumed] if answer == "ignored" else [None, resumed, None])
    assert (data / "programs" / "ffmpeg" / f"ffmpeg{_EXE}").read_bytes() == b"x" * (4 << 20)
    assert _leftovers(data) == []


async def test_a_link_that_brings_nothing_fails_the_setup_after_a_few_attempts(
    tmp_path, monkeypatch, archives
):
    """Attempts go on while each brings new bytes. A run of them that bring
    none is a link that is down, and the setup fails with what stopped the
    last one, and removes what it wrote."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    archives.drops = ["closed"] * 50
    archives.drop_after = 0
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        row = await _settled(http)

    last = row["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "download_failed")
    assert "peer closed connection" in last["error"]
    assert len(archives.requests) == 1 + downloads_module._RETRIES
    assert not (data / "programs" / "ffmpeg").exists()
    assert _leftovers(data) == []


@pytest.mark.parametrize("status", [500, 502, 503, 504, 429])
async def test_a_server_error_is_waited_out_and_the_setup_carries_on(
    tmp_path, monkeypatch, archives, status
):
    """GitHub's CDN answers 5xx while it is having a bad minute, and 429 when
    it is rate-limiting this address. None of them says the build is gone,
    so the setup asks again, as it does after a dropped connection."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 0.0)
    archives.statuses = [status, status]
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        row = await _settled(http)

    assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
    assert len(archives.requests) == 3
    assert _leftovers(data) == []


async def test_a_pin_the_server_no_longer_has_fails_at_once_and_says_so(
    tmp_path, monkeypatch, archives
):
    """A 404 for the pinned URL is a build that has been taken down, and no
    number of attempts brings it back. The setup stops on the first one,
    with a reason of its own rather than "the download didn't finish", which
    would send the user off to check a connection that is fine."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    archives.statuses = [404]
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        row = await _settled(http)

    last = row["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "download_gone")
    assert "HTTP 404" in last["error"]
    assert "ffmpeg 8.1.3" in last["error"]
    assert len(archives.requests) == 1
    assert _leftovers(data) == []


async def test_cancel_stops_a_setup_that_is_waiting_to_resume(
    tmp_path, monkeypatch, archives, caplog
):
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    _stub_check(monkeypatch)
    monkeypatch.setattr(downloads_module, "_RETRY_PAUSE_S", 60.0)
    archives.drops = ["closed"]
    data = tmp_path / "data"

    with caplog.at_level("WARNING"):
        async with _engine(_config(data)) as http:
            await http.post("/programs/ffmpeg/setup")
            async with asyncio.timeout(30):
                while "trying again" not in caplog.text:
                    row = _row((await http.get("/programs")).json(), "ffmpeg")
                    assert row["setup"]["job"] is not None, row["setup"]["last"]
                    await asyncio.sleep(0.05)

            assert (await http.delete("/programs/ffmpeg/setup")).status_code == 200
            async with asyncio.timeout(10):
                row = await _settled(http)

    assert row["setup"]["last"]["outcome"] == "cancelled"
    assert len(archives.requests) == 1
    assert _leftovers(data) == []


def test_the_download_speed_is_reported_while_bytes_arrive(tmp_path, monkeypatch, archives):
    """A slow link is when the speed matters most. Every progress event
    after the one that announces the download has bytes done and a speed:
    those bytes over the time since the download began. How fast a paced
    archive arrives depends on how busy the machine is, so each speed is
    held to when its bytes were sent and its event arrived, not to the pace
    the server was asked for."""
    from websockets.sync.client import connect

    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (384 << 10))
    _stub_check(monkeypatch)
    archives.pace = (8 << 10, 0.05)
    # One window for the whole download, however slowly it arrives, so each
    # speed counts every byte since the download began.
    monkeypatch.setattr(program_setup, "_RATE_WINDOW_S", 3600.0)
    received: list[float] = []

    with (
        serve_engine(tmp_path / "engine", TOKEN, backend="ffmpeg,mock") as url,
        httpx.Client(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}) as http,
    ):
        with connect(_ws_url(url), subprotocols=[WS_TOKEN_SUBPROTOCOL, TOKEN]) as ws:
            asked = time.monotonic()
            http.post("/programs/ffmpeg/setup")
            events = _program_events(ws, "ffmpeg", received=received)

    assert events[-1]["type"] == "program.setup.done", events[-1]
    announced, *measured = [
        (event["done"], event["bytes_per_s"], at)
        for event, at in zip(events, received, strict=True)
        if event["type"] == "program.setup.progress" and event["phase"] == "downloading"
    ]
    assert announced[0] == 0
    assert len(measured) >= 3, measured
    # The download began after the setup was asked for and before the
    # request reached the server. Each speed was measured once the piece
    # holding its last byte had started out, and before its event arrived.
    # A clock tick either way, for a clock as coarse as Windows' can be.
    began = archives.paced[0][0]
    tick = 2 * time.get_clock_info("monotonic").resolution
    for done, rate, at in measured:
        assert done > 0 and rate is not None, measured
        sent = next(started for started, through in archives.paced if through >= done)
        slowest = done / (at - asked + tick)
        fastest = done / (sent - began - tick) if sent - began > tick else float("inf")
        assert slowest - 1 <= rate <= fastest + 1, (done, rate, slowest, fastest)


async def test_one_setup_of_a_program_runs_at_a_time(tmp_path, monkeypatch, archives):
    """A second POST while one runs is refused rather than queued or joined,
    and the program cannot be removed out from under its own setup."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    _stub_check(monkeypatch)
    archives.hold()

    async with _engine(_config(tmp_path / "data")) as http:
        first = await http.post("/programs/ffmpeg/setup")
        assert first.json()["status"] == "started"
        await _downloading(http)

        second = await http.post("/programs/ffmpeg/setup")
        assert second.status_code == 409
        assert (await http.delete("/programs/ffmpeg")).status_code == 409

        archives.release()
        row = await _settled(http)
        assert row["setup"]["last"]["outcome"] == "done"
        assert row["setup"]["last"]["job"] == first.json()["job"]
    assert len(archives.requests) == 1


async def test_ffmpeg_never_appears_without_its_ffprobe(tmp_path, monkeypatch, archives):
    """The engine switches to a binary the moment it exists, and runs the
    ffprobe beside it. So the pair arrives as one folder, renamed into
    place, both the first time and when a setup replaces an existing copy.
    Checked after every rename the setup makes, and by a thread watching
    the folder the whole time."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _stub_check(monkeypatch)
    data = tmp_path / "data"
    live = data / "programs" / "ffmpeg"
    seen: list[str] = []

    def alone() -> bool:
        # One listing, not two lookups: a folder renamed away between a
        # lookup of ffmpeg and one of ffprobe would read as ffmpeg alone.
        try:
            names = set(os.listdir(live))
        except FileNotFoundError:
            return False
        return f"ffmpeg{_EXE}" in names and f"ffprobe{_EXE}" not in names

    real_replace = os.replace

    def replace(src, dst, *args, **kwargs):
        real_replace(src, dst, *args, **kwargs)
        if alone():
            seen.append(f"after {src} -> {dst}")

    monkeypatch.setattr(os, "replace", replace)
    stop = threading.Event()

    def watch() -> None:
        while not stop.is_set():
            if alone():
                seen.append("seen by the watcher")

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        async with _engine(_config(data)) as http:
            for build in (b"first build", b"second build"):
                _pin(monkeypatch, archives, ffmpeg=build, name=f"{build[:5].decode()}.zip")
                assert (await http.post("/programs/ffmpeg/setup")).json()["status"] == "started"
                row = await _settled(http)
                assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
                assert (live / f"ffmpeg{_EXE}").read_bytes() == build
    finally:
        stop.set()
        watcher.join(timeout=5)
    assert seen == []
    assert _leftovers(data) == []


async def test_setting_up_a_copy_that_is_already_in_place_does_nothing(
    tmp_path, monkeypatch, archives
):
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    async with _engine(_config(tmp_path / "data")) as http:
        await http.post("/programs/ffmpeg/setup")
        await _settled(http)
        again = await http.post("/programs/ffmpeg/setup")
        assert again.status_code == 200
        assert again.json() == {"status": "installed"}
    assert len(archives.requests) == 1


async def test_setup_refuses_when_the_disk_cannot_hold_the_download_and_the_copy(
    tmp_path, monkeypatch, archives
):
    """Both have to fit at once: the archive stays until the files it holds
    are unpacked beside it."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    asset = _pin(monkeypatch, archives)
    _stub_check(monkeypatch)
    need = asset["size"] + sum(kept["size"] for kept in asset["files"])
    usage = shutil.disk_usage(tmp_path)
    monkeypatch.setattr(
        program_setup.shutil,
        "disk_usage",
        lambda path: usage._replace(free=need - 1),
    )
    async with _engine(_config(tmp_path / "data")) as http:
        refused = await http.post("/programs/ffmpeg/setup")
    assert refused.status_code == 507
    assert archives.requests == []


async def test_remove_takes_only_localcuts_own_copy(tmp_path, monkeypatch, archives):
    """A binary placed in <data_dir>/bin by hand and the user's own on PATH
    are never touched. With LocalCut's copy gone the engine uses the next
    one it finds, at once."""
    _stub_probes(monkeypatch)
    _stub_check(monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"draws, managed")
    path_dir = tmp_path / "path-dir"
    users = _plant(path_dir / f"ffmpeg{_EXE}", b"draws, on path")
    _plant(path_dir / f"ffprobe{_EXE}", b"ffprobe")
    monkeypatch.setenv("PATH", str(path_dir))
    data = tmp_path / "data"

    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        installed = await _settled(http)
        assert installed["source"] == "managed"
        size = installed["managed"]["bytes"]

        removed = await http.delete("/programs/ffmpeg")
        assert removed.status_code == 200
        assert removed.json() == {"ok": True, "freed_bytes": size}
        row = _row((await http.get("/programs")).json(), "ffmpeg")
        assert (row["source"], row["managed"]) == ("path", None)
        assert _same_file(row["location"], users)

        assert (await http.delete("/programs/ffmpeg")).json() == {"ok": True, "freed_bytes": 0}
        assert (await http.delete("/programs/nonesuch")).status_code == 404

        by_hand = _plant(data / "bin" / f"ffmpeg{_EXE}", b"by hand")
        assert (await http.delete("/programs/ffmpeg")).json()["freed_bytes"] == 0
        assert by_hand.read_bytes() == b"by hand"
    assert users.read_bytes() == b"draws, on path"
    assert not (data / "programs" / "ffmpeg").exists()


async def test_remove_waits_for_a_render_that_is_using_the_copy(tmp_path, monkeypatch, archives):
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _stub_check(monkeypatch)
    _pin(monkeypatch, archives)
    data = tmp_path / "data"
    async with _engine(_config(data)) as http:
        await http.post("/programs/ffmpeg/setup")
        await _settled(http)

        monkeypatch.setattr(Scheduler, "running_backend", lambda self: "ffmpeg")
        busy = await http.delete("/programs/ffmpeg")
        assert busy.status_code == 409
        assert "render" in busy.json()["detail"]
        assert (data / "programs" / "ffmpeg" / f"ffmpeg{_EXE}").exists()

        monkeypatch.setattr(Scheduler, "running_backend", lambda self: "mock")
        assert (await http.delete("/programs/ffmpeg")).status_code == 200


async def test_what_an_interrupted_setup_left_is_cleared_when_the_engine_starts(tmp_path):
    """An engine that stopped mid-setup leaves its scratch folder behind,
    and one that stopped between the two renames of a replacement leaves the
    old copy aside with nothing in its place. The first is removed while the
    engine serves. The second is put back before it serves."""
    programs = tmp_path / "programs"
    _plant(programs / ".setup-ffmpeg-0a1b2c3d" / "ffmpeg-test.zip.part", b"partial")
    _plant(programs / ".old-ffmpeg-0a1b2c3d" / f"ffmpeg{_EXE}", b"the old copy")
    _plant(programs / ".old-ffmpeg-0a1b2c3d" / f"ffprobe{_EXE}", b"its ffprobe")
    _plant(programs / ".removing-ffmpeg-0a1b2c3d" / f"ffmpeg{_EXE}", b"half removed")

    async with _engine(_config(tmp_path)):
        assert (programs / "ffmpeg" / f"ffmpeg{_EXE}").read_bytes() == b"the old copy"
        async with asyncio.timeout(30):
            while _leftovers(tmp_path):
                await asyncio.sleep(0.05)


# -- the CLI -------------------------------------------------------------------


def test_the_cli_sets_up_and_removes_a_program_on_the_engine(
    tmp_path, monkeypatch, archives, capsys
):
    """A headless GPU box is set up from its own terminal, through the
    engine like every other client. Exit 0 when the setup lands, 1 when it
    fails, 2 when there is no engine."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _stub_check(monkeypatch)
    _pin(monkeypatch, archives)
    monkeypatch.setattr(cli, "_SETUP_POLL_S", 0.05)

    with serve_engine(tmp_path / "engine", TOKEN, backend="ffmpeg,mock") as url:

        def run(*args: str) -> int:
            return cli.main(["programs", *args, "--engine", url, "--token", TOKEN])

        assert run("list", "--json") == 0
        listed = json.loads(capsys.readouterr().out)
        assert _row(listed, "ffmpeg")["state"] == "missing"

        assert run("setup", "ffmpeg") == 0
        assert "ffmpeg is set up" in capsys.readouterr().out

        assert run("remove", "ffmpeg", "--json") == 0
        assert json.loads(capsys.readouterr().out)["freed_bytes"] > 0

        archive = archives.root / "ffmpeg-test.zip"
        archive.write_bytes(archive.read_bytes()[:-1] + b"!")
        assert run("setup", "ffmpeg") == 1
        assert "checksum_mismatch" in capsys.readouterr().err

        assert run("setup", "ollama") == 1

    assert cli.main(["programs", "list", "--engine", url, "--token", TOKEN]) == 2


def test_a_cli_that_stops_waiting_says_the_setup_carries_on(
    tmp_path, monkeypatch, archives, capsys
):
    """--timeout bounds the wait, not the setup: the engine keeps going on
    its own. Exit 1, and say so, with the command that shows how far the
    setup has got."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    _stub_check(monkeypatch)
    _pin(monkeypatch, archives, ffmpeg=b"x" * (4 << 20))
    monkeypatch.setattr(cli, "_SETUP_POLL_S", 0.05)
    archives.hold()

    with (
        serve_engine(tmp_path / "engine", TOKEN, backend="ffmpeg,mock") as url,
        httpx.Client(base_url=url, headers={"Authorization": f"Bearer {TOKEN}"}) as http,
    ):
        status = cli.main(
            ["programs", "setup", "ffmpeg", "--timeout", "1", "--engine", url, "--token", TOKEN]
        )
        assert status == 1
        said = capsys.readouterr().err
        assert "carries on" in said and "localcut programs list" in said, said
        assert said.isascii()
        assert _row(http.get("/programs").json(), "ffmpeg")["setup"]["job"] is not None

        archives.release()
        deadline = time.monotonic() + 60
        while (row := _row(http.get("/programs").json(), "ffmpeg"))["setup"]["job"] is not None:
            assert time.monotonic() < deadline, "the setup did not finish"
            time.sleep(0.05)
    assert row["setup"]["last"]["outcome"] == "done"
