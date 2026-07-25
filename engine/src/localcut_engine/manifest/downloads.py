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
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .model import ModelEntry, ModelFile

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str, int, int], Awaitable[None]]  # (dest, done_bytes, total_bytes)

_CHUNK = 1 << 20  # 1 MiB
# Absolute stream ceiling when the manifest carries no size — a lying or
# compromised server must never be able to fill the disk unbounded.
_MAX_UNSIZED_BYTES = 100 << 30  # 100 GiB
_SIZE_SLACK = 1 << 20  # manifest sizes are exact, but allow a stray chunk
# A weight file that is smaller than this is not weights. Without a checksum
# there is nothing else standing between "captive portal served us its login
# page" and "the model reports installed forever" (SEC-5).
_MIN_UNVERIFIED_BYTES = 1 << 20  # 1 MiB
# Content types a weight file is never served as. Checked only on the
# checksum-less path — a manifest sha256 is a far stronger statement than
# any header, and some CDNs mislabel .safetensors as text/plain.
_HTML_CONTENT_TYPES = ("text/html", "application/xhtml", "text/plain")


class DownloadError(RuntimeError):
    pass


class ChecksumMismatch(DownloadError):
    pass


class UnsafeURL(DownloadError):
    """A catalog URL that resolves somewhere the engine must not fetch."""


def _is_public(ip: str) -> bool:
    """Whether an address is routable on the public internet. Everything the
    SSRF guard cares about — loopback, RFC1918, link-local (which covers the
    169.254.169.254 cloud metadata endpoint), CGNAT, multicast, reserved —
    answers False here."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        # 100.64.0.0/10 is "private" to ipaddress only from 3.13; be explicit.
        or (addr.version == 4 and addr in ipaddress.ip_network("100.64.0.0/10"))
    )


def assert_public_url(url: str) -> None:
    """Refuse a catalog URL that is not plain https to a public host.

    Custom catalog entries are user-supplied and the URL is fetched by the
    engine, from the engine's network position — on the documented remote
    topology that is a GPU box inside someone's LAN, or a cloud instance with
    a metadata endpoint. Every resolved address must be public, so a hostname
    that resolves to several addresses cannot pass the check on one and be
    dialled on another (SEC-3)."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise UnsafeURL(f"model URLs must be https, got {parts.scheme or 'no'} scheme: {url}")
    host = (parts.hostname or "").strip("[]")
    if not host:
        raise UnsafeURL(f"model URL has no host: {url}")
    try:
        infos = socket.getaddrinfo(host, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise UnsafeURL(f"could not resolve {host}: {exc}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise UnsafeURL(f"could not resolve {host}")
    private = sorted(a for a in addresses if not _is_public(a))
    if private:
        raise UnsafeURL(
            f"refusing to fetch {host}: it resolves to a non-public address ({private[0]}). "
            "Model URLs must point at a public host."
        )


def resolve_dest(models_dir: Path, dest: str) -> Path:
    """Join a manifest-supplied dest onto the models dir, refusing anything
    that escapes it. Manifests can be user-supplied (a custom catalog
    replaces the bundled one wholesale), so every path built from `dest` —
    read, write or DELETE — has to go through here."""
    path = contained_dest(models_dir, dest)
    if path is None:
        raise DownloadError(f"destination escapes models dir: {dest}")
    return path


def contained_dest(models_dir: Path, dest: str) -> Path | None:
    """resolve_dest for the read-only probes (exists/size), which must not
    raise out of a listing route: an escaping dest is simply not a model
    file we have. Answering from the escaped path instead would make the
    models list an out-of-tree file-existence and file-size oracle, and let
    a bogus entry report itself installed so its weights never download."""
    path = models_dir / dest
    try:
        if not path.resolve().is_relative_to(models_dir.resolve()):
            return None
    except OSError:  # unresolvable (loops, permissions) is not contained
        return None
    return path


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


_MAX_REDIRECTS = 5


@asynccontextmanager
async def _stream_checked(client: httpx.AsyncClient, url: str, headers: dict):
    """`client.stream("GET", url)` that re-validates every redirect hop.

    httpx's own `follow_redirects=True` would check only the URL we passed,
    so a public host could bounce us to 169.254.169.254 or a LAN box after
    the guard had already run. Weight hosts do redirect (HuggingFace hands
    off to a CDN), so redirects have to be followed — just not blindly."""
    for _ in range(_MAX_REDIRECTS):
        assert_public_url(url)
        response = await client.send(client.build_request("GET", url, headers=headers), stream=True)
        if response.is_redirect and response.has_redirect_location:
            location = str(response.next_request.url)
            await response.aclose()
            url = location
            continue
        try:
            yield response
        finally:
            await response.aclose()
        return
    raise UnsafeURL(f"too many redirects fetching {url}")


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
    # follow_redirects stays OFF: _stream_checked walks the chain itself so
    # every hop is re-validated against the SSRF guard.
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(30, read=120))
    content_type = ""
    try:
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        async with _stream_checked(client, file.url, headers) as response:
            if response.status_code == 416:
                pass  # already fully downloaded, fall through to verify
            elif response.status_code == 206:
                pass  # resuming at offset
            elif response.status_code == 200:
                offset = 0  # server ignored Range (or fresh download): restart
            else:
                raise DownloadError(f"HTTP {response.status_code} for {file.url}")

            if response.status_code in (200, 206):
                # Only from a response that actually carried the file. A 416
                # means the .part is already complete, and its error page is
                # `text/html` on most servers — reading the type off THAT
                # would condemn a finished multi-GB download as a login page
                # and delete it.
                content_type = (
                    response.headers.get("content-type", "").split(";")[0].strip().lower()
                )
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

    if file.sha256:
        # Hashing a multi-GB file must not stall the event loop.
        actual = await asyncio.to_thread(_sha256_of, part)
        if actual != file.sha256:
            part.unlink(missing_ok=True)  # do not resume from poisoned bytes
            raise ChecksumMismatch(
                f"{file.dest}: expected sha256 {file.sha256[:16]}…, got {actual[:16]}…"
            )
    else:
        # Override manifests may omit checksums. Nothing can prove these bytes
        # are the right weights, but the cheap sanity checks still separate
        # "weights" from "the captive portal's login page" — which would
        # otherwise be saved as a .safetensors and report installed forever,
        # so the real weights never download and the failure surfaces much
        # later as an opaque load error (SEC-5).
        logger.warning("no sha256 in manifest for %s — verifying heuristically", file.dest)
        size = part.stat().st_size if part.exists() else 0
        if content_type.startswith(_HTML_CONTENT_TYPES):
            part.unlink(missing_ok=True)
            raise DownloadError(
                f"{file.dest}: server returned {content_type}, not a weight file — "
                "this is usually a login page or an error page, not the model"
            )
        if size < _MIN_UNVERIFIED_BYTES:
            part.unlink(missing_ok=True)
            raise DownloadError(
                f"{file.dest}: got {size} bytes, too small to be model weights — "
                "the download was probably an error page"
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
    # No follow_redirects: download_file walks redirects itself so the SSRF
    # guard sees every hop.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120)) as client:
        for file in entry.files:
            paths.append(await download_file(file, models_dir, progress, client))
    return paths


def is_downloaded(entry: ModelEntry, models_dir: Path) -> bool:
    def present(dest: str) -> bool:
        path = contained_dest(models_dir, dest)
        return path is not None and path.exists()

    return bool(entry.files) and all(present(f.dest) for f in entry.files)


def partial_bytes(entry: ModelEntry, models_dir: Path) -> int:
    """Bytes already on disk for an incomplete download: completed files
    plus resumable `.part` remnants. Lets the UI say "Resume" instead of
    "Download" after a restart."""
    done = 0
    for f in entry.files:
        dest = contained_dest(models_dir, f.dest)
        if dest is None:
            continue
        if dest.exists():
            done += f.size or dest.stat().st_size
            continue
        part = dest.with_suffix(dest.suffix + ".part")
        if part.exists():
            done += part.stat().st_size
    return done
