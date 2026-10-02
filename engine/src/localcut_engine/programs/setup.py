"""Setting a program up: LocalCut's own copy of it, from the pinned build, in
<data_dir>/programs/<id>, while the engine keeps serving.

A setup runs in the background and reports on the event bus /ws carries,
the way model downloads do (manifest/manager.py). It goes through these
phases, each announced as it starts:

1. downloading: the pinned archive, into a scratch folder beside the program
   folders, through the model downloader, so every redirect hop passes the
   same guard and the size has to match the pin to the byte;
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

It ends with `program.setup.done`, `program.setup.failed` (with a reason
from SETUP_FAILURES) or `program.setup.cancelled`. A failed or cancelled
setup removes everything it wrote before saying so, and what an interrupted
one left behind is cleared the next time the engine starts (`sweep`).

One setup per program at a time. Nothing a client sends changes what is
fetched: the routes take no body, and the pin is the only source.

What a setup needs to know about one program in particular (which files it
must keep, how to tell the copy works, whether the engine would use it) is
that program's installer. FFmpeg is the only one so far. Another program is
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
import stat
import tarfile
import threading
import time
import zipfile
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

import httpx

from .. import storage
from ..backends import ffmpeg as ffmpeg_backend
from ..config import EngineConfig
from ..events import EventBus
from ..manifest import downloads
from ..manifest.model import ModelFile
from ..project.store import _write_atomic
from . import PROGRAM_IDS
from . import manifest as program_manifest
from .manifest import KeptFile, ProgramAsset, ProgramPin

logger = logging.getLogger(__name__)

#: What LocalCut writes beside a program's files: which build it is.
RECORD = "program.json"
#: The newest record format this engine reads.
RECORD_VERSION = 1

_PROGRESS_INTERVAL_S = 0.5  # the bus throttle model downloads use
_RATE_WINDOW_S = 5.0  # bytes_per_s is measured over the last few seconds
_CHUNK = 1 << 20
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
}


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


#: The programs LocalCut can set up, by id.
INSTALLERS = {"ffmpeg": FFmpegInstaller()}


def pinned(program_id: str) -> tuple[ProgramPin | None, ProgramAsset | None, str | None]:
    """(pin, this machine's build, why there is none). The reason is one of
    SETUP_UNAVAILABLE when there is no build to set up here."""
    installer = INSTALLERS.get(program_id)
    pin = program_manifest.load_programs_manifest().program(program_id)
    if installer is None or pin is None:
        return pin, None, "program_not_supported"
    asset = pin.asset_for(program_manifest.platform_key() or "")
    if asset is None or not installer.fits(asset):
        return pin, None, "platform_not_supported"
    return pin, asset, None


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

    def rate(self) -> int | None:
        """Bytes a second over the last few seconds of the download, or None
        before there is enough of it to measure."""
        if self.phase != "downloading" or len(self._samples) < 2:
            return None
        (t0, d0), (t1, d1) = self._samples[0], self._samples[-1]
        return round((d1 - d0) / (t1 - t0)) if t1 - t0 >= 0.5 else None

    def sample(self, now: float) -> None:
        self._samples.append((now, self.done))
        while self._samples and now - self._samples[0][0] > _RATE_WINDOW_S:
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
    ) -> None:
        self.config = config
        self.events = events
        self.render_uses = render_uses
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
            if await asyncio.to_thread(is_current, folder, asset):
                return {"status": "installed"}
            if folder.exists() and installer.in_use(self.config) and self.render_uses(program_id):
                raise ProgramInUse(
                    f"a render is using LocalCut's {program_id}; wait for it to finish, "
                    "or cancel it, and set it up again"
                )
            need = asset.size + asset.install_bytes
            free = await asyncio.to_thread(self._free_bytes)
            if free < need:
                raise NotEnoughSpace(
                    f"setting up {program_id} needs {need} bytes free in "
                    f"{self.config.programs_dir} for the download and the unpacked copy "
                    f"at once, and {free} are free",
                    need=need,
                    free=free,
                )
            job = _Job(
                id=secrets.token_hex(6), program=program_id, phase="downloading", total=asset.size
            )
            self._jobs[program_id] = job
            self._last.pop(program_id, None)
            job.task = asyncio.get_running_loop().create_task(
                self._run(job, pin, asset), name=f"setup-{program_id}"
            )
            return {"status": "started", "job": job.id}

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
            freed = await asyncio.to_thread(self._take_away, folder)
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

    def _free_bytes(self) -> int:
        self.config.programs_dir.mkdir(parents=True, exist_ok=True)
        return shutil.disk_usage(self.config.programs_dir).free

    # -- progress ------------------------------------------------------------

    def _phase(self, job: _Job, phase: str, total: int, done: int = 0) -> None:
        job.phase, job.total, job.done = phase, total, done
        job._samples.clear()
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
        except asyncio.CancelledError:
            await asyncio.shield(asyncio.to_thread(_remove_tree, scratch))
            self._finish(job, "cancelled")
            self.events.publish("program.setup.cancelled", program=job.program)
            raise
        except Exception as exc:  # noqa: BLE001 - every failure is reported, none escapes
            reason, message = _failure(exc, job.phase, pin)
            logger.warning("setup of %s failed (%s): %s", job.program, reason, message)
            await asyncio.to_thread(_remove_tree, scratch)
            self._finish(job, "failed", reason=reason, error=message)
            self.events.publish(
                "program.setup.failed", program=job.program, reason=reason, error=message
            )
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
        )

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
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120)) as client:
            return await downloads.download_file(target, scratch, progress, client, exact_size=True)

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


def _progress_payload(job: _Job) -> dict:
    described = job.describe()
    return {key: described[key] for key in ("phase", "done", "total", "bytes_per_s")}


def _failure(exc: BaseException, phase: str, pin: ProgramPin) -> tuple[str, str]:
    """(reason, message) for whatever stopped a setup."""
    if isinstance(exc, SetupFailed):
        return exc.reason, str(exc)
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
        with (folder / kept.path).open("xb") as sink:
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
            (folder / kept.path).chmod(0o755)

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
        # One pass, in archive order: an xz stream cannot be read backwards
        # without decompressing it again from the start.
        with tarfile.open(archive, "r:xz") as untarred:
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
    except (zipfile.BadZipFile, tarfile.TarError, lzma.LZMAError, EOFError) as exc:
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
