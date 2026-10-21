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
   archive holds). A program kept as a whole tree (ComfyUI) comes from a 7z
   archive, which a pinned 7-Zip extractor unpacks after its listing has
   been checked against the pin (sevenzip.py); the extractor is downloaded
   in the first phase, beside the archive;
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

One setup per program at a time. Nothing a client sends names what is
fetched: the pin is the only source. Where a program pins more than one
build for this machine's card (builds.py), a client may ask for another of
those by name and for nothing else.

What a setup needs to know about one program in particular (which files it
must keep, how to tell the copy works, whether the engine would use it) is
that program's installer: FFmpeg, Ollama and ComfyUI. Another program is
a pin in programs-manifest.json plus an installer here.
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
from ..hardware.probe import GPU, known_profile, machine_profile
from ..manifest import downloads
from ..manifest.model import ModelFile
from ..project.store import _write_atomic
from . import PROGRAM_IDS, builds, comfyui, environment, ollama, sevenzip
from . import manifest as program_manifest
from . import server as managed_server
from .manifest import ExtractorPin, KeptFile, ProgramAsset, ProgramPin, RuntimePin, link_target
from .server import ManagedServers, ServerLaunch

logger = logging.getLogger(__name__)

try:
    from compression import zstd as _zstd

    _ZSTD_ERRORS: tuple[type[Exception], ...] = (_zstd.ZstdError,)
except ImportError:  # Python 3.13
    _ZSTD_ERRORS = ()

#: What LocalCut writes beside a program's files: which build it is and
#: how much disk it took when it was put there.
RECORD = "program.json"
#: The newest record format this engine reads.
RECORD_VERSION = 1
# How long the device check may take: the first import of PyTorch reads a few
# gigabytes of libraries and a virus scanner looks at each one first.
_DEVICE_CHECK_TIMEOUT_S = 600.0

# How many of an environment's wheels download at once.
_WHEELS_AT_ONCE = 4

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
# The phases whose progress is bytes moving and so has a speed: the download
# and the pull and the unpack, which for a tree of tens of thousands of
# files takes minutes of its own.
_TRANSFERS = ("downloading", "unpacking", "pulling")


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

    async def check(self, folder: Path, asset: ProgramAsset | None = None) -> dict:
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

    def command(self, binary: Path) -> list[str]:
        """How the server is run from `binary`."""
        return [str(binary), "serve"]

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
            **ollama.OFFLINE,
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
        profile = known_profile(str(config.data_dir))
        environment.update(ollama.gpu_environment(profile.gpus if profile is not None else []))
        Path(environment["HOME"]).mkdir(parents=True, exist_ok=True)
        return ServerLaunch(
            argv=self.command(binary),
            env=environment,
            cwd=binary.parent,
            url=f"http://{host if ':' not in host else f'[{host}]'}:{port}",
            host=host,
            port=port,
        )

    async def identify(self, url: str):  # noqa: ANN201 - server.Identity
        return await ollama.identify(url)

    def url(self, config: EngineConfig) -> str:
        """The address the engine asks for it."""
        return config.llm_url

    async def prepare(self, config: EngineConfig) -> None:
        """Probe the hardware, once per engine, before the copy's first
        start: which cards the machine has decides how it is started. A
        probe that fails leaves the copy to start as Ollama would by
        itself."""
        try:
            await asyncio.to_thread(machine_profile, str(config.data_dir))
        except Exception:  # noqa: BLE001 - the copy starts either way
            logger.warning("could not probe the hardware before starting Ollama", exc_info=True)

    async def check(self, folder: Path, asset: ProgramAsset | None = None) -> dict:
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
            **ollama.OFFLINE,
        }
        options: dict[str, Any] = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        with (scratch / "serve.log").open("wb") as log:
            try:
                process = await asyncio.create_subprocess_exec(
                    *self.command(binary),
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
            await managed_server.stop_child(process)
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


def _free_port() -> int:
    """A loopback port nothing listens on now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ComfyUIInstaller:
    """ComfyUI as a setup sees it: a whole folder for the machine's GPU
    vendor, whose PyTorch has to be able to use the card before it replaces
    anything. On Windows that is the official portable build, unpacked from
    a 7z. On Linux it is built from pinned pieces (environment.py)."""

    program = "comfyui"
    serves = True
    #: ComfyUI imports PyTorch and every node before it answers. A first
    #: start on Windows, with a virus scanner looking at each new library,
    #: takes minutes rather than seconds. So does a first start on Linux,
    #: which compiles every module it imports.
    start_timeout_s = 600.0

    def fits(self, asset: ProgramAsset) -> bool:
        """Whether a pinned build is one LocalCut can start: a portable
        build on Windows, where the embedded Python is a .exe, or on Linux
        an environment whose lock is the one pinned."""
        if asset.platform.startswith("windows"):
            return asset.tree is not None and asset.format == "7z"
        if asset.platform.startswith("linux"):
            return environment.lock_ok(asset)
        return False

    def takes_effect(self, config: EngineConfig) -> bool:
        """Whether LocalCut's copy could be the ComfyUI the engine renders
        with: its address is one a copy on this machine can listen on. An
        address on another machine is someone else's."""
        return comfyui.local_address(config.comfyui_url) is not None

    def in_use(self, config: EngineConfig) -> bool:
        """Whether LocalCut's copy is the server at the address, or is
        starting to be."""
        running = managed_server.find(config, self.program)
        return running is not None and running.serving

    def url(self, config: EngineConfig) -> str:
        """The address the engine asks for it."""
        return config.comfyui_url

    def launch(self, config: EngineConfig) -> ServerLaunch | None:
        """The copy's own command line, bound to the address the engine
        asks, with the file that points it at LocalCut's models written
        first, everything it writes while it runs in LocalCut's working
        folder and for the processor's build, told to run there. None
        without a copy here, or for an address on another machine."""
        address = comfyui.local_address(config.comfyui_url)
        folder = config.programs_dir / self.program
        if address is None or not comfyui.python_of(folder).is_file():
            return None
        host, port = address
        comfyui.write_model_paths(folder, config.resolved_models_dir)
        work = comfyui.make_working_folder(config)
        record = read_record(folder)
        cpu = record is not None and record.get("build") == "cpu"
        return ServerLaunch(
            argv=[
                *comfyui.server_argv(folder, host=host, port=port, cpu=cpu),
                *comfyui.working_argv(work),
            ],
            env={},
            cwd=folder,
            url=f"http://{host if ':' not in host else f'[{host}]'}:{port}",
            host=host,
            port=port,
        )

    async def identify(self, url: str):  # noqa: ANN201 - server.Identity
        return await comfyui.identify(url)

    def binary(self, config: EngineConfig) -> Path:
        """Where LocalCut's copy is, as the engine runs it: its Python."""
        return comfyui.python_of(config.programs_dir / self.program)

    async def check(self, folder: Path, asset: ProgramAsset | None = None) -> dict:
        """Have the unpacked build's own Python import its PyTorch and sum a
        few numbers on the card. A build whose PyTorch cannot use the card
        (a driver older than its CUDA needs, a card it has no kernels for)
        fails here, with nothing kept; one whose Python does not run at all
        fails as not running. The processor's build sums on the processor
        and says so: its `device` is "CPU"."""
        python = comfyui.python_of(folder)
        if asset is not None and asset.build == "cpu":
            vendor = "cpu"
        else:
            vendor = (asset.gpu if asset is not None else None) or "nvidia"
        try:
            process = await asyncio.create_subprocess_exec(
                str(python),
                *comfyui.python_flags(folder),
                "-c",
                comfyui.DEVICE_CHECK,
                vendor,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=folder,
            )
        except OSError as exc:
            raise SetupFailed("does_not_run", f"the ComfyUI it unpacked does not run: {exc}")
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), _DEVICE_CHECK_TIMEOUT_S)
        except TimeoutError:
            raise SetupFailed(
                "does_not_run",
                f"the ComfyUI it unpacked did not load PyTorch in {_DEVICE_CHECK_TIMEOUT_S:g}s",
            ) from None
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        answer = comfyui.device_answer(stdout.decode("utf-8", "replace"))
        if answer is None:
            said = sevenzip._last_line(stderr) or f"exit status {process.returncode}"
            raise SetupFailed("does_not_run", f"the ComfyUI it unpacked does not run: {said}")
        if answer["torch"] is None:
            raise SetupFailed(
                "does_not_run", f"the ComfyUI it unpacked cannot load PyTorch: {answer['error']}"
            )
        if answer["device"] is None and vendor == "cpu":
            raise SetupFailed(
                "does_not_run",
                f"PyTorch {answer['torch'] or ''} in this ComfyUI build does not compute on "
                f"the processor: {answer['error']}",
            )
        if answer["device"] is None:
            raise SetupFailed(
                "gpu_not_usable",
                f"PyTorch {answer['torch'] or ''} in this ComfyUI build cannot use the "
                f"graphics card: {answer['error']}",
            )
        return {"device": answer["device"]}


#: The programs LocalCut can set up, by id.
INSTALLERS: dict[str, Any] = {
    "ffmpeg": FFmpegInstaller(),
    "ollama": OllamaInstaller(),
    "comfyui": ComfyUIInstaller(),
}


def pinned(
    program_id: str, gpu: GPU | None = None, build: str | None = None
) -> tuple[ProgramPin | None, ProgramAsset | None, str | None]:
    """(pin, this machine's build, why there is none). The reason is one of
    SETUP_UNAVAILABLE when there is no build to set up here. `gpu` is the
    machine's main card, which picks the build of a program pinned per GPU
    vendor and `build` names one of that vendor's other builds."""
    installer = INSTALLERS.get(program_id)
    pin = program_manifest.load_programs_manifest().program(program_id)
    if installer is None or pin is None:
        return pin, None, "program_not_supported"
    platform_key = program_manifest.platform_key() or ""
    if not any(installer.fits(asset) for asset in pin.assets if asset.platform == platform_key):
        return pin, None, "platform_not_supported"
    asset = builds.choose(pin, platform_key, gpu, build)
    if asset is None and pin.per_vendor(platform_key):
        return pin, None, "gpu_not_supported"
    if asset is None or not installer.fits(asset) or not _readable(asset):
        return pin, None, "platform_not_supported"
    return pin, asset, None


def _readable(asset: ProgramAsset) -> bool:
    """Whether this Python can unpack the archive. zstd came to the standard
    library in 3.14; every engine LocalCut ships runs on 3.14, and one run
    from a source checkout on 3.13 sets up what it can read."""
    return asset.format != "tar.zst" or bool(_ZSTD_ERRORS)


def pinned_here(
    config: EngineConfig, program_id: str, gpu: GPU | None, build: str | None = None
) -> tuple[ProgramPin | None, ProgramAsset | None, str | None]:
    """`pinned`, for this engine: with no build asked for, a copy already
    set up from one of the vendor's other builds, or from the processor's,
    keeps that build. Someone who moved to the build for older drivers
    because the usual one could not use their card is not moved back by the
    next setup."""
    if build is None:
        record = read_record(config.programs_dir / program_id)
        if (
            record is not None
            and record.get("build") is not None
            and (record.get("gpu") == builds.vendor_of(gpu) or record.get("build") == "cpu")
        ):
            kept = pinned(program_id, gpu, record["build"])
            if kept[1] is not None:
                return kept
    return pinned(program_id, gpu, build)


def main_gpu(config: EngineConfig) -> GPU | None:
    """The machine's main card, as the hardware probe last found it, without
    probing: None before anything has asked (GET /system or /programs)."""
    profile = known_profile(str(config.data_dir))
    return profile.primary_gpu if profile is not None else None


async def probed_gpu(config: EngineConfig) -> GPU | None:
    """The machine's main card, probing once if nothing has yet."""
    profile = await asyncio.to_thread(machine_profile, str(config.data_dir))
    return profile.primary_gpu


def extractor_for(asset: ProgramAsset) -> ExtractorPin | None:
    """The extractor a setup downloads with this build, if its format needs
    one."""
    if asset.format != "7z":
        return None
    return program_manifest.load_programs_manifest().extractor(asset.format, asset.platform)


def runtime_for(asset: ProgramAsset) -> RuntimePin | None:
    """The Python a build made of pinned pieces runs on."""
    if asset.environment is None:
        return None
    return program_manifest.load_programs_manifest().runtime(
        asset.environment.runtime, asset.platform
    )


def download_bytes(asset: ProgramAsset) -> int:
    """Everything a setup of this build downloads: the archive and the
    extractor that unpacks it where Python cannot, or for a build made of
    pinned pieces, its source, its Python and its wheels."""
    extractor = extractor_for(asset)
    runtime = runtime_for(asset)
    total = asset.size + (extractor.size if extractor is not None else 0)
    if asset.environment is not None and runtime is not None:
        total += runtime.size + asset.environment.wheel_bytes
    return total


def _pieces(program_id: str, asset: ProgramAsset) -> list[ModelFile]:
    """What a setup of this build downloads, in order: the extractor and
    then the archive, or the runtime, the source and then each wheel."""
    extractor = extractor_for(asset)
    pieces = []
    if extractor is not None:
        pieces.append(
            ModelFile(
                url=extractor.url,
                dest=_file_name(extractor.url, "extractor"),
                sha256=extractor.sha256,
                size=extractor.size,
            )
        )
    if asset.environment is None:
        pieces.append(
            ModelFile(
                url=asset.url,
                dest=_file_name(asset.url, f"{program_id}-download"),
                sha256=asset.sha256,
                size=asset.size,
            )
        )
        return pieces
    runtime = runtime_for(asset)
    if runtime is None:
        raise SetupFailed("download_failed", f"no runtime is pinned for {program_id} here")
    lock = environment.load_lock(asset.environment)
    pieces.append(
        ModelFile(url=runtime.url, dest="python.tar.gz", sha256=runtime.sha256, size=runtime.size)
    )
    pieces.append(
        ModelFile(url=asset.url, dest="source.tar.gz", sha256=asset.sha256, size=asset.size)
    )
    # Numbered rather than named after the wheel: a name is the lock's to
    # say and a number is all the scratch folder needs.
    pieces.extend(
        ModelFile(
            url=wheel.url, dest=f"wheels/{index:04d}.whl", sha256=wheel.sha256, size=wheel.size
        )
        for index, wheel in enumerate(lock.wheels)
    )
    return pieces


def setup_fix(config: EngineConfig, program_id: str) -> dict | None:
    """The readiness fix that sets this program up, or None where it would
    change nothing: no build is pinned for this machine, something outranks
    LocalCut's copy, or that copy is already the one in use. Carries the
    download's size, for the button to show. A program whose build depends
    on the card is offered only once the card is known: where the
    processor's build is what a machine with no card gets, a card nobody has
    looked for yet is not the same as none."""
    installer = INSTALLERS.get(program_id)
    pin = program_manifest.load_programs_manifest().program(program_id)
    platform_key = program_manifest.platform_key()
    if (
        pin is not None
        and platform_key is not None
        and pin.per_vendor(platform_key)
        and known_profile(str(config.data_dir)) is None
    ):
        return None
    _, asset, _ = pinned_here(config, program_id, main_gpu(config))
    if installer is None or asset is None:
        return None
    if not installer.takes_effect(config) or installer.in_use(config):
        return None
    if installer.serves and is_current(config.programs_dir / program_id, asset):
        # Set up already, and not running: starting it is what it needs,
        # which is Settings > Programs' to offer, not a download.
        return None
    return {"type": "setup_program", "program": program_id, "size_bytes": download_bytes(asset)}


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


def installed_build(program_id: str, folder: Path) -> ProgramAsset | None:
    """The build pinned now for the line the copy in `folder` belongs to:
    the same platform, GPU vendor and build as its record says. What the
    copy is compared with to tell whether it is current, so a copy of the
    build for older drivers is not taken for an outdated usual build."""
    record = read_record(folder)
    if record is None:
        return None
    pin = program_manifest.load_programs_manifest().program(program_id)
    platform_key = program_manifest.platform_key()
    if pin is None or platform_key is None or record.get("platform") != platform_key:
        return None
    return next(
        (
            asset
            for asset in pin.assets
            if (asset.platform, asset.gpu, asset.build)
            == (platform_key, record.get("gpu"), record.get("build"))
        ),
        None,
    )


def installed_bytes(folder: Path) -> int:
    """The disk the copy in `folder` takes, as its record says it took when
    it was put there. Walking a tree of tens of thousands of files on every
    report would cost seconds; the record is one read. A copy whose record
    has no figure is walked."""
    record = read_record(folder)
    size = record.get("bytes") if record is not None else None
    if isinstance(size, int) and not isinstance(size, bool) and size >= 0:
        return size
    return storage._dir_size(folder)


def is_current(folder: Path, asset: ProgramAsset | None) -> bool:
    """Whether the copy in `folder` is the build pinned now, whole: its
    record names the pinned download, and every file kept from it is there
    at its pinned size. A tree has its record written last, before the
    whole folder is renamed into place, so a record is a whole tree."""
    if asset is None:
        return False
    record = read_record(folder)
    if record is None or record.get("sha256") != asset.sha256:
        return False
    if asset.environment is not None and record.get("lock_sha256") != asset.environment.lock_sha256:
        return False
    for kept in asset.files:
        target = folder.joinpath(*kept.path.split("/"))
        try:
            if kept.link is not None:
                if os.readlink(target) != kept.link:
                    return False
            elif target.stat().st_size != kept.size:
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
    #: Which of the vendor's builds it sets up (None for the usual one).
    build: str | None = None
    task: asyncio.Task | None = None
    # Cleared while the copy is being moved into place, which must finish
    # once it has started.
    cancellable: bool = True
    _samples: deque = field(default_factory=deque)
    _last_emit: float = 0.0

    def rate(self, now: float | None = None) -> int | None:
        """Bytes a second over the last few seconds of the download, the
        unpack or the pull: what arrived since the window began, over the
        time since. 0 while nothing arrives and None for the first half
        second, which is too little to measure and in the phases that
        count no bytes."""
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
            "build": self.build,
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
        # Set when the engine stops. Deleting a half-unpacked ComfyUI can take
        # longer than the desktop waits for the engine to exit, so a deletion
        # under way then stops between files and leaves the rest to the next
        # start's sweep.
        self._closing = threading.Event()

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

    async def start(self, program_id: str, build: str | None = None) -> dict:
        """Begin a setup. Returns {"status": "started", "job": id}, or
        {"status": "installed"} when LocalCut's copy is already the pinned
        build, whole. `build` asks for one of the other builds pinned for
        this machine's card instead of the one it would get. Raises KeyError
        for an unknown program and SetupUnavailable, SetupBusy,
        ProgramInUse or NotEnoughSpace when it will not start."""
        if program_id not in PROGRAM_IDS:
            raise KeyError(program_id)
        lock = self._locks.setdefault(program_id, asyncio.Lock())
        async with lock:
            if program_id in self._jobs:
                raise SetupBusy(f"{program_id} is already being set up")
            gpu = await self._gpu_for(program_id)
            pin, asset, unavailable = pinned_here(self.config, program_id, gpu, build)
            if asset is None or pin is None:
                where = program_manifest.platform_key() or "this machine"
                if build is not None and unavailable not in (
                    "program_not_supported",
                    "platform_not_supported",
                ):
                    raise SetupUnavailable(
                        unavailable or "gpu_not_supported",
                        f"LocalCut has no {build} build of {program_id} for this machine's "
                        "graphics card",
                    )
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
            job = self._open_job(program_id, "downloading", download_bytes(asset), asset.build)
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

    def _open_job(self, program_id: str, phase: str, total: int, build: str | None = None) -> _Job:
        job = _Job(
            id=secrets.token_hex(6), program=program_id, phase=phase, total=total, build=build
        )
        self._jobs[program_id] = job
        self._last.pop(program_id, None)
        return job

    async def _model_for(self, installer) -> str | None:  # noqa: ANN001 - an installer
        """The model a setup of this program pulls, for one that has models."""
        if not hasattr(installer, "model_to_pull") or self.script_model is None:
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
        if not server.serving and await installer.identify(installer.url(self.config)) == "self":
            return False
        if not server.serving:
            return True
        return model is not None and installer.model_to_pull(self.config, model) is not None

    def _check_space(self, program_id: str, asset: ProgramAsset, pull: int) -> None:
        """The download and the unpacked copy, at once, on the programs
        disk, and the model the setup pulls on the disk that keeps models.
        Raises NotEnoughSpace with the first that does not fit."""
        self.config.programs_dir.mkdir(parents=True, exist_ok=True)
        need = download_bytes(asset) + asset.install_bytes
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

    async def _gpu_for(self, program_id: str) -> GPU | None:
        """The machine's main card, where it picks this program's build;
        None, without probing, where the program has one build for all."""
        pin = program_manifest.load_programs_manifest().program(program_id)
        platform_key = program_manifest.platform_key()
        if pin is None or platform_key is None or not pin.per_vendor(platform_key):
            return None
        return await probed_gpu(self.config)

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
        size = storage._dir_size(sevenzip.long_path(folder))
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

    def sweep(self) -> list[Path]:
        """Clear what an interrupted setup or removal left in the programs
        folder. Called once at startup, before any setup can begin. A copy
        moved aside by a replacement that stopped before its new copy was in
        place goes back where it was.

        Returns the leftover folders, for `clear` to delete. Deleting them
        can take a while (a half-unpacked ComfyUI is tens of thousands of
        files) and none of them is anything the engine looks at, so the
        engine starts without waiting for it."""
        root = self.config.programs_dir
        if not root.is_dir():
            return []
        leftovers = []
        for entry in sorted(root.iterdir()):
            name = entry.name
            if name.startswith((".setup-", ".removing-")):
                leftovers.append(entry)
            elif name.startswith(".old-"):
                program = name.removeprefix(".old-").rpartition("-")[0]
                live = root / program
                if program in PROGRAM_IDS and not live.exists():
                    os.replace(entry, live)
                    logger.info("put back %s, which an interrupted setup had moved aside", live)
                else:
                    leftovers.append(entry)
        return leftovers

    def clear(self, leftovers: list[Path]) -> None:
        """Delete what `sweep` found. Each is a dot-folder of a setup that no
        longer runs, so a new setup, which gets a folder of its own, can
        start while this works."""
        for entry in leftovers:
            if self._closing.is_set():
                return
            _remove_tree(entry, self._closing)

    async def shutdown(self) -> None:
        self._closing.set()
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
            "build": job.build,
        }

    # -- the run -------------------------------------------------------------

    async def _run(self, job: _Job, pin: ProgramPin, asset: ProgramAsset) -> None:
        installer = INSTALLERS[job.program]
        scratch = self.config.programs_dir / f".setup-{job.program}-{job.id}"
        live = self.folder(job.program)
        try:
            pieces = _pieces(job.program, asset)
            self._phase(job, "downloading", download_bytes(asset))
            # One at a time for a build and its extractor, the small one
            # first, so a refused extractor costs seconds rather than the
            # archive's whole download. An environment's wheels a few at a
            # time: most of them are small and one after another each would
            # wait out its own round trips.
            paths = await self._download_all(
                job, pieces, scratch, at_once=_WHEELS_AT_ONCE if asset.environment else 1
            )
            extractor = paths[0] if extractor_for(asset) is not None else None
            if extractor is not None and os.name != "nt":
                await asyncio.to_thread(extractor.chmod, 0o755)
            staged = scratch / job.program
            self._phase(job, "unpacking", asset.install_bytes)
            await self._unpack(job, asset, paths, staged, extractor)
            for path in paths:
                await asyncio.to_thread(path.unlink, missing_ok=True)
            self._phase(job, "checking", 0)
            facts = await installer.check(staged, asset)
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
            await asyncio.shield(asyncio.to_thread(_remove_tree, scratch, self._closing))
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
            # The model it pulled, for a program that serves one and the
            # card ComfyUI's PyTorch found.
            **({"model": facts.get("model")} if hasattr(installer, "model_to_pull") else {}),
            **({"device": facts["device"]} if "device" in facts else {}),
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
            **({"model": facts.get("model")} if hasattr(installer, "model_to_pull") else {}),
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
            if await installer.identify(installer.url(self.config)) == "self":
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

    async def _download_all(
        self, job: _Job, pieces: list[ModelFile], scratch: Path, *, at_once: int
    ) -> list[Path]:
        """Every file of the setup's download, `at_once` at a time, each held
        to its size and digest through the retry policy model downloads use,
        with their bytes counted together on the job. Once the last byte is
        in, the job moves to verifying while the last digests are taken."""
        done = [0] * len(pieces)
        total = sum(piece.size for piece in pieces)

        def counted(index: int):  # noqa: ANN202 - a downloads.ProgressFn
            async def progress(dest: str, got: int, size: int) -> None:
                done[index] = got
                arrived = sum(done)
                self._progress(job, arrived)
                if arrived >= total and job.phase == "downloading":
                    # The whole download is in; hashing it is what comes next.
                    self._phase(job, "verifying", job.total, job.total)

            return progress

        # No follow_redirects: download_file walks the redirects itself, so
        # the guard sees every hop (GitHub hands a release asset to its CDN).
        timeout = httpx.Timeout(30, read=_READ_TIMEOUT_S)
        async with httpx.AsyncClient(timeout=timeout) as client:

            async def fetch(index: int) -> Path:
                return await downloads.download_file_retrying(
                    pieces[index], scratch, counted(index), client, exact_size=True
                )

            if at_once <= 1:
                return [await fetch(index) for index in range(len(pieces))]
            gate = asyncio.Semaphore(at_once)

            async def gated(index: int) -> Path:
                async with gate:
                    return await fetch(index)

            try:
                async with asyncio.TaskGroup() as group:
                    tasks = [group.create_task(gated(index)) for index in range(len(pieces))]
            except BaseExceptionGroup as failed:
                # The first failure is the setup's; the rest were cancelled
                # by it or failed the same way.
                raise failed.exceptions[0] from None
            return [task.result() for task in tasks]

    async def _unpack(
        self,
        job: _Job,
        asset: ProgramAsset,
        paths: list[Path],
        staged: Path,
        extractor: Path | None,
    ) -> None:
        loop = asyncio.get_running_loop()
        stop = threading.Event()
        archive = paths[1] if extractor is not None else paths[0]

        def report(done: int) -> None:
            loop.call_soon_threadsafe(self._progress, job, done)

        if asset.environment is not None:
            runtime = runtime_for(asset)
            assert runtime is not None
            pieces = environment.Downloads(runtime=paths[0], source=paths[1], wheels=paths[2:])
            unpack = functools.partial(
                _unpack_environment, asset, runtime, pieces, staged, report, stop
            )
        elif asset.tree is not None:
            if extractor is None:
                raise SetupFailed(
                    "unpack_failed", f"no extractor is pinned for {asset.format} on this machine"
                )
            unpack = functools.partial(
                _unpack_tree, archive, asset, extractor, staged, report, stop
            )
        else:
            unpack = functools.partial(_unpack_files, archive, asset, staged, report, stop)
        work = loop.run_in_executor(None, unpack)
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

    def link(member: tarfile.TarInfo, kept: KeptFile) -> None:
        # Made from the pin, never from the archive: the member has to be a
        # link saying the same, and the pin only names a file kept beside it.
        if not member.issym() or link_target(member.linkname) != kept.link:
            raise SetupFailed("unpack_failed", f"{member.name} is not the link the pin names")
        target = folder.joinpath(*kept.path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(kept.link, target)

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
                if kept.link is not None:
                    link(member, kept)
                    found.add(member.name)
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


def _unpack_tree(
    archive: Path,
    asset: ProgramAsset,
    extractor: Path,
    folder: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Unpack the whole archive with the extractor and make its top folder
    `folder`: listed and checked against the pin first, walked and checked
    again after (sevenzip.py). It is unpacked straight into the scratch
    folder, beside the archive, which keeps the paths inside it as short as
    they can be on the way: Windows refuses a path past 260 characters to a
    program not built for longer ones."""
    tree = asset.tree
    assert tree is not None
    scratch = folder.parent
    try:
        members = sevenzip.list_members(extractor, archive)
        sevenzip.check_members(members, tree)
        if stop.is_set():
            raise _Stopped
        sevenzip.extract(
            extractor,
            archive,
            scratch,
            report=lambda percent: report(tree.bytes * percent // 100),
            stop=stop,
        )
        root = scratch / tree.root
        sevenzip.verify_tree(root, tree)
        report(tree.bytes)
        # A virus scanner looking at the new files holds them open and
        # Windows will not rename a folder while it does.
        _replace_retrying(root, folder, budget_s=_RENAME_BUDGET_S)
    except sevenzip.Stopped:
        raise _Stopped from None
    except sevenzip.ArchiveRefused as exc:
        raise SetupFailed("unpack_failed", str(exc)) from exc


def _unpack_environment(
    asset: ProgramAsset,
    runtime: RuntimePin,
    pieces: environment.Downloads,
    folder: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Build the copy from its runtime, its source and its wheels
    (environment.py), checked against the pin as it goes and walked after."""
    assert asset.environment is not None
    try:
        lock = environment.load_lock(asset.environment)
        environment.unpack(asset, runtime, lock, pieces, folder, report, stop)
    except sevenzip.Stopped:
        raise _Stopped from None
    except (sevenzip.ArchiveRefused, environment.LockRefused) as exc:
        raise SetupFailed("unpack_failed", str(exc)) from exc


def _file_name(url: str, fallback: str) -> str:
    """The name a download is kept under in the scratch folder: the URL's
    own last segment, where that is a plain file name."""
    name = url.rsplit("/", 1)[-1]
    if not name or name.startswith(".") or not all(c.isalnum() or c in "._-" for c in name):
        return fallback
    return name


def _write_record(folder: Path, pin: ProgramPin, asset: ProgramAsset) -> None:
    """What this copy is, kept beside it: the report reads the version and
    the size back and a later setup tells a whole, current copy from one to
    replace."""
    record = {
        "format": RECORD_VERSION,
        "program": pin.id,
        "version": pin.version,
        "platform": asset.platform,
        "gpu": asset.gpu,
        "build": asset.build,
        "url": asset.url,
        "sha256": asset.sha256,
        "files": {kept.path: kept.size for kept in asset.files},
        "bytes": asset.install_bytes,
    }
    if asset.environment is not None:
        # Which wheels went in: a lock made again for the same source is
        # another build.
        record["lock_sha256"] = asset.environment.lock_sha256
    # The copy's size counts this file too, whose length depends on the
    # number written in it: a couple of rounds settle it. One line, so
    # Windows' newline translation cannot make the file longer than counted.
    text = json.dumps(record)
    for _ in range(3):
        record["bytes"] = asset.install_bytes + len(text.encode("utf-8"))
        text = json.dumps(record)
    _write_atomic(folder / RECORD, text)


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


def _remove_tree(path: Path, stop: threading.Event | None = None) -> None:
    """Remove a folder, retrying briefly while a file in it is still open (a
    hash or a scan finishing on Windows). Gives up quietly: what is left is a
    dot-folder the sweep at the next start removes. With `stop`, it stops
    between files once that is set and leaves the rest the same way."""
    deadline = time.monotonic() + _REMOVE_BUDGET_S
    while True:
        try:
            _delete_tree(sevenzip.long_path(path), stop)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            if time.monotonic() >= deadline or (stop is not None and stop.is_set()):
                logger.warning("could not remove %s yet (%s); it goes at the next start", path, exc)
                return
            time.sleep(0.1)


def _delete_tree(path: Path, stop: threading.Event | None) -> None:
    """rmtree that follows nothing and stops early. A link inside, a Windows
    junction included (os.walk would descend into one), is removed itself
    and never entered. A file's read-only flag is cleared where Windows
    refuses to delete it: 7-Zip writes the flags an archive holds, and
    ComfyUI's portable builds hold some. Once `stop` is set it returns
    between files."""
    folders = []
    pending = [str(path)]
    while pending:
        current = pending.pop()
        folders.append(current)
        with os.scandir(current) as entries:
            for entry in entries:
                if stop is not None and stop.is_set():
                    return
                info = entry.stat(follow_symlinks=False)
                if sevenzip._is_link(entry, info):
                    _unlink_link(entry.path)
                elif stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)
                else:
                    _unlink_writable(entry.path)
    # Each folder was reached after its parent, so in reverse every folder
    # is empty by the time it is removed.
    for folder in reversed(folders):
        os.rmdir(folder)


def _unlink_link(path: str) -> None:
    """Remove a link, never what it points at. A Windows directory link or
    junction goes with rmdir, which removes the link alone."""
    try:
        os.unlink(path)
    except OSError:
        os.rmdir(path)


def _unlink_writable(path: str) -> None:
    try:
        os.unlink(path)
    except PermissionError:
        if os.name != "nt":
            raise
        os.chmod(path, stat.S_IWRITE)
        os.unlink(path)
