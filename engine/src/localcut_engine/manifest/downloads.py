"""Model download manager: resumable, checksummed weight downloads.

Weights are never bundled in the installer — they are fetched on demand
into a global models directory shared across projects, laid out the way
ComfyUI expects (checkpoints/, vae/, clip/, ...). Interrupted downloads
resume from the partial file via HTTP Range requests; completed files are
verified against the manifest's sha256 before being moved into place.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from .model import ModelEntry, ModelFile

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, int, int], Awaitable[None]]  # (dest, done_bytes, total_bytes)

_CHUNK = 1 << 20  # 1 MiB
# Absolute stream ceiling when the manifest carries no size — a lying or
# compromised server must never be able to fill the disk unbounded.
_MAX_UNSIZED_BYTES = 100 << 30  # 100 GiB
_SIZE_SLACK = 1 << 20  # manifest sizes are exact, but allow a stray chunk


class DownloadError(RuntimeError):
    pass


class ChecksumMismatch(DownloadError):
    pass


def resolve_dest(models_dir: Path, dest: str) -> Path:
    """Join a manifest-supplied dest onto the models dir, refusing anything
    that escapes it. Manifests can be user-supplied (a custom catalog
    replaces the bundled one wholesale), so every path built from `dest` —
    read, write or DELETE — has to go through here."""
    path = models_dir / dest
    if not path.resolve().is_relative_to(models_dir.resolve()):
        raise DownloadError(f"destination escapes models dir: {dest}")
    return path


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


async def download_file(
    file: ModelFile,
    models_dir: Path,
    progress: ProgressFn | None = None,
    client: httpx.AsyncClient | None = None,
) -> Path:
    """Download one file to models_dir/file.dest. Returns the final path.

    Already-complete files (existing + checksum ok when a checksum is
    known) are skipped. A `<dest>.part` file is resumed with a Range
    request; servers that ignore Range restart cleanly.
    """
    dest = resolve_dest(models_dir, file.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        if not file.sha256 or await asyncio.to_thread(_sha256_of, dest) == file.sha256:
            return dest
        dest.unlink()  # corrupt/stale — refetch

    part = dest.with_suffix(dest.suffix + ".part")
    offset = part.stat().st_size if part.exists() else 0

    owns_client = client is None
    client = client or httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=120))
    try:
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        async with client.stream("GET", file.url, headers=headers) as response:
            if response.status_code == 416:
                pass  # already fully downloaded, fall through to verify
            elif response.status_code == 206:
                pass  # resuming at offset
            elif response.status_code == 200:
                offset = 0  # server ignored Range (or fresh download): restart
            else:
                raise DownloadError(f"HTTP {response.status_code} for {file.url}")

            if response.status_code in (200, 206):
                total = int(response.headers.get("content-length", 0)) + offset
                # Never trust the stream to end: a lying server must hit the
                # manifest size (plus slack) or a hard ceiling, not the disk.
                limit = file.size + _SIZE_SLACK if file.size else _MAX_UNSIZED_BYTES
                mode = "ab" if offset else "wb"
                done = offset
                oversized = False
                with part.open(mode) as out:
                    async for chunk in response.aiter_bytes(_CHUNK):
                        out.write(chunk)
                        done += len(chunk)
                        if done > limit:
                            oversized = True
                            break
                        if progress is not None:
                            await progress(file.dest, done, total or file.size)
                if oversized:
                    # Unlink only after the handle is closed — Windows refuses
                    # to delete an open file. Poisoned bytes must not be kept
                    # for a later resume.
                    part.unlink(missing_ok=True)
                    raise DownloadError(
                        f"{file.dest}: stream exceeded the expected "
                        f"size ({done} > {limit} bytes) — aborted"
                    )
    finally:
        if owns_client:
            await client.aclose()

    if not file.sha256:
        # Override manifests may omit checksums; that choice must at least
        # be visible in the logs, not silent.
        logger.warning("no sha256 in manifest for %s — skipping verification", file.dest)
    if file.sha256:
        # Hashing a multi-GB file must not stall the event loop.
        actual = await asyncio.to_thread(_sha256_of, part)
        if actual != file.sha256:
            part.unlink(missing_ok=True)  # do not resume from poisoned bytes
            raise ChecksumMismatch(
                f"{file.dest}: expected sha256 {file.sha256[:16]}…, got {actual[:16]}…"
            )
    part.replace(dest)
    return dest


async def download_model(
    entry: ModelEntry,
    models_dir: Path,
    progress: ProgressFn | None = None,
) -> list[Path]:
    if not entry.files:
        raise DownloadError(f"model {entry.id} has no downloadable files in the manifest")
    paths = []
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=httpx.Timeout(30, read=120)
    ) as client:
        for file in entry.files:
            paths.append(await download_file(file, models_dir, progress, client))
    return paths


def is_downloaded(entry: ModelEntry, models_dir: Path) -> bool:
    return bool(entry.files) and all((models_dir / f.dest).exists() for f in entry.files)


def partial_bytes(entry: ModelEntry, models_dir: Path) -> int:
    """Bytes already on disk for an incomplete download: completed files
    plus resumable `.part` remnants. Lets the UI say "Resume" instead of
    "Download" after a restart."""
    done = 0
    for f in entry.files:
        dest = models_dir / f.dest
        if dest.exists():
            done += f.size or dest.stat().st_size
            continue
        part = dest.with_suffix(dest.suffix + ".part")
        if part.exists():
            done += part.stat().st_size
    return done
