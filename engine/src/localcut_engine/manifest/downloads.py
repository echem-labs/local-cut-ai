"""Model download manager: resumable, checksummed weight downloads.

Weights are never bundled in the installer — they are fetched on demand
into a global models directory shared across projects, laid out the way
ComfyUI expects (checkpoints/, vae/, clip/, ...). Interrupted downloads
resume from the partial file via HTTP Range requests; completed files are
verified against the manifest's sha256 before being moved into place.
"""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from .model import ModelEntry, ModelFile

ProgressFn = Callable[[str, int, int], Awaitable[None]]  # (dest, done_bytes, total_bytes)

_CHUNK = 1 << 20  # 1 MiB


class DownloadError(RuntimeError):
    pass


class ChecksumMismatch(DownloadError):
    pass


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
    dest = models_dir / file.dest
    # Containment check must hold for relative and absolute models_dir alike:
    # manifests can be user-supplied, so dest must never escape.
    if not dest.resolve().is_relative_to(models_dir.resolve()):
        raise DownloadError(f"destination escapes models dir: {file.dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        if not file.sha256 or _sha256_of(dest) == file.sha256:
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
                mode = "ab" if offset else "wb"
                done = offset
                with part.open(mode) as out:
                    async for chunk in response.aiter_bytes(_CHUNK):
                        out.write(chunk)
                        done += len(chunk)
                        if progress is not None:
                            await progress(file.dest, done, total or file.size)
    finally:
        if owns_client:
            await client.aclose()

    if file.sha256:
        actual = _sha256_of(part)
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
        raise DownloadError(
            f"model {entry.id} has no downloadable files in the manifest"
        )
    paths = []
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=httpx.Timeout(30, read=120)
    ) as client:
        for file in entry.files:
            paths.append(await download_file(file, models_dir, progress, client))
    return paths


def is_downloaded(entry: ModelEntry, models_dir: Path) -> bool:
    return bool(entry.files) and all((models_dir / f.dest).exists() for f in entry.files)
