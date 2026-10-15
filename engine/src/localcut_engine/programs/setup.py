"""Setting a program up: LocalCut's own copy of it, from the pinned build, in
<data_dir>/programs/<id>, while the engine keeps serving.

A setup runs in the background and reports on the event bus /ws carries,
the way model downloads do (manifest/manager.py). It goes through these
phases, each announced as it starts:

1. downloading: the pinned archive, into a scratch folder beside the program
   folders, through the model downloader, so every redirect hop passes the
   same guard and the size has to match the pin to the byte. A connection
   that drops or stalls partway is asked for the rest, with a Range request
   from the bytes already written, and a server error is waited out, by the
   retry policy model downloads use (`downloads.download_file_retrying`);
2. verifying: the download's SHA-256 against the pin;
3. unpacking: only the files the pin names, each taken by its exact member
   name and written under the bare name the pin gives it, so no member of
   the archive is ever written anywhere else (no zip-slip, whatever the
   archive holds);
4. checking: the unpacked program is run where it was unpacked, so a build
   that cannot run here never replaces anything;
5. installing: the unpacked folder is renamed into place whole. The engine
   switches to a binary the moment it exists, and runs the ffprobe beside
   its ffmpeg, so a folder that filled up file by file would show it an
   ffmpeg without its ffprobe.

A program that runs as a server (Ollama) goes on:

6. starting: LocalCut's copy is started (server.py) and has to answer. A
   copy already running is stopped before its folder is replaced, and the
   new one started in its place;
7. pulling: the model scripts are written with is pulled through it, when
   its store does not have it yet. Cancelling here leaves the program set
   up and the model not.

Setting up a server program whose copy is already the pinned build runs
only the last two, where they have something to do: it starts a copy that
is not running and pulls a model it lacks. A pull can also be asked for on
its own (`pull`), through whichever Ollama answers at the address, the
user's own included.

It ends with `program.setup.done`, `program.setup.failed` (with a reason
from SETUP_FAILURES) or `program.setup.cancelled`. A failed or cancelled
setup removes everything it wrote before saying so, and what an interrupted
one left behind is cleared the next time the engine starts (`sweep`).

One setup per program at a time. Nothing a client sends changes what is
fetched: the routes take no body, and the pin is the only source.

What a setup needs to know about one program in particular (which files it
must keep, how to tell the copy works, whether the engine would use it) is
that program's installer: FFmpeg and Ollama so far. Another program is a
pin in programs-manifest.json plus an installer here.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import functools
import json
import logging
import lzma
import os
import secrets
import shutil
import socket
import stat
import subprocess
import tarfile
import threading
import time
import zipfile
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

import httpx

from .. import storage
from ..backends import ffmpeg as ffmpeg_backend
from ..config import EngineConfig
from ..events import EventBus
from ..manifest import downloads
from ..manifest.model import ModelFile
from ..project.store import _write_atomic
from . import PROGRAM_IDS, ollama
from . import manifest as program_manifest
from . import server as managed_server
from .manifest import KeptFile, ProgramAsset, ProgramPin
from .server import ManagedServers, ServerLaunch

logger = logging.getLogger(__name__)

try:
    from compression import zstd as _zstd

    _ZSTD_ERRORS: tuple[type[Exception], ...] = (_zstd.ZstdError,)
except ImportError:  # Python 3.13
    _ZSTD_ERRORS = ()

#: What LocalCut writes beside a program's files: which build it is.
RECORD = "program.json"
#: The newest record format this engine reads.
RECORD_VERSION = 1

_PROGRESS_INTERVAL_S = 0.5  # the bus throttle model downloads use
_RATE_WINDOW_S = 5.0  # bytes_per_s is measured over the last few seconds
_RATE_MIN_S = 0.5  # and not over less than this
_SAMPLE_EVERY_S = 0.1  # as fine as a window of seconds needs
_CHUNK = 1 << 20
# No bytes for this long is a stalled download, which asks for the rest the
# way a dropped one does (downloads.download_file_retrying).
_READ_TIMEOUT_S = 120.0
# How long a rename keeps trying while another process holds a file in the
# folder. On Windows a virus scanner opens a new executable to look at it,
# and a folder holding an open file cannot be renamed until it lets go.
_RENAME_BUDGET_S = 30.0
_REMOVE_BUDGET_S = 5.0
# What failed, by the phase it failed in, for an error nothing else names.
_REASON_BY_PHASE = {
    "downloading": "download_failed",
    "verifying": "download_failed",
    "unpacking": "unpack_failed",
    "checking": "does_not_run",
    "installing": "install_failed",
    "starting": "did_not_start",
    "pulling": "pull_failed",
}
# The phases whose bytes arrive over a network, and so have a speed.
_TRANSFERS = ("downloading", "pulling")


class SetupUnavailable(RuntimeError):
    """No managed setup of this program on this machine."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class SetupBusy(RuntimeError):
    """A setup of this program is already running."""


class SetupNotRunning(RuntimeError):
    """There is no setup of this program to cancel, or it is too late to."""


class NotEnoughSpace(RuntimeError):
    """The disk cannot hold the download and the unpacked copy at once."""

    def __init__(self, message: str, *, need: int, free: int) -> None:
        super().__init__(message)
        self.need = need
        self.free = free


class ProgramInUse(RuntimeError):
    """LocalCut's copy is being run, so it cannot be removed or replaced."""


class NoServer(RuntimeError):
    """No server of this program answers where the engine looks for it, so
    there is nothing to start, stop or pull through."""


class SetupFailed(Exception):
    """A setup stopped, with a reason code from SETUP_FAILURES."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class _Stopped(Exception):
    """Raised on a worker thread when its setup was cancelled."""


# -- what a program needs ----------------------------------------------------


class FFmpegInstaller:
    """FFmpeg as a setup sees it: two binaries, run to prove they work."""

    program = "ffmpeg"
    #: FFmpeg is run per job, not kept running.
    serves = False

    @staticmethod
    def _exe(platform_key: str) -> str:
        return ".exe" if platform_key.startswith("windows") else ""

    def fits(self, asset: ProgramAsset) -> bool:
        """Whether a pinned build keeps what the engine runs: ffmpeg, and the
        ffprobe it takes from beside it."""
        exe = self._exe(asset.platform)
        return {f"ffmpeg{exe}", f"ffprobe{exe}"} <= {kept.path for kept in asset.files}

    def takes_effect(self, config: EngineConfig) -> bool:
        """Whether LocalCut's copy is, or would be, the ffmpeg the engine
        runs: a configured path and a binary in <data_dir>/bin outrank it."""
        return config.ffmpeg_lookup[0] in ("managed", "path")

    def in_use(self, config: EngineConfig) -> bool:
        return config.ffmpeg_lookup[0] == "managed"

    def binary(self, config: EngineConfig) -> Path:
        """Where LocalCut's ffmpeg is, as the engine runs it."""
        exe = ".exe" if os.name == "nt" else ""
        return config.programs_dir / self.program / f"ffmpeg{exe}"

    async def check(self, folder: Path) -> dict:
        """Run the unpacked pair where it lies. Both have to answer
        `-version`, and ffmpeg has to get through the text probe an export
        relies on. Drawing nothing is not a failure: such an ffmpeg still
        assembles a video with no titles or burned captions, and the done
        event says it draws no text. Not answering at all is."""
        exe = ".exe" if os.name == "nt" else ""
        for name in ("ffmpeg", "ffprobe"):
            binary = folder / f"{name}{exe}"
            if await ffmpeg_backend.probe_version(str(binary)) is None:
                raise SetupFailed("does_not_run", f"the {name} it unpacked does not run here")
        drawn = await ffmpeg_backend.FFmpegBackend(
            ffmpeg_bin=str(folder / f"ffmpeg{exe}")
        ).supports_drawtext()
        if drawn is None:
            raise SetupFailed("does_not_run", "the ffmpeg it unpacked does not run here")
        return {"draws_text": drawn}


class OllamaInstaller:
    """Ollama as a setup sees it: one binary and the libraries it loads from
    lib/ollama beside it, run as a server (server.py) that LocalCut starts
    and stops with the engine, and the model scripts are written with."""

    program = "ollama"
    serves = True

    @staticmethod
    def _binary_path(platform_key: str) -> str:
        return "ollama.exe" if platform_key.startswith("windows") else "bin/ollama"

    def fits(self, asset: ProgramAsset) -> bool:
        """Whether a pinned build keeps the binary where the engine starts
        it, with the CPU library every machine falls back to."""
        kept = {kept.path for kept in asset.files}
        return self._binary_path(asset.platform) in kept and any(
            path.startswith("lib/ollama/") for path in kept
        )

    def takes_effect(self, config: EngineConfig) -> bool:
        """Whether LocalCut's copy could be the server scripts are written
        with: the address the engine asks is one a copy on this machine can
        listen on. An address on another machine is someone else's."""
        return ollama.local_address(config.llm_url) is not None

    def in_use(self, config: EngineConfig) -> bool:
        """Whether LocalCut's copy is the server at the address, or is
        starting to be."""
        running = managed_server.find(config, self.program)
        return running is not None and running.serving

    def binary(self, config: EngineConfig) -> Path:
        name = "ollama.exe" if os.name == "nt" else "bin/ollama"
        return config.programs_dir / self.program / name

    def _environment(self, config: EngineConfig, host: str, port: int, models: Path) -> dict:
        # Ollama keeps a key pair in ~/.ollama, made the first time it
        # serves. Its home is a folder of LocalCut's, so nothing is written
        # outside the data dir.
        home = str((config.data_dir / "run" / "ollama-home").resolve())
        listen = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        return {
            "OLLAMA_HOST": listen,
            "OLLAMA_MODELS": str(models.resolve()),
            "HOME": home,
            "USERPROFILE": home,
        }

    def launch(self, config: EngineConfig) -> ServerLaunch | None:
        address = ollama.local_address(config.llm_url)
        binary = self.binary(config)
        if address is None or not binary.is_file():
            return None
        host, port = address
        models = ollama.model_store(config)
        models.mkdir(parents=True, exist_ok=True)
        environment = self._environment(config, host, port, models)
        Path(environment["HOME"]).mkdir(parents=True, exist_ok=True)
        return ServerLaunch(
            argv=[str(binary), "serve"],
            env=environment,
            cwd=binary.parent,
            url=f"http://{host if ':' not in host else f'[{host}]'}:{port}",
            host=host,
            port=port,
        )

    async def identify(self, url: str):  # noqa: ANN201 - server.Identity
        return await ollama.identify(url)

    async def check(self, folder: Path) -> dict:
        """Serve from where it was unpacked, on a free loopback port with an
        empty model store, until it answers /api/version: that loads its
        libraries and looks at the GPUs, which `--version` alone does not."""
        binary = folder / ("ollama.exe" if os.name == "nt" else "bin/ollama")
        scratch = folder.parent / "check"
        scratch.mkdir(parents=True, exist_ok=True)
        port = _free_port()
        environment = {
            "OLLAMA_HOST": f"127.0.0.1:{port}",
            "OLLAMA_MODELS": str(scratch / "models"),
            "HOME": str(scratch),
            "USERPROFILE": str(scratch),
        }
        options: dict[str, Any] = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        with (scratch / "serve.log").open("wb") as log:
            try:
                process = await asyncio.create_subprocess_exec(
                    str(binary),
                    "serve",
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=log,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=binary.parent,
                    env={**os.environ, **environment},
                    **options,
                )
            except OSError as exc:
                raise SetupFailed("does_not_run", f"the ollama it unpacked does not run: {exc}")
        try:
            deadline = time.monotonic() + managed_server.START_TIMEOUT_S
            while time.monotonic() < deadline:
                if process.returncode is not None:
                    break
                if await ollama.identify(f"http://127.0.0.1:{port}") == "self":
                    return {}
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(process.wait(), timeout=0.25)
        finally:
            await asyncio.to_thread(managed_server._stop_tree, process.pid)
            await process.wait()
        said = (scratch / "serve.log").read_text("utf-8", "replace").strip().splitlines()[-3:]
        raise SetupFailed(
            "does_not_run",
            "the ollama it unpacked did not answer" + (f": {' | '.join(said)}" if said else ""),
        )

    def model_to_pull(self, config: EngineConfig, model: str) -> str | None:
        """`model`, when LocalCut's copy has not pulled it yet."""
        return None if ollama.model_on_disk(ollama.model_store(config), model) else model

    def pull_bytes(self, config: EngineConfig, model: str) -> int:
        """What pulling `model` into LocalCut's copy would add, by the
        catalog's estimate: 0 when it is there already or not catalogued."""
        if self.model_to_pull(config, model) is None:
            return 0
        return ollama.model_bytes(config, model) or 0


#: The programs LocalCut can set up, by id.
INSTALLERS: dict[str, Any] = {"ffmpeg": FFmpegInstaller(), "ollama": OllamaInstaller()}


def _free_port() -> int:
    """A loopback port nothing listens on now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def pinned(program_id: str) -> tuple[ProgramPin | None, ProgramAsset | None, str | None]:
    """(pin, this machine's build, why there is none). The reason is one of
    SETUP_UNAVAILABLE when there is no build to set up here."""
    installer = INSTALLERS.get(program_id)
    pin = program_manifest.load_programs_manifest().program(program_id)
    if installer is None or pin is None:
        return pin, None, "program_not_supported"
    asset = pin.asset_for(program_manifest.platform_key() or "")
    if asset is None or not installer.fits(asset) or not _readable(asset):
        return pin, None, "platform_not_supported"
    return pin, asset, None


def _readable(asset: ProgramAsset) -> bool:
    """Whether this Python can unpack the archive. zstd came to the standard
    library in 3.14; every engine LocalCut ships runs on 3.14, and one run
    from a source checkout on 3.13 sets up what it can read."""
    return asset.format != "tar.zst" or bool(_ZSTD_ERRORS)


def setup_fix(config: EngineConfig, program_id: str) -> dict | None:
    """The readiness fix that sets this program up, or None where it would
    change nothing: no build is pinned for this machine, something outranks
    LocalCut's copy, or that copy is already the one in use. Carries the
    download's size, for the button to show."""
    installer = INSTALLERS.get(program_id)
    _, asset, _ = pinned(program_id)
    if installer is None or asset is None:
        return None
    if not installer.takes_effect(config) or installer.in_use(config):
        return None
    if installer.serves and is_current(config.programs_dir / program_id, asset):
        # Set up already, and not running: starting it is what it needs,
        # which is Settings > Programs' to offer, not a download.
        return None
    return {"type": "setup_program", "program": program_id, "size_bytes": asset.size}


def read_record(folder: Path) -> dict | None:
    """What LocalCut wrote about the copy in `folder`, or None when there is
    no record it can read: none, unreadable, or a format from a newer
    build, which is reported as unknown rather than read in part."""
    try:
        record = json.loads((folder / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    version = record.get("format")
    if not isinstance(version, int) or isinstance(version, bool) or version > RECORD_VERSION:
        return None
    return record


def is_current(folder: Path, asset: ProgramAsset | None) -> bool:
    """Whether the copy in `folder` is the build pinned now, whole: its
    record names the pinned download, and every file kept from it is there
    at its pinned size."""
    if asset is None:
        return False
    record = read_record(folder)
    if record is None or record.get("sha256") != asset.sha256:
        return False
    for kept in asset.files:
        try:
            if (folder / kept.path).stat().st_size != kept.size:
                return False
        except OSError:
            return False
    return True


# -- the setup jobs -------------------------------------------------------------


@dataclass
class _Job:
    id: str
    program: str
    phase: str
    total: int
    done: int = 0
    task: asyncio.Task | None = None
    # Cleared while the copy is being moved into place, which must finish
    # once it has started.
    cancellable: bool = True
    _samples: deque = field(default_factory=deque)
    _last_emit: float = 0.0

    def rate(self, now: float | None = None) -> int | None:
        """Bytes a second over the last few seconds of the download: what
        arrived since the window began, over the time since. 0 while nothing
        arrives, and None for the first half second, which is too little to
        measure."""
        if self.phase not in _TRANSFERS or not self._samples:
            return None
        now = time.monotonic() if now is None else now
        start = now - _RATE_WINDOW_S
        # The window begins at the newest sample from before it, which is
        # how much had arrived by then, or at the first sample, for a
        # download younger than the window.
        since, base = self._samples[0]
        for at, done in self._samples:
            if at > start:
                break
            since, base = at, done
        span = now - max(since, start)
        return round((self.done - base) / span) if span >= _RATE_MIN_S else None

    def sample(self, now: float) -> None:
        """Note how far the job has got. A count lower than the last is a
        download that started over (a server that answered the resume with
        the whole file), and what came before it measures nothing now."""
        if self._samples and self.done < self._samples[-1][1]:
            self._samples.clear()
        if len(self._samples) > 1 and now - self._samples[-2][0] < _SAMPLE_EVERY_S:
            # Bytes arrive in many small reads. The newest stands in for the
            # ones just before it, so the window holds tens of samples rather
            # than thousands, and still ends at the latest count.
            self._samples[-1] = (now, self.done)
        else:
            self._samples.append((now, self.done))
        # One sample from before the window stays: it is where the window
        # begins. Dropping it left a slow download, whose bytes arrive
        # seconds apart, with a single sample and no speed at all.
        while len(self._samples) > 1 and self._samples[1][0] <= now - _RATE_WINDOW_S:
            self._samples.popleft()

    def describe(self) -> dict:
        return {
            "id": self.id,
            "phase": self.phase,
            "done": self.done,
            "total": self.total,
            "bytes_per_s": self.rate(),
        }


class ProgramSetup:
    """The API face of program setups: start, cancel, remove, and what is
    running or last ended, per program.

    `render_uses(program)` says whether a render is running that program
    now. It is asked before LocalCut's copy is removed or replaced."""

    def __init__(
        self,
        config: EngineConfig,
        events: EventBus,
        *,
        render_uses: Callable[[str], bool] = lambda program: False,
        servers: ManagedServers | None = None,
        script_model: Callable[[], str] | None = None,
    ) -> None:
        self.config = config
        self.events = events
        self.render_uses = render_uses
        # The engine's managed servers, which a setup of a server program
        # starts, stops and pulls through. None runs no server phases.
        self.servers = servers
        # The model a setup of Ollama pulls: the one scripts are written with.
        self.script_model = script_model
        self._jobs: dict[str, _Job] = {}
        self._last: dict[str, dict] = {}
        # Start and remove, one at a time per program: the checks they make
        # before acting are awaits, and two interleaved would each pass them.
        self._locks: dict[str, asyncio.Lock] = {}

    def folder(self, program_id: str) -> Path:
        return self.config.programs_dir / program_id

    def state(self, program_id: str) -> dict:
        """The running setup, and how the last one in this engine's life
        ended (null before any has)."""
        job = self._jobs.get(program_id)
        return {
            "job": job.describe() if job is not None else None,
            "last": self._last.get(program_id),
        }

    async def start(self, program_id: str) -> dict:
        """Begin a setup. Returns {"status": "started", "job": id}, or
        {"status": "installed"} when LocalCut's copy is already the pinned
        build, whole. Raises KeyError for an unknown program, and
        SetupUnavailable, SetupBusy, ProgramInUse or NotEnoughSpace when it
        will not start."""
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        lock = self._locks.setdefault(program_id, asyncio.Lock())
        async with lock:
            if program_id in self._jobs:
                raise SetupBusy(f"{program_id} is already being set up")
            pin, asset, unavailable = pinned(program_id)
            if asset is None or pin is None:
                where = program_manifest.platform_key() or "this machine"
                raise SetupUnavailable(
                    unavailable or "program_not_supported",
                    f"LocalCut has no build of {program_id} to set up on {where}; "
                    "install it yourself",
                )
            installer = INSTALLERS[program_id]
            folder = self.folder(program_id)
            model = await self._model_for(installer)
            if await asyncio.to_thread(is_current, folder, asset):
                if not await self._left_to_do(installer, model):
                    return {"status": "installed"}
                server = self.servers.get(program_id) if self.servers is not None else None
                first = "pulling" if server is not None and server.serving else "starting"
                job = self._open_job(program_id, first, 0)
                job.task = asyncio.get_running_loop().create_task(
                    self._run_server_phases(job, pin, installer), name=f"setup-{program_id}"
                )
                return {"status": "started", "job": job.id}
            if folder.exists() and installer.in_use(self.config) and self.render_uses(program_id):
                raise ProgramInUse(
                    f"a render is using LocalCut's {program_id}; wait for it to finish, "
                    "or cancel it, and set it up again"
                )
            pull = installer.pull_bytes(self.config, model) if model else 0
            await asyncio.to_thread(self._check_space, program_id, asset, pull)
            job = self._open_job(program_id, "downloading", asset.size)
            job.task = asyncio.get_running_loop().create_task(
                self._run(job, pin, asset), name=f"setup-{program_id}"
            )
            return {"status": "started", "job": job.id}

    async def pull(self, program_id: str, model: str | None = None) -> dict:
        """Pull a model through whichever server of this program answers
        where the engine looks: LocalCut's copy, or the user's own. With no
        model named, the one scripts are written with. Returns {"status":
        "started", "job": id, "model": name}, or {"status": "present",
        "model": name} when the server has it already.

        Raises KeyError for an unknown program, SetupUnavailable for one with
        no models to pull, NoServer when no server of it answers, SetupBusy
        while a setup or pull of it runs, and NotEnoughSpace when the model
        would not fit beside LocalCut's copy (a server of the user's own
        keeps its models where LocalCut cannot measure)."""
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        installer = INSTALLERS.get(program_id)
        if installer is None or not installer.serves:
            raise SetupUnavailable("program_not_supported", f"{program_id} has no models to pull")
        lock = self._locks.setdefault(program_id, asyncio.Lock())
        async with lock:
            if program_id in self._jobs:
                raise SetupBusy(f"{program_id} is already being set up")
            model = model or await self._model_for(installer)
            if not model:
                raise SetupUnavailable("program_not_supported", "there is no model to pull")
            url = self.config.llm_url
            if await installer.identify(url) != "self":
                raise NoServer(
                    f"no {program_id} answers at {url}; set it up, or start your own, "
                    "and pull again"
                )
            names = await ollama.listed_models(url)
            if names is not None and ollama.lists_model(names, model):
                return {"status": "present", "model": model}
            ours = installer.in_use(self.config)
            store = ollama.model_store(self.config) if ours else None
            if store is not None:
                need = installer.pull_bytes(self.config, model)
                free = await asyncio.to_thread(_free_at, store)
                if need and free < need:
                    raise NotEnoughSpace(
                        f"{model} needs about {need} bytes free in {store}, and {free} are free",
                        need=need,
                        free=free,
                    )
            job = self._open_job(program_id, "pulling", 0)
            job.task = asyncio.get_running_loop().create_task(
                self._run_pull(job, url, model, store), name=f"pull-{program_id}"
            )
            return {"status": "started", "job": job.id, "model": model}

    async def start_server(self, program_id: str) -> dict:
        """Start LocalCut's copy of a server program, and wait until it
        answers or gives up. Returns its state. Raises KeyError for an
        unknown program, and SetupUnavailable for one that is not a server
        or has no copy to start here."""
        server = self._server_of(program_id)
        if not server.start():
            raise SetupUnavailable(
                "program_not_supported", f"LocalCut has no copy of {program_id} to start here"
            )
        await server.settled()
        return server.describe()

    async def stop_server(self, program_id: str) -> dict:
        """Stop LocalCut's copy of a server program. It stays stopped until
        it is started again, or the engine restarts. Raises ProgramInUse
        while a render is using it."""
        server = self._server_of(program_id)
        if server.serving and self.render_uses(program_id):
            raise ProgramInUse(
                f"a render is using LocalCut's {program_id}; wait for it to finish, "
                "or cancel it, and stop it then"
            )
        await server.stop()
        return server.describe()

    def _server_of(self, program_id: str):  # noqa: ANN202 - server.ManagedServer
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        server = self.servers.get(program_id) if self.servers is not None else None
        if server is None:
            raise SetupUnavailable(
                "program_not_supported", f"LocalCut does not run {program_id} as a server"
            )
        return server

    def _open_job(self, program_id: str, phase: str, total: int) -> _Job:
        job = _Job(id=secrets.token_hex(6), program=program_id, phase=phase, total=total)
        self._jobs[program_id] = job
        self._last.pop(program_id, None)
        return job

    async def _model_for(self, installer) -> str | None:  # noqa: ANN001 - an installer
        """The model a setup of this program pulls, for one that has models."""
        if not installer.serves or self.script_model is None:
            return None
        return await asyncio.to_thread(self.script_model)

    async def _left_to_do(self, installer, model: str | None) -> bool:  # noqa: ANN001
        """Whether a copy that is already the pinned build still has to be
        started, or still lacks the model. Not when a server of the user's
        own answers at the address: LocalCut uses that one, and a setup
        leaves it alone."""
        server = self.servers.get(installer.program) if self.servers is not None else None
        if not installer.serves or server is None or not installer.takes_effect(self.config):
            return False
        if not server.serving and await installer.identify(self.config.llm_url) == "self":
            return False
        if not server.serving:
            return True
        return model is not None and installer.model_to_pull(self.config, model) is not None

    def _check_space(self, program_id: str, asset: ProgramAsset, pull: int) -> None:
        """The download and the unpacked copy, at once, on the programs
        disk, and the model the setup pulls on the disk that keeps models.
        Raises NotEnoughSpace with the first that does not fit."""
        self.config.programs_dir.mkdir(parents=True, exist_ok=True)
        need = asset.size + asset.install_bytes
        store = ollama.model_store(self.config) if pull else None
        if store is not None:
            store.mkdir(parents=True, exist_ok=True)
            if os.stat(store).st_dev == os.stat(self.config.programs_dir).st_dev:
                need, store = need + pull, None
        free = shutil.disk_usage(self.config.programs_dir).free
        if free < need:
            raise NotEnoughSpace(
                f"setting up {program_id} needs {need} bytes free in "
                f"{self.config.programs_dir} for the download, the unpacked copy"
                + (" and the model" if pull and store is None else "")
                + f" at once, and {free} are free",
                need=need,
                free=free,
            )
        if store is not None:
            free = shutil.disk_usage(store).free
            if free < pull:
                raise NotEnoughSpace(
                    f"the model needs about {pull} bytes free in {store}, and {free} are free",
                    need=pull,
                    free=free,
                )

    def cancel(self, program_id: str) -> None:
        """Stop a running setup; everything it wrote is removed. Raises
        KeyError for an unknown program and SetupNotRunning when there is no
        setup to stop, or it is already moving the copy into place."""
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        job = self._jobs.get(program_id)
        if job is None or job.task is None or job.task.done():
            raise SetupNotRunning(f"{program_id} is not being set up")
        if not job.cancellable:
            raise SetupNotRunning(f"{program_id} is being moved into place and will finish")
        job.task.cancel()

    async def remove(self, program_id: str) -> int:
        """Remove LocalCut's own copy of a program, and nothing else: an
        install of the user's, on PATH, in <data_dir>/bin or at a configured
        path, is never touched. Returns the bytes freed, 0 when there was no
        copy. The engine uses the next program it finds from then on.

        Raises KeyError for an unknown program, SetupBusy while a setup of it
        runs, and ProgramInUse when a render is running it or another
        process holds one of its files open (Windows will not move a folder
        then)."""
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        lock = self._locks.setdefault(program_id, asyncio.Lock())
        async with lock:
            if program_id in self._jobs:
                raise SetupBusy(f"{program_id} is being set up; cancel the setup first")
            folder = self.folder(program_id)
            if not folder.exists():
                return 0
            installer = INSTALLERS.get(program_id)
            if installer is not None and installer.in_use(self.config):
                if self.render_uses(program_id):
                    raise ProgramInUse(
                        f"a render is using LocalCut's {program_id}; wait for it to finish, "
                        "or cancel it, and remove it then"
                    )
            # A running copy holds its own files open, and Windows will not
            # move a folder with an open file in it.
            server = self.servers.get(program_id) if self.servers is not None else None
            was_serving = server is not None and server.serving
            if server is not None:
                await server.stop(reason=None)
            try:
                freed = await asyncio.to_thread(self._take_away, folder)
            except ProgramInUse:
                if was_serving:
                    server.start()
                raise
        self.events.publish("program.removed", program=program_id, freed_bytes=freed)
        return freed

    def _take_away(self, folder: Path) -> int:
        size = storage._dir_size(folder)
        aside = folder.with_name(f".removing-{folder.name}-{secrets.token_hex(4)}")
        try:
            _replace_retrying(folder, aside, budget_s=_REMOVE_BUDGET_S)
        except PermissionError as exc:
            raise ProgramInUse(
                f"another process has a file in {folder} open; close it and try again"
            ) from exc
        # The folder is gone from where the engine looks. Deleting what it
        # held can fail on a file another process still has open, and the
        # sweep at the next start finishes it then.
        _remove_tree(aside)
        return size

    def sweep(self) -> None:
        """Clear what an interrupted setup or removal left in the programs
        folder. Called once at startup, before any setup can begin. A copy
        moved aside by a replacement that stopped before its new copy was in
        place goes back where it was."""
        root = self.config.programs_dir
        if not root.is_dir():
            return
        for entry in sorted(root.iterdir()):
            name = entry.name
            if name.startswith((".setup-", ".removing-")):
                _remove_tree(entry)
            elif name.startswith(".old-"):
                program = name.removeprefix(".old-").rpartition("-")[0]
                live = root / program
                if program in PROGRAM_IDS and not live.exists():
                    os.replace(entry, live)
                    logger.info("put back %s, which an interrupted setup had moved aside", live)
                else:
                    _remove_tree(entry)

    async def shutdown(self) -> None:
        tasks = [job.task for job in self._jobs.values() if job.task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- progress ------------------------------------------------------------

    def _phase(self, job: _Job, phase: str, total: int, done: int = 0) -> None:
        job.phase, job.total, job.done = phase, total, done
        job._samples.clear()
        # Where the phase starts is the first sample: the speed is measured
        # from there until the window has filled.
        job.sample(time.monotonic())
        self._emit(job)

    def _progress(self, job: _Job, done: int) -> None:
        job.done = done
        now = time.monotonic()
        job.sample(now)
        if now - job._last_emit >= _PROGRESS_INTERVAL_S:
            self._emit(job)

    def _emit(self, job: _Job) -> None:
        job._last_emit = time.monotonic()
        self.events.publish("program.setup.progress", program=job.program, **_progress_payload(job))

    def _finish(self, job: _Job, outcome: str, **detail) -> None:
        # Bookkeeping clears BEFORE the terminal event goes out: a client that
        # refetches GET /programs on the event must not see a setup running.
        self._jobs.pop(job.program, None)
        self._last[job.program] = {
            "job": job.id,
            "outcome": outcome,
            "reason": detail.get("reason"),
            "error": detail.get("error"),
        }

    # -- the run -------------------------------------------------------------

    async def _run(self, job: _Job, pin: ProgramPin, asset: ProgramAsset) -> None:
        installer = INSTALLERS[job.program]
        scratch = self.config.programs_dir / f".setup-{job.program}-{job.id}"
        live = self.folder(job.program)
        try:
            self._phase(job, "downloading", asset.size)
            archive = await self._download(job, asset, scratch)
            staged = scratch / job.program
            self._phase(job, "unpacking", asset.install_bytes)
            await self._unpack(job, asset, archive, staged)
            await asyncio.to_thread(archive.unlink)
            self._phase(job, "checking", 0)
            facts = await installer.check(staged)
            await asyncio.to_thread(_write_record, staged, pin, asset)
            job.cancellable = False
            self._phase(job, "installing", 0)
            server = self._server_for(installer)
            # The running copy is stopped before its folder is replaced: it
            # holds its own files open, and the new build is the one to run.
            stopped = server is not None and server.serving
            if server is not None:
                await server.stop(reason=None)
            move = asyncio.ensure_future(asyncio.to_thread(_move_into_place, staged, live))
            try:
                await asyncio.shield(move)
            except asyncio.CancelledError:
                # Only a shutdown cancels this phase. It waits for the renames,
                # so the copy is either in place or where it was, and the
                # scratch folder is not removed while one is moving out of it.
                with contextlib.suppress(Exception):
                    await move
                raise
            except Exception:
                if stopped:
                    server.start()
                raise
            await asyncio.to_thread(_remove_tree, scratch)
            if installer.serves:
                job.cancellable = True
                facts |= await self._serve_and_pull(job, installer)
        except asyncio.CancelledError:
            await asyncio.shield(asyncio.to_thread(_remove_tree, scratch))
            self._finish(job, "cancelled")
            self.events.publish("program.setup.cancelled", program=job.program)
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is reported, none escapes
            await asyncio.to_thread(_remove_tree, scratch)
            self._fail(job, exc, pin)
            return
        await asyncio.to_thread(_remove_tree, scratch)
        self._finish(job, "done")
        self.events.publish(
            "program.setup.done",
            program=job.program,
            version=pin.version,
            location=str(installer.binary(self.config)),
            in_use=installer.in_use(self.config),
            draws_text=facts.get("draws_text"),
            # The model it pulled, for a program that serves one.
            **({"model": facts.get("model")} if installer.serves else {}),
        )

    async def _run_server_phases(self, job: _Job, pin: ProgramPin, installer) -> None:  # noqa: ANN001
        """A setup of a copy that is the pinned build already: start it if
        it is not running, and pull the model it lacks."""
        try:
            facts = await self._serve_and_pull(job, installer)
        except asyncio.CancelledError:
            self._finish(job, "cancelled")
            self.events.publish("program.setup.cancelled", program=job.program)
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is reported, none escapes
            self._fail(job, exc, pin)
            return
        self._finish(job, "done")
        self.events.publish(
            "program.setup.done",
            program=job.program,
            version=pin.version,
            location=str(installer.binary(self.config)),
            in_use=installer.in_use(self.config),
            draws_text=None,
            model=facts.get("model"),
        )

    async def _run_pull(self, job: _Job, url: str, model: str, store: Path | None) -> None:
        """A pull on its own, through the server at `url`."""
        pin = program_manifest.load_programs_manifest().program(job.program)
        try:
            self._phase(job, "pulling", 0)
            await self._pull(job, url, model, store)
        except asyncio.CancelledError:
            self._finish(job, "cancelled")
            self.events.publish("program.setup.cancelled", program=job.program)
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is reported, none escapes
            self._fail(job, exc, pin)
            return
        self._finish(job, "done")
        self.events.publish(
            "program.setup.done",
            program=job.program,
            version=None,
            location=url,
            in_use=INSTALLERS[job.program].in_use(self.config),
            draws_text=None,
            model=model,
        )

    def _fail(self, job: _Job, exc: BaseException, pin: ProgramPin | None) -> None:
        reason, message = _failure(exc, job.phase, pin)
        logger.warning("setup of %s failed (%s): %s", job.program, reason, message)
        self._finish(job, "failed", reason=reason, error=message)
        self.events.publish(
            "program.setup.failed", program=job.program, reason=reason, error=message
        )

    def _server_for(self, installer):  # noqa: ANN001, ANN202 - server.ManagedServer | None
        if not installer.serves or self.servers is None:
            return None
        return self.servers.get(installer.program)

    async def _serve_and_pull(self, job: _Job, installer) -> dict:  # noqa: ANN001
        """The phases of a server program after it is in place: start
        LocalCut's copy and wait for it to answer, then pull the model
        scripts are written with into it, if its store lacks it. A server of
        the user's own already at the address is left alone, and so is its
        store."""
        server = self._server_for(installer)
        if server is None or not installer.takes_effect(self.config):
            return {}
        if not server.serving:
            if await installer.identify(self.config.llm_url) == "self":
                return {}
            self._phase(job, "starting", 0)
            server.start()
        elif server.state == "starting" and job.phase != "starting":
            self._phase(job, "starting", 0)
        if await server.settled() != "running":
            raise SetupFailed(
                "did_not_start",
                f"LocalCut's {job.program} did not start ({server.reason})"
                + (f": {server.error}" if server.error else ""),
            )
        model = await self._model_for(installer)
        if model and installer.model_to_pull(self.config, model) is not None:
            await self._pull(job, server.url, model, ollama.model_store(self.config))
        return {"model": model}

    async def _pull(self, job: _Job, url: str, model: str, store: Path | None) -> None:
        if job.phase != "pulling":
            self._phase(job, "pulling", 0)

        def progress(done: int, total: int) -> None:
            job.total = total
            self._progress(job, done)

        try:
            await ollama.pull(url, model, progress, store=store)
        except ollama.PullNoSpace as exc:
            raise SetupFailed("no_space", f"{model} does not fit: {exc}") from exc
        except ollama.PullFailed as exc:
            raise SetupFailed("pull_failed", f"Ollama could not pull {model}: {exc}") from exc
        except httpx.HTTPError as exc:
            raise SetupFailed(
                "pull_failed",
                f"the pull of {model} stopped: {str(exc) or type(exc).__name__}",
            ) from exc

    async def _download(self, job: _Job, asset: ProgramAsset, scratch: Path) -> Path:
        name = asset.url.rsplit("/", 1)[-1]
        if not name or name.startswith(".") or not all(c.isalnum() or c in "._-" for c in name):
            name = f"{job.program}-download"
        target = ModelFile(url=asset.url, dest=name, sha256=asset.sha256, size=asset.size)

        async def progress(dest: str, done: int, total: int) -> None:
            self._progress(job, done)
            if done >= asset.size and job.phase == "downloading":
                # The whole download is in; hashing it is what comes next.
                self._phase(job, "verifying", asset.size, asset.size)

        # No follow_redirects: download_file walks the redirects itself, so
        # the guard sees every hop (GitHub hands a release asset to its CDN).
        timeout = httpx.Timeout(30, read=_READ_TIMEOUT_S)
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await downloads.download_file_retrying(
                target, scratch, progress, client, exact_size=True
            )

    async def _unpack(self, job: _Job, asset: ProgramAsset, archive: Path, staged: Path) -> None:
        loop = asyncio.get_running_loop()
        stop = threading.Event()

        def report(done: int) -> None:
            loop.call_soon_threadsafe(self._progress, job, done)

        work = loop.run_in_executor(
            None, functools.partial(_unpack_files, archive, asset, staged, report, stop)
        )
        try:
            await asyncio.shield(work)
        except asyncio.CancelledError:
            # The thread is told to stop and waited for, so nothing is still
            # writing into the scratch folder when it is removed.
            stop.set()
            with contextlib.suppress(Exception):
                await work
            raise


def _free_at(path: Path) -> int:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free


def _progress_payload(job: _Job) -> dict:
    described = job.describe()
    return {key: described[key] for key in ("phase", "done", "total", "bytes_per_s")}


def _failure(exc: BaseException, phase: str, pin: ProgramPin | None) -> tuple[str, str]:
    """(reason, message) for whatever stopped a setup."""
    if isinstance(exc, SetupFailed):
        return exc.reason, str(exc)
    if pin is None:
        return _REASON_BY_PHASE.get(phase, "install_failed"), str(exc) or type(exc).__name__
    if isinstance(exc, downloads.SizeMismatch):
        if exc.actual > exc.expected:
            said = f"ran past the {exc.expected} bytes pinned"
        else:
            said = f"ended at {exc.actual} of the {exc.expected} bytes pinned"
        return "size_mismatch", f"the download {said} for {pin.id} {pin.version}"
    if isinstance(exc, downloads.ChecksumMismatch):
        return (
            "checksum_mismatch",
            f"the download's SHA-256 is {exc.actual}, and the pin for {pin.id} {pin.version} "
            f"is {exc.expected}",
        )
    if isinstance(exc, downloads.UnexpectedStatus) and exc.gone:
        return (
            "download_gone",
            f"the build pinned for {pin.id} {pin.version} is no longer at {exc.url} "
            f"(HTTP {exc.status})",
        )
    if isinstance(exc, OSError) and exc.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)):
        return "no_space", f"the disk filled up while setting up {pin.id}: {exc}"
    if isinstance(exc, (downloads.DownloadError, httpx.HTTPError)):
        return "download_failed", str(exc) or type(exc).__name__
    return _REASON_BY_PHASE.get(phase, "install_failed"), str(exc) or type(exc).__name__


# -- the file work, on worker threads -------------------------------------------


def _unpack_files(
    archive: Path,
    asset: ProgramAsset,
    folder: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Write the files the pin keeps into `folder`, and nothing else.

    A member is found by its exact name and written under the pin's bare
    file name, so a name in the archive never becomes a path here. Each
    file is held to its pinned size, flushed to disk, and made executable
    where that is a bit."""
    folder.mkdir(parents=True)
    written = 0

    def copy(source: IO[bytes], kept: KeptFile) -> None:
        nonlocal written
        count = 0
        target = folder.joinpath(*kept.path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as sink:
            while chunk := source.read(_CHUNK):
                if stop.is_set():
                    raise _Stopped
                count += len(chunk)
                if count > kept.size:
                    raise SetupFailed(
                        "unpack_failed",
                        f"{kept.member} is larger than the {kept.size} bytes pinned",
                    )
                sink.write(chunk)
                written += len(chunk)
                report(written)
            sink.flush()
            os.fsync(sink.fileno())
        if count != kept.size:
            raise SetupFailed(
                "unpack_failed", f"{kept.member} is {count} bytes, and the pin says {kept.size}"
            )
        if os.name != "nt":
            target.chmod(0o755)

    try:
        if asset.format == "zip":
            with zipfile.ZipFile(archive) as unzipped:
                for kept in asset.files:
                    try:
                        info = unzipped.getinfo(kept.member)
                    except KeyError:
                        raise SetupFailed(
                            "unpack_failed", f"the archive has no {kept.member}"
                        ) from None
                    if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
                        raise SetupFailed("unpack_failed", f"{kept.member} is not a plain file")
                    with unzipped.open(info) as source:
                        copy(source, kept)
            return
        wanted = {kept.member: kept for kept in asset.files}
        found: set[str] = set()
        # One pass, in archive order: an xz or zstd stream cannot be read
        # backwards without decompressing it again from the start.
        mode = "r:xz" if asset.format == "tar.xz" else "r:zst"
        with tarfile.open(archive, mode) as untarred:
            for member in untarred:
                if stop.is_set():
                    raise _Stopped
                kept = wanted.get(member.name)
                if kept is None or member.name in found:
                    continue
                if not member.isreg():
                    raise SetupFailed("unpack_failed", f"{member.name} is not a plain file")
                source = untarred.extractfile(member)
                if source is None:
                    raise SetupFailed("unpack_failed", f"{member.name} could not be read")
                copy(source, kept)
                found.add(member.name)
                if len(found) == len(wanted):
                    break
        missing = [member for member in wanted if member not in found]
        if missing:
            raise SetupFailed("unpack_failed", f"the archive has no {missing[0]}")
    except (zipfile.BadZipFile, tarfile.TarError, lzma.LZMAError, *_ZSTD_ERRORS, EOFError) as exc:
        raise SetupFailed("unpack_failed", f"the archive cannot be read: {exc}") from exc


def _write_record(folder: Path, pin: ProgramPin, asset: ProgramAsset) -> None:
    """What this copy is, kept beside it: the report reads the version back,
    and a later setup tells a whole, current copy from one to replace."""
    record = {
        "format": RECORD_VERSION,
        "program": pin.id,
        "version": pin.version,
        "platform": asset.platform,
        "gpu": asset.gpu,
        "url": asset.url,
        "sha256": asset.sha256,
        "files": {kept.path: kept.size for kept in asset.files},
    }
    _write_atomic(folder / RECORD, json.dumps(record, indent=2))


def _move_into_place(staged: Path, live: Path) -> None:
    """Rename the staged folder to its place, whole. An existing copy is
    moved aside first and removed after, and put back if the new one cannot
    take its place."""
    aside = None
    if live.exists():
        aside = live.with_name(f".old-{live.name}-{secrets.token_hex(4)}")
        try:
            _replace_retrying(live, aside, budget_s=_RENAME_BUDGET_S)
        except PermissionError as exc:
            raise SetupFailed(
                "in_use",
                f"another process has a file in {live} open, so it cannot be replaced; "
                "close it and set it up again",
            ) from exc
    try:
        _replace_retrying(staged, live, budget_s=_RENAME_BUDGET_S)
    except BaseException:
        if aside is not None:
            with contextlib.suppress(OSError):
                os.replace(aside, live)
        raise
    if aside is not None:
        _remove_tree(aside)


def _replace_retrying(source: Path, target: Path, *, budget_s: float) -> None:
    """os.replace, retried while Windows says a file in the way is open
    (PermissionError), for up to `budget_s`. A rename that did not happen
    did not happen at all, so trying again is safe."""
    deadline = time.monotonic() + budget_s
    pause = 0.05
    while True:
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(pause)
            pause = min(pause * 2, 1.0)


def _remove_tree(path: Path) -> None:
    """Remove a folder, retrying briefly while a file in it is still open (a
    hash or a scan finishing on Windows). Gives up quietly: what is left is a
    dot-folder the sweep at the next start removes."""
    deadline = time.monotonic() + _REMOVE_BUDGET_S
    while True:
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            if time.monotonic() >= deadline:
                logger.warning("could not remove %s yet (%s); it goes at the next start", path, exc)
                return
            time.sleep(0.1)
