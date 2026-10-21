"""Find newer builds of the programs LocalCut sets up and pin them.

    cd engine
    uv run python scripts/pin-programs.py check
    uv run python scripts/pin-programs.py pin ollama
    uv run python scripts/pin-programs.py pin comfyui --version 0.43.0

`check` prints, as JSON, the upstream release of FFmpeg, Ollama and ComfyUI
that is newer than its pin in programs-manifest.json, by the rule each pin
follows:

- FFmpeg: BtbN/FFmpeg-Builds' newest month-end build whose month has ended,
  and in it the LGPL build of FFmpeg's newest release branch for win64 and
  linux64. BtbN deletes every other build within weeks and keeps the last
  build of a month for two years.
- Ollama: the newest release that is not a prerelease.
- ComfyUI: the newest release, with all four Windows portable builds, once
  it is three days old. 0.42.0 had a fix release three hours after it shipped.

`--skip-existing <owner/repo>` moves a release whose branch
(`pins/<program>-<label>`) or pull request already exists out of `newer`.

`pin <program>` measures that release (or the one `--version` names, for
FFmpeg a BtbN release tag) and writes it: the program's entries in
programs-manifest.json, the numbers docs/programs.md states for it, for
FFmpeg engine/Dockerfile's FFMPEG_URL and FFMPEG_SHA256 and for ComfyUI the
Linux locks, made by lock-comfyui-linux.py with the Python and the PyTorch
the locks have now. Before it measures the new release it measures the
pinned one the same way and stops unless that comes out as the pin, byte for
byte. It writes nothing it could not measure in full.

How each archive is measured, without downloading what can be read in place:

- a zip (FFmpeg's and Ollama's Windows builds): its central directory, read
  with HTTP Range requests;
- a tar.xz or tar.zst (their Linux builds): streamed once, hashed and
  listed;
- a 7z (ComfyUI's portable builds): the start header, the end header and
  the packed header it points to, read with Range requests and written at
  their offsets into a sparse file of the archive's size, which 7-Zip's
  `7zz` lists. The listing is counted by the engine's own parse_listing and
  check_members, the code a setup runs on the real archive.

Sizes and SHA-256 are the ones GitHub publishes for each release asset. A
streamed archive has to hash to that digest too.
"""

from __future__ import annotations

import argparse
import calendar
import copy
import datetime
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import tomllib
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from packaging.version import Version

ENGINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ENGINE / "src"))
from localcut_engine.programs import sevenzip  # noqa: E402
from localcut_engine.programs.manifest import (  # noqa: E402
    KeptTree,
    parse_programs_manifest,
)

PROGRAMS = ("ffmpeg", "ollama", "comfyui")
REPOSITORIES = {
    "ffmpeg": "BtbN/FFmpeg-Builds",
    "ollama": "ollama/ollama",
    "comfyui": "Comfy-Org/ComfyUI",
}
NAMES = {"ffmpeg": "FFmpeg", "ollama": "Ollama", "comfyui": "ComfyUI"}
API = "https://api.github.com"

#: How old a ComfyUI release has to be before it is pinned.
COMFYUI_MIN_AGE = datetime.timedelta(days=3)
#: The Windows portable builds, by (GPU vendor, build). nvidia_arm64 is
#: for Windows on ARM, which LocalCut pins nothing for.
COMFYUI_PORTABLE = {
    ("nvidia", None): "ComfyUI_windows_portable_nvidia.7z",
    ("nvidia", "older_drivers"): "ComfyUI_windows_portable_nvidia_cu126.7z",
    ("amd", None): "ComfyUI_windows_portable_amd.7z",
    ("intel", None): "ComfyUI_windows_portable_intel.7z",
}
OLLAMA_ASSETS = {
    "windows-x64": "ollama-windows-amd64.zip",
    "linux-x64": "ollama-linux-amd64.tar.zst",
}
#: The lock each Linux ComfyUI build is, by (GPU vendor, build), as
#: lock-comfyui-linux.py names them.
COMFYUI_LOCKS = {
    ("nvidia", None): "cu130",
    ("nvidia", "older_drivers"): "cu126",
    ("amd", None): "rocm72",
    ("intel", None): "xpu",
    (None, "cpu"): "cpu",
}

#: 7-Zip's console program for Linux, which lists a portable build's
#: headers. The same release as the `7zr.exe` the manifest pins for setups.
SEVEN_ZIP = {
    "version": "26.04",
    "url": "https://github.com/ip7z/7zip/releases/download/26.04/7z2604-linux-x64.tar.xz",
    "size": 1576336,
    "sha256": "fc0327ba27e89bd086cf426dff17d77de582953cdbbc10a6576540a06853ffcd",
}

_AUTOBUILD = re.compile(r"autobuild-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})")
# An LGPL build of a release branch, e.g.
# ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip. The shared builds and
# the master builds (ffmpeg-N-...) do not match.
_FFMPEG_LGPL = re.compile(
    r"ffmpeg-(?P<describe>n(?P<version>\d+(?:\.\d+)+)(?:-\d+-g[0-9a-f]+)?)"
    r"-(?P<target>win64|linux64)-lgpl-(?P<branch>\d+\.\d+)\.(?:zip|tar\.xz)"
)
_FFMPEG_TARGETS = {"win64": "windows-x64", "linux64": "linux-x64"}
_RELEASE_TAG = re.compile(r"v?(\d+(?:\.\d+)+)")


class Unmeasurable(Exception):
    """Something a pin needs could not be read or did not add up."""


# -- what upstream has ------------------------------------------------------------------


@dataclass(frozen=True)
class Release:
    """One upstream release as a pin would take it."""

    program: str
    #: The program's own version, as the manifest records it.
    version: str
    #: Upstream's release tag, which `pin --version` takes.
    tag: str
    published: str
    #: What names the branch a bump goes on: pins/<program>-<label>.
    label: str
    #: The release assets a pin reads, as GitHub's API describes them,
    #: keyed by platform (FFmpeg, Ollama) or by (GPU vendor, build).
    assets: dict = field(default_factory=dict, compare=False, hash=False)
    #: FFmpeg's `git describe` of the build, e.g. n9.0.2-17-g2a571b6068.
    describe: str | None = None
    #: Every asset of the release, by name: checksum files among them.
    all_assets: dict = field(default_factory=dict, compare=False, hash=False)

    @property
    def branch(self) -> str:
        return f"pins/{self.program}-{self.label}"

    @property
    def page(self) -> str:
        return f"https://github.com/{REPOSITORIES[self.program]}/releases/tag/{self.tag}"


def _published(release: dict) -> str:
    return release.get("published_at") or release.get("created_at") or ""


def _stable(release: dict) -> bool:
    return not release.get("draft") and not release.get("prerelease")


def _autobuild(tag: str) -> tuple[datetime.date, int, int] | None:
    found = _AUTOBUILD.fullmatch(tag)
    if not found:
        return None
    year, month, day, hour, minute = (int(part) for part in found.groups())
    try:
        return datetime.date(year, month, day), hour, minute
    except ValueError:
        return None


def ffmpeg_month_ends(releases: list[dict], today: datetime.date) -> list[dict]:
    """The releases BtbN keeps for two years: the last build of each month
    that has ended. A build dated the last day of its month is that build,
    and of two runs that day only the later one is kept. Newest first."""
    last_of_day: dict[datetime.date, tuple[tuple[int, int], dict]] = {}
    for release in releases:
        if not _stable(release):
            continue
        when = _autobuild(release.get("tag_name", ""))
        if when is None:
            continue
        day, hour, minute = when
        if day.day != calendar.monthrange(day.year, day.month)[1] or day >= today:
            continue
        kept = last_of_day.get(day)
        if kept is None or (hour, minute) > kept[0]:
            last_of_day[day] = ((hour, minute), release)
    return [last_of_day[day][1] for day in sorted(last_of_day, reverse=True)]


def ffmpeg_in(release: dict) -> Release | None:
    """The LGPL build of FFmpeg's newest release branch in one BtbN release,
    for both platforms, or None when the release has no branch built for
    both."""
    branches: dict[tuple[int, ...], dict[str, tuple[re.Match, dict]]] = {}
    for asset in release.get("assets", []):
        found = _FFMPEG_LGPL.fullmatch(asset.get("name", ""))
        if not found:
            continue
        branch = tuple(int(part) for part in found["branch"].split("."))
        branches.setdefault(branch, {})[_FFMPEG_TARGETS[found["target"]]] = (found, asset)
    for branch in sorted(branches, reverse=True):
        built = branches[branch]
        if set(built) != set(_FFMPEG_TARGETS.values()):
            continue
        describes = {found["describe"] for found, _ in built.values()}
        if len(describes) != 1:
            continue
        found = built["linux-x64"][0]
        tag = release["tag_name"]
        day = _autobuild(tag)
        assert day is not None
        return Release(
            program="ffmpeg",
            version=found["version"],
            tag=tag,
            published=_published(release),
            label=f"{found['version']}-{day[0].isoformat()}",
            assets={platform: asset for platform, (_, asset) in built.items()},
            describe=found["describe"],
            all_assets={asset["name"]: asset for asset in release.get("assets", [])},
        )
    return None


def ffmpeg_release(releases: list[dict], today: datetime.date) -> Release | None:
    """The FFmpeg a pin takes now: the newest month-end build's newest LGPL
    release branch."""
    for release in ffmpeg_month_ends(releases, today):
        found = ffmpeg_in(release)
        if found is not None:
            return found
    return None


def _versioned(program: str, release: dict, keys: dict) -> Release | None:
    """A release tagged with its version (v0.40.7), with the assets `keys`
    names, or None when it is not one or lacks any of them."""
    tag = release.get("tag_name", "")
    found = _RELEASE_TAG.fullmatch(tag)
    if not found:
        return None
    by_name = {asset.get("name"): asset for asset in release.get("assets", [])}
    if not all(name in by_name for name in keys.values()):
        return None
    return Release(
        program=program,
        version=found.group(1),
        tag=tag,
        published=_published(release),
        label=found.group(1),
        assets={key: by_name[name] for key, name in keys.items()},
        all_assets=by_name,
    )


def ollama_release(releases: list[dict]) -> Release | None:
    """The newest Ollama release that is not a prerelease, with both
    archives a pin takes."""
    found = [
        candidate
        for release in releases
        if _stable(release)
        and (candidate := _versioned("ollama", release, OLLAMA_ASSETS)) is not None
    ]
    return max(found, key=lambda r: Version(r.version), default=None)


def comfyui_release(
    releases: list[dict], now: datetime.datetime
) -> tuple[Release | None, Release | None]:
    """(the ComfyUI a pin takes now, the newer one held back for its age).

    The newest release with every portable build a pin takes. One younger
    than three days is held. Nothing older is taken in its place: a
    release followed that quickly by another is the one most likely to
    need it."""
    found = [
        candidate
        for release in releases
        if _stable(release)
        and (candidate := _versioned("comfyui", release, COMFYUI_PORTABLE)) is not None
    ]
    newest = max(found, key=lambda r: Version(r.version), default=None)
    if newest is None:
        return None, None
    published = datetime.datetime.fromisoformat(newest.published.replace("Z", "+00:00"))
    if now - published < COMFYUI_MIN_AGE:
        return None, newest
    return newest, None


def pinned_release(program: str, pin: dict) -> str:
    """The upstream tag of the pin as it stands."""
    if program == "ffmpeg":
        found = re.search(r"/releases/download/([^/]+)/", pin["assets"][0]["url"])
        if not found:
            raise Unmeasurable(f"FFmpeg's pin is not a release download: {pin['assets'][0]['url']}")
        return found.group(1)
    return f"v{pin['version']}"


def is_newer(program: str, release: Release, pin: dict) -> bool:
    """Whether `release` moves the pin forward."""
    if program == "ffmpeg":
        now = _autobuild(pinned_release(program, pin))
        then = _autobuild(release.tag)
        if then is None:
            return False
        return now is None or then > now
    return Version(release.version) > Version(pin["version"])


def proposed_already(
    branch: str, repository: str, refs: list[dict], pulls: list[dict]
) -> str | None:
    """Why a bump on `branch` is not proposed again: the branch exists, or a
    pull request from it does, in any state. A closed one was a decision.
    `refs` is GitHub's matching-refs answer for the branch and `pulls` its
    pull requests from it."""
    if any(ref.get("ref") == f"refs/heads/{branch}" for ref in refs):
        return f"branch {branch} exists"
    for pull in pulls:
        head = pull.get("head") or {}
        repo = (head.get("repo") or {}).get("full_name")
        if head.get("ref") == branch and repo in (None, repository):
            return f"pull request #{pull.get('number')} ({pull.get('state')}) is from {branch}"
    return None


# -- GitHub --------------------------------------------------------------------------------


def github_client() -> httpx.Client:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(headers=headers, timeout=httpx.Timeout(60, read=120), follow_redirects=True)


def _api(client: httpx.Client, path: str, **params) -> object:
    response = client.get(f"{API}{path}", params=params or None)
    response.raise_for_status()
    return response.json()


def releases_of(client: httpx.Client, program: str) -> list[dict]:
    """The newest hundred releases: every release a pin could take is in
    them. BtbN keeps under forty."""
    found = _api(client, f"/repos/{REPOSITORIES[program]}/releases", per_page=100)
    assert isinstance(found, list)
    return found


def release_by_tag(client: httpx.Client, program: str, tag: str) -> dict:
    found = _api(client, f"/repos/{REPOSITORIES[program]}/releases/tags/{tag}")
    assert isinstance(found, dict)
    return found


def existing_proposal(client: httpx.Client, repository: str, branch: str) -> str | None:
    refs = client.get(f"{API}/repos/{repository}/git/matching-refs/heads/{branch}")
    refs.raise_for_status()
    owner = repository.split("/", 1)[0]
    pulls = _api(
        client, f"/repos/{repository}/pulls", state="all", head=f"{owner}:{branch}", per_page=100
    )
    assert isinstance(pulls, list)
    return proposed_already(branch, repository, refs.json(), pulls)


def upstream(
    client: httpx.Client, program: str, now: datetime.datetime
) -> tuple[Release | None, Release | None]:
    """(what a pin of `program` takes now, a newer release held back)."""
    releases = releases_of(client, program)
    if program == "ffmpeg":
        return ffmpeg_release(releases, now.date()), None
    if program == "ollama":
        return ollama_release(releases), None
    return comfyui_release(releases, now)


def release_named(client: httpx.Client, program: str, name: str) -> Release:
    """The release `pin --version` names: a BtbN tag for FFmpeg, a version
    or its tag for the others."""
    tag = name if program == "ffmpeg" or name.startswith("v") else f"v{name}"
    release = release_by_tag(client, program, tag)
    if program == "ffmpeg":
        found = ffmpeg_in(release)
    elif program == "ollama":
        found = _versioned("ollama", release, OLLAMA_ASSETS)
    else:
        found = _versioned("comfyui", release, COMFYUI_PORTABLE)
    if found is None:
        raise Unmeasurable(f"{NAMES[program]}'s release {tag} has no build a pin takes")
    return found


# -- reading archives in place -------------------------------------------------------------


def _digest_of(asset: dict) -> str:
    digest = asset.get("digest") or ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise Unmeasurable(f"GitHub publishes no SHA-256 for {asset.get('name')}")
    return digest.removeprefix("sha256:")


class RangeReader(io.RawIOBase):
    """A release asset read with Range requests, in blocks, for zipfile to
    find a zip's central directory in."""

    _BLOCK = 1 << 20

    def __init__(self, client: httpx.Client, url: str, size: int) -> None:
        self.client, self.url, self.size = client, url, size
        self.position = 0
        self.blocks: dict[int, bytes] = {}

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self.position, 2: self.size}[whence]
        self.position = max(0, base + offset)
        return self.position

    def range(self, start: int, count: int) -> bytes:
        """`count` bytes from `start`. An answer with the whole file instead
        is closed unread and the range asked for again after a wait."""
        if count <= 0:
            return b""
        end = start + count - 1
        for attempt in range(5):
            with self.client.stream(
                "GET", self.url, headers={"Range": f"bytes={start}-{end}"}
            ) as response:
                total = response.headers.get("content-range", "").rpartition("/")[2]
                if response.status_code == 206 and total == str(self.size):
                    data = response.read()
                    if len(data) != count:
                        raise Unmeasurable(f"{self.url} sent {len(data)} of {count} bytes")
                    return data
                if response.status_code not in (200, 206):
                    raise Unmeasurable(
                        f"{self.url} answered bytes {start}-{end} with {response.status_code}"
                    )
                said = f"{response.status_code} {response.headers.get('content-range')}"
            time.sleep(2**attempt)
        raise Unmeasurable(
            f"{self.url} answered bytes {start}-{end} of {self.size} with {said}, five times"
        )

    def _block(self, index: int) -> bytes:
        if index not in self.blocks:
            start = index * self._BLOCK
            self.blocks[index] = self.range(start, min(self.size, start + self._BLOCK) - start)
        return self.blocks[index]

    def read(self, count: int = -1) -> bytes:
        if count < 0:
            count = self.size - self.position
        out = bytearray()
        while count > 0 and self.position < self.size:
            index, offset = divmod(self.position, self._BLOCK)
            piece = self._block(index)[offset : offset + count]
            out += piece
            self.position += len(piece)
            count -= len(piece)
        return bytes(out)

    def readinto(self, buffer) -> int:  # noqa: ANN001 - a writable buffer
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)


def zip_listing(client: httpx.Client, asset: dict) -> list[zipfile.ZipInfo]:
    """Every member of a zip, from its central directory."""
    with zipfile.ZipFile(
        RangeReader(client, asset["browser_download_url"], asset["size"])
    ) as remote:
        return remote.infolist()


class _Hashing(io.RawIOBase):
    """The bytes of a download as they arrive, hashed and counted."""

    def __init__(self, chunks: Iterator[bytes]) -> None:
        self.chunks = chunks
        self.pending = memoryview(b"")
        self.digest = hashlib.sha256()
        self.size = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:  # noqa: ANN001 - a writable buffer
        while not self.pending:
            chunk = next(self.chunks, None)
            if chunk is None:
                return 0
            self.digest.update(chunk)
            self.size += len(chunk)
            self.pending = memoryview(chunk)
        count = min(len(buffer), len(self.pending))
        buffer[:count] = self.pending[:count]
        self.pending = self.pending[count:]
        return count


@dataclass(frozen=True)
class TarEntry:
    name: str
    kind: str  # file, link, folder or other
    size: int
    link: str | None = None


def tar_stream(client: httpx.Client, asset: dict) -> tuple[int, str, list[TarEntry]]:
    """(size, SHA-256, members) of a .tar.xz or .tar.zst, read once from
    start to end. Asked again from the start, up to three times, when the
    connection drops."""
    url = asset["browser_download_url"]
    for attempt in range(3):
        try:
            return _tar_stream_once(client, url)
        except httpx.TransportError as exc:
            if attempt == 2:
                raise Unmeasurable(f"{url} could not be read: {exc}") from exc
    raise AssertionError("unreachable")


def _tar_stream_once(client: httpx.Client, url: str) -> tuple[int, str, list[TarEntry]]:
    entries = []
    with client.stream("GET", url) as response:
        response.raise_for_status()
        raw = _Hashing(response.iter_raw(1 << 20))
        buffered = io.BufferedReader(raw, 1 << 20)
        if url.endswith(".tar.xz"):
            unpacked: io.IOBase = lzma.LZMAFile(buffered)
        elif url.endswith(".tar.zst"):
            from compression import zstd

            unpacked = zstd.ZstdFile(buffered)
        else:
            raise Unmeasurable(f"{url} is not a tar.xz or a tar.zst")
        with tarfile.open(fileobj=unpacked, mode="r|") as untarred:
            for member in untarred:
                if member.isreg():
                    entries.append(TarEntry(member.name, "file", member.size))
                elif member.issym():
                    entries.append(TarEntry(member.name, "link", 0, member.linkname))
                elif member.isdir():
                    entries.append(TarEntry(member.name, "folder", 0))
                else:
                    entries.append(TarEntry(member.name, "other", 0))
        # The hash is of the whole file, including what follows the tar's end.
        while unpacked.read(1 << 20):
            pass
        while buffered.read(1 << 20):
            pass
    return raw.size, raw.digest.hexdigest(), entries


_SEVEN_ZIP_SIGNATURE = b"7z\xbc\xaf\x27\x1c"
_K_HEADER = 0x01
_K_ENCODED_HEADER = 0x17
_K_PACK_INFO = 0x06
_K_SIZE = 0x09
_K_END = 0x00


def _seven_zip_number(data: bytes, position: int) -> tuple[int, int]:
    """A 7z NUMBER at `position`: (its value, the position after it)."""
    first = data[position]
    position += 1
    mask = 0x80
    value = 0
    for index in range(8):
        if first & mask == 0:
            return value | ((first & (mask - 1)) << (8 * index)), position
        value |= data[position] << (8 * index)
        position += 1
        mask >>= 1
    return value, position


def seven_zip_header_pieces(read: Callable[[int, int], bytes]) -> list[tuple[int, bytes]]:
    """(offset, bytes) of everything 7-Zip reads to list an archive: the
    32-byte start header, the end header it points to and, where that is
    an encoded header, the packed header it describes."""
    start = read(0, 32)
    if start[:6] != _SEVEN_ZIP_SIGNATURE:
        raise Unmeasurable("the archive does not start with 7z's signature")
    offset, size, _ = struct.unpack_from("<QQI", start, 12)
    where = 32 + offset
    header = read(where, size)
    pieces = [(0, start), (where, header)]
    if header[:1] == bytes([_K_HEADER]):
        return pieces
    if header[:2] != bytes([_K_ENCODED_HEADER, _K_PACK_INFO]):
        raise Unmeasurable("the archive's end header is neither a header nor an encoded one")
    pack_position, position = _seven_zip_number(header, 2)
    streams, position = _seven_zip_number(header, position)
    sizes = []
    while header[position] != _K_END:
        prop = header[position]
        position += 1
        if prop != _K_SIZE:
            break
        for _ in range(streams):
            value, position = _seven_zip_number(header, position)
            sizes.append(value)
        break
    if len(sizes) != streams or not sizes:
        raise Unmeasurable("the archive's encoded header names no packed size")
    packed = 32 + pack_position
    pieces.append((packed, read(packed, sum(sizes))))
    return pieces


def seven_zip_members(
    client: httpx.Client, asset: dict, lister: Path, scratch: Path
) -> list[sevenzip.Member]:
    """Every member of a 7z on GitHub, as `7zz` lists it, read from its
    headers alone."""
    reader = RangeReader(client, asset["browser_download_url"], asset["size"])
    pieces = seven_zip_header_pieces(reader.range)
    sparse = scratch / "headers.7z"
    with sparse.open("wb") as out:
        out.truncate(asset["size"])
        for offset, data in pieces:
            out.seek(offset)
            out.write(data)
    try:
        return sevenzip.list_members(lister, sparse)
    except sevenzip.ArchiveRefused as exc:
        raise Unmeasurable(f"{asset['name']}: {exc}") from exc
    finally:
        sparse.unlink(missing_ok=True)


def fetch_lister(client: httpx.Client, scratch: Path) -> Path:
    """7-Zip's `7zz` for Linux, held to its pinned size and digest."""
    response = client.get(SEVEN_ZIP["url"])
    response.raise_for_status()
    data = response.content
    if len(data) != SEVEN_ZIP["size"] or hashlib.sha256(data).hexdigest() != SEVEN_ZIP["sha256"]:
        raise Unmeasurable(f"{SEVEN_ZIP['url']} is not the 7-Zip this script pins")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as untarred:
        member = untarred.extractfile("7zz")
        if member is None:
            raise Unmeasurable("7-Zip's archive has no 7zz")
        lister = scratch / "7zz"
        lister.write_bytes(member.read())
    lister.chmod(lister.stat().st_mode | stat.S_IXUSR)
    return lister


# -- measuring a pin ------------------------------------------------------------------------


@dataclass
class Measured:
    """A program's pin as measured: its manifest entry and for ComfyUI the
    runtime and the locks the Linux builds need."""

    entry: dict
    runtimes: list[dict] | None = None
    locks: dict[str, bytes] | None = None
    #: What a reviewer reads in the pull request, per build where it varies.
    notes: dict = field(default_factory=dict)


def measure_ffmpeg(client: httpx.Client, release: Release, pinned: dict) -> Measured:
    checksums = _checksums(client, release, "checksums.sha256")
    entry = copy.deepcopy(pinned)
    entry["version"] = release.version
    for asset in entry["assets"]:
        published = release.assets[asset["platform"]]
        digest = _digest_of(published)
        if checksums is not None and checksums.get(published["name"]) != digest:
            raise Unmeasurable(f"{published['name']}'s digest is not the one checksums.sha256 has")
        asset["url"] = published["browser_download_url"]
        asset["size"] = published["size"]
        asset["sha256"] = digest
        if asset["format"] == "zip":
            sizes = {
                info.filename: info.file_size
                for info in zip_listing(client, published)
                if not info.is_dir()
            }
        else:
            size, sha256, entries = tar_stream(client, published)
            if (size, sha256) != (published["size"], digest):
                raise Unmeasurable(f"{published['name']} does not hash to GitHub's digest")
            sizes = {e.name: e.size for e in entries if e.kind == "file"}
        top = f"ffmpeg-{release.describe}-{_ffmpeg_target(asset['platform'])}-lgpl-"
        for kept in asset["files"]:
            found = [
                name
                for name in sizes
                if name.startswith(top)
                and re.fullmatch(rf"[^/]+/bin/{re.escape(kept['path'])}", name)
            ]
            if len(found) != 1:
                raise Unmeasurable(f"{published['name']} has {len(found)} {kept['path']}")
            kept["member"] = found[0]
            kept["size"] = sizes[found[0]]
    return Measured(entry=entry)


def _ffmpeg_target(platform: str) -> str:
    return next(target for target, name in _FFMPEG_TARGETS.items() if name == platform)


def _checksums(client: httpx.Client, release: Release, name: str) -> dict[str, str] | None:
    """A release's own list of SHA-256 sums, by file name, where it has one."""
    asset = release.all_assets.get(name)
    if asset is None:
        return None
    response = client.get(asset["browser_download_url"])
    response.raise_for_status()
    sums = {}
    for line in response.text.splitlines():
        digest, _, file_name = line.strip().partition(" ")
        if re.fullmatch(r"[0-9a-f]{64}", digest):
            sums[file_name.strip().lstrip("*").removeprefix("./")] = digest
    return sums


def measure_ollama(client: httpx.Client, release: Release, pinned: dict) -> Measured:
    checksums = _checksums(client, release, "sha256sum.txt")
    entry = copy.deepcopy(pinned)
    entry["version"] = release.version
    for asset in entry["assets"]:
        published = release.assets[asset["platform"]]
        digest = _digest_of(published)
        if checksums is not None and checksums.get(published["name"]) not in (None, digest):
            raise Unmeasurable(f"{published['name']}'s digest is not the one sha256sum.txt has")
        asset["url"] = published["browser_download_url"]
        asset["size"] = published["size"]
        asset["sha256"] = digest
        files = []
        if asset["format"] == "zip":
            for info in zip_listing(client, published):
                if info.is_dir():
                    continue
                files.append(
                    {
                        "member": info.filename,
                        "path": info.filename.replace("\\", "/"),
                        "size": info.file_size,
                    }
                )
        else:
            size, sha256, entries = tar_stream(client, published)
            if (size, sha256) != (published["size"], digest):
                raise Unmeasurable(f"{published['name']} does not hash to GitHub's digest")
            for item in entries:
                path = item.name.removeprefix("./")
                if item.kind == "folder":
                    continue
                if item.kind == "other":
                    raise Unmeasurable(f"{published['name']}: {item.name} is not a file or a link")
                if item.kind == "link":
                    files.append({"member": item.name, "path": path, "size": 0, "link": item.link})
                else:
                    files.append({"member": item.name, "path": path, "size": item.size})
        empty = [kept["member"] for kept in files if kept["size"] == 0 and "link" not in kept]
        if empty:
            raise Unmeasurable(f"{published['name']} has empty files a pin cannot keep: {empty}")
        asset["files"] = sorted(files, key=lambda kept: kept["member"])
    return Measured(entry=entry)


_TORCH = re.compile(r"python_embeded[/\\]Lib[/\\]site-packages[/\\]torch-([^/\\]+)\.dist-info")
_PYTHON = re.compile(r"python_embeded[/\\]python3(\d+)\.dll")


def measure_comfyui_windows(
    client: httpx.Client, release: Release, pinned: dict, lister: Path, scratch: Path
) -> tuple[list[dict], dict]:
    assets = []
    notes = {}
    for asset in pinned["assets"]:
        if asset["platform"] != "windows-x64":
            continue
        key = (asset.get("gpu"), asset.get("build"))
        published = release.assets[key]
        members = seven_zip_members(client, published, lister, scratch)
        roots = {re.split(r"[/\\]", member.path)[0] for member in members}
        if len(roots) != 1:
            raise Unmeasurable(f"{published['name']} has {len(roots)} top folders")
        files = [member for member in members if not member.folder]
        tree = {
            "root": roots.pop(),
            "files": len(files),
            "bytes": sum(member.size for member in files),
        }
        try:
            sevenzip.check_members(members, KeptTree(**tree))
        except sevenzip.ArchiveRefused as exc:
            raise Unmeasurable(f"{published['name']}: {exc}") from exc
        measured = copy.deepcopy(asset)
        measured["url"] = published["browser_download_url"]
        measured["size"] = published["size"]
        measured["sha256"] = _digest_of(published)
        measured["tree"] = tree
        assets.append(measured)
        torch = next((m.group(1) for p in members if (m := _TORCH.search(p.path))), None)
        python = next((m.group(1) for p in members if (m := _PYTHON.search(p.path))), None)
        notes["/".join(part or "usual" for part in key)] = {
            "torch": torch,
            "python": f"3.{python}" if python else None,
        }
    return assets, notes


@dataclass(frozen=True)
class Tree:
    """The checkout a pin reads and writes."""

    root: Path

    @property
    def manifest(self) -> Path:
        return self.root / "engine/src/localcut_engine/programs/programs-manifest.json"

    @property
    def locks(self) -> Path:
        return self.root / "engine/src/localcut_engine/programs/locks"

    @property
    def dockerfile(self) -> Path:
        return self.root / "engine/Dockerfile"

    @property
    def docs(self) -> Path:
        return self.root / "docs/programs.md"


def lock_settings(tree: Tree, manifest: dict) -> dict:
    """What the Linux locks were made with: the Python, its
    python-build-standalone release, PyTorch and uv. A ComfyUI bump keeps
    all four."""
    runtime = next(
        r for r in manifest["runtimes"] if (r["id"], r["platform"]) == ("cpython", "linux-x64")
    )
    release = re.search(r"/releases/download/(\d+)/", runtime["url"])
    if release is None:
        raise Unmeasurable(f"the Python's pin is not a release download: {runtime['url']}")
    torches, uvs = set(), set()
    for path in sorted(tree.locks.glob("pylock.comfyui-*.toml")):
        document = tomllib.loads(path.read_text(encoding="utf-8"))
        uvs.add(document["tool"]["localcut"]["uv"])
        torches |= {
            p["version"].split("+")[0] for p in document["packages"] if p["name"] == "torch"
        }
    if len(torches) != 1 or len(uvs) != 1:
        raise Unmeasurable(f"the locks disagree: PyTorch {sorted(torches)}, uv {sorted(uvs)}")
    return {
        "python": runtime["version"],
        "python_release": release.group(1),
        "torch": torches.pop(),
        "uv": uvs.pop(),
    }


def measure_comfyui_linux(
    tree: Tree, version: str, manifest: dict, settings: dict, uv: str, scratch: Path, hold: bool
) -> tuple[list[dict], list[dict], dict[str, bytes]]:
    """Run lock-comfyui-linux.py into `scratch`: (the Linux assets, the
    runtimes, the locks by file name). `hold` keeps every package at the
    version the current locks have, which makes them again."""
    out = scratch / "linux"
    out.mkdir()
    staged = out / "manifest.json"
    staged.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    command = [
        sys.executable,
        str(ENGINE / "scripts" / "lock-comfyui-linux.py"),
        "--comfyui",
        version,
        "--python",
        settings["python"],
        "--python-release",
        settings["python_release"],
        "--torch",
        settings["torch"],
        "--manifest",
        str(staged),
        "--locks",
        str(out / "locks"),
        "--uv",
        uv,
    ]
    if hold:
        command += ["--versions-from", str(tree.locks)]
    # A wheel whose CDN will not answer Range requests is downloaded whole
    # into the temp folder: the work folder, not a /tmp that may be memory.
    done = subprocess.run(command, check=False, env={**os.environ, "TMPDIR": str(out)})
    if done.returncode != 0:
        raise Unmeasurable(f"lock-comfyui-linux.py failed for ComfyUI {version}")
    written = json.loads(staged.read_text(encoding="utf-8"))
    comfy = next(p for p in written["programs"] if p["id"] == "comfyui")
    assets = [a for a in comfy["assets"] if a["platform"] == "linux-x64"]
    locks = {path.name: path.read_bytes() for path in sorted((out / "locks").iterdir())}
    return assets, written["runtimes"], locks


def measure_comfyui(
    client: httpx.Client,
    tree: Tree,
    release: Release,
    manifest: dict,
    lister: Path,
    uv: str,
    scratch: Path,
    *,
    hold: bool,
) -> Measured:
    pinned = next(p for p in manifest["programs"] if p["id"] == "comfyui")
    windows, notes = measure_comfyui_windows(client, release, pinned, lister, scratch)
    settings = lock_settings(tree, manifest)
    linux, runtimes, locks = measure_comfyui_linux(
        tree, release.version, manifest, settings, uv, scratch, hold
    )
    entry = copy.deepcopy(pinned)
    entry["version"] = release.version
    entry["assets"] = windows + linux
    return Measured(entry=entry, runtimes=runtimes, locks=locks, notes=notes)


def uv_for_locks(tree: Tree, manifest: dict, uv: str) -> str:
    """The uv to make the locks with: the one they were made with, so the
    locks a run makes again are the same files."""
    wanted = lock_settings(tree, manifest)["uv"]
    if shutil.which(uv) is None:
        raise Unmeasurable(f"{uv} is not on PATH; ComfyUI's locks need uv {wanted}")
    said = subprocess.run([uv, "--version"], capture_output=True, text=True, check=True).stdout
    have = said.split()[1] if len(said.split()) > 1 else said.strip()
    if have != wanted:
        raise Unmeasurable(
            f"the locks were made with uv {wanted} and {uv} is uv {have}; pass --uv with uv "
            f"{wanted}, or move the locks to another uv by hand with lock-comfyui-linux.py"
        )
    return uv


# -- comparing and writing ------------------------------------------------------------------


def differences(measured: Measured, manifest: dict, tree: Tree, program: str) -> list[str]:
    """Where a measurement of the pinned release differs from the pin."""
    pinned = next(p for p in manifest["programs"] if p["id"] == program)
    found = _diff(pinned, measured.entry, program)
    if measured.runtimes is not None:
        found += _diff(manifest["runtimes"], measured.runtimes, "runtimes")
    if measured.locks is not None:
        have = {p.name: p.read_bytes() for p in sorted(tree.locks.glob("pylock.*.toml"))}
        if sorted(have) != sorted(measured.locks):
            found.append(f"locks: {sorted(have)} pinned, {sorted(measured.locks)} made")
        for name in sorted(set(have) & set(measured.locks)):
            if have[name] != measured.locks[name]:
                found.append(f"locks/{name} differs from the one made again")
    return found


def _diff(before: object, after: object, where: str) -> list[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        out = []
        for key in sorted(set(before) | set(after)):
            if key not in after:
                out.append(f"{where}.{key}: pinned, not measured")
            elif key not in before:
                out.append(f"{where}.{key}: measured, not pinned")
            else:
                out += _diff(before[key], after[key], f"{where}.{key}")
        return out
    if isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            return [f"{where}: {len(before)} pinned, {len(after)} measured"]
        out = []
        for index, (one, other) in enumerate(zip(before, after, strict=True)):
            out += _diff(one, other, f"{where}[{index}]")
        return out
    return [] if before == after else [f"{where}: pinned {before!r}, measured {after!r}"]


_DOCKER_URL = re.compile(r"^ARG FFMPEG_URL=(\S+)$", re.MULTILINE)
_DOCKER_SHA = re.compile(r"^ARG FFMPEG_SHA256=([0-9a-f]{64})$", re.MULTILINE)


# -- docs/programs.md -----------------------------------------------------------------------


def _gib(value: int, places: int = 2) -> str:
    return f"{value / 2**30:.{places}f}"


def _record_bytes(program: dict, asset: dict) -> int:
    """What a copy of this build records as its size: its files and the
    record itself, as the engine writes it."""
    from localcut_engine.programs import setup
    from localcut_engine.programs.manifest import ProgramAsset, ProgramPin

    pin = ProgramPin.model_validate({**program, "assets": [asset]})
    with tempfile.TemporaryDirectory(prefix="pin-programs-") as folder:
        setup._write_record(Path(folder), pin, ProgramAsset.model_validate(asset))
        return json.loads((Path(folder) / setup.RECORD).read_text(encoding="utf-8"))["bytes"]


def doc_facts(manifest: dict, locks: dict[str, bytes]) -> dict:
    """What docs/programs.md states about the pins, given the manifest and
    the Linux locks (by file name): the prose by name and the JSON examples
    by path."""
    programs = {p["id"]: p for p in manifest["programs"]}
    ffmpeg, ollama, comfy = programs["ffmpeg"], programs["ollama"], programs["comfyui"]

    def asset(program: dict, platform: str, gpu: str | None = None, build: str | None = None):
        return next(
            a
            for a in program["assets"]
            if (a["platform"], a.get("gpu"), a.get("build")) == (platform, gpu, build)
        )

    def files_bytes(entry: dict) -> int:
        return sum(kept["size"] for kept in entry["files"])

    runtime = next(
        r for r in manifest["runtimes"] if (r["id"], r["platform"]) == ("cpython", "linux-x64")
    )
    extractor = next(
        e for e in manifest["extractors"] if (e["format"], e["platform"]) == ("7z", "windows-x64")
    )

    def linux_download(entry: dict) -> int:
        return entry["size"] + runtime["size"] + entry["environment"]["wheel_bytes"]

    ffmpeg_linux = asset(ffmpeg, "linux-x64")
    ollama_win, ollama_linux = asset(ollama, "windows-x64"), asset(ollama, "linux-x64")
    portable = {
        key: asset(comfy, "windows-x64", *key) for key in COMFYUI_PORTABLE if key[0] is not None
    }
    linux = {key: asset(comfy, "linux-x64", *key) for key in COMFYUI_LOCKS}
    others = [entry["tree"]["bytes"] for key, entry in portable.items() if key != ("nvidia", None)]
    usual = portable[("nvidia", None)]
    torches = {
        version.split("+")[0]
        for text in locks.values()
        for name, version in _lock_packages(text).items()
        if name == "torch"
    }
    ffmpeg_record = _record_bytes(ffmpeg, ffmpeg_linux)
    ollama_record = _record_bytes(ollama, ollama_linux)
    # n9.0.2-17-g2a571b6068, from ffmpeg-n9.0.2-17-g2a571b6068-linux64-lgpl-9.0/bin/...
    top = ffmpeg_linux["files"][0]["member"].split("/")[0]
    prose = {
        "ffmpeg.version": ffmpeg["version"],
        "ffmpeg.describe": top.removeprefix("ffmpeg-").rsplit("-linux64-lgpl-", 1)[0],
        "ollama.version": ollama["version"],
        "ollama.windows.gib": _gib(ollama_win["size"]),
        "ollama.windows.unpacked": _gib(files_bytes(ollama_win)),
        "ollama.linux.gib": _gib(ollama_linux["size"]),
        "ollama.linux.unpacked": _gib(files_bytes(ollama_linux)),
        "ollama.links": str(sum(1 for kept in ollama_linux["files"] if kept.get("link"))),
        "comfyui.version": comfy["version"],
        "comfyui.nvidia.files": f"{usual['tree']['files']:,}",
        "comfyui.nvidia.gib": _gib(usual["tree"]["bytes"], 1),
        "comfyui.others.low": _gib(min(others)),
        "comfyui.others.high": _gib(max(others)),
        "python.version": runtime["version"],
        "python.size": f"{runtime['size']:,}",
        "comfyui.source.size": f"{linux[('nvidia', None)]['size']:,}",
        "torch.version": ",".join(sorted(torches)),
        "7zr.version": extractor["version"],
    }
    for key, name in COMFYUI_LOCKS.items():
        entry = linux[key]
        prose[f"table.{name}.wheels"] = str(entry["environment"]["wheels"])
        prose[f"table.{name}.download"] = f"{linux_download(entry):,}"
        prose[f"table.{name}.unpacked"] = f"{entry['environment']['bytes']:,}"
        prose[f"table.{name}.files"] = f"{entry['environment']['files']:,}"
    cu130, cu126, cpu = (
        linux[("nvidia", None)],
        linux[("nvidia", "older_drivers")],
        linux[(None, "cpu")],
    )
    older = portable[("nvidia", "older_drivers")]
    report = {
        ("programs_bytes",): ffmpeg_record + ollama_record,
        ("programs", 0, "version"): ffmpeg["version"],
        ("programs", 0, "managed", "bytes"): ffmpeg_record,
        ("programs", 0, "managed", "version"): ffmpeg["version"],
        ("programs", 0, "setup", "version"): ffmpeg["version"],
        ("programs", 0, "setup", "download_bytes"): ffmpeg_linux["size"],
        ("programs", 0, "setup", "install_bytes"): files_bytes(ffmpeg_linux),
        ("programs", 1, "version"): ollama["version"],
        ("programs", 1, "managed", "bytes"): ollama_record,
        ("programs", 1, "managed", "version"): ollama["version"],
        ("programs", 1, "setup", "version"): ollama["version"],
        ("programs", 1, "setup", "url"): ollama_linux["url"],
        ("programs", 1, "setup", "download_bytes"): ollama_linux["size"],
        ("programs", 1, "setup", "install_bytes"): files_bytes(ollama_linux),
        ("programs", 2, "setup", "version"): comfy["version"],
        ("programs", 2, "setup", "url"): cu130["url"],
        ("programs", 2, "setup", "download_bytes"): linux_download(cu130),
        ("programs", 2, "setup", "install_bytes"): cu130["environment"]["bytes"],
        ("programs", 2, "setup", "builds", 0, "download_bytes"): linux_download(cu126),
        ("programs", 2, "setup", "builds", 0, "install_bytes"): cu126["environment"]["bytes"],
        ("programs", 2, "setup", "builds", 1, "download_bytes"): linux_download(cpu),
        ("programs", 2, "setup", "builds", 1, "install_bytes"): cpu["environment"]["bytes"],
    }
    windows = {
        ("version",): comfy["version"],
        ("url",): usual["url"],
        ("download_bytes",): usual["size"] + extractor["size"],
        ("install_bytes",): usual["tree"]["bytes"],
        ("builds", 0, "download_bytes"): older["size"] + extractor["size"],
        ("builds", 0, "install_bytes"): older["tree"]["bytes"],
    }
    events = {
        ("program.setup.progress", "ffmpeg", "total"): ffmpeg_linux["size"],
        ("program.setup.done", "ffmpeg", "version"): ffmpeg["version"],
        ("program.removed", "ffmpeg", "freed_bytes"): ffmpeg_record,
        ("program.setup.done", "ollama", "version"): ollama["version"],
    }
    return {"prose": prose, "report": report, "windows": windows, "events": events}


_V = r"\d+(?:\.\d+)+"
_N = r"[\d,]+"
#: Each sentence of docs/programs.md that states a pinned figure, with the
#: facts its groups hold, in order.
DOC_SITES: list[tuple[str, tuple[str, ...]]] = [
    (rf"`({_V})` for FFmpeg's\s+`(n[^`]+)`", ("ffmpeg.version", "ffmpeg.describe")),
    (rf"\[Ollama's own releases\]\([^)]*\), version\s+({_V})\.", ("ollama.version",)),
    (
        r"`ollama-windows-amd64\.zip` on Windows \((\d+\.\d\d) GiB,\s+(\d+\.\d\d) GiB unpacked\)",
        ("ollama.windows.gib", "ollama.windows.unpacked"),
    ),
    (
        r"`ollama-linux-amd64\.tar\.zst` on Linux \((\d+\.\d\d) GiB,\s+(\d+\.\d\d) GiB unpacked\)",
        ("ollama.linux.gib", "ollama.linux.unpacked"),
    ),
    (r"On Linux that includes the (\d+) links", ("ollama.links",)),
    (
        rf"\[Comfy-Org/ComfyUI's releases\]\([^)]*\),\s+version ({_V}), pinned",
        ("comfyui.version",),
    ),
    (rf"`7zr\.exe` ({_V})", ("7zr.version",)),
    (
        rf"The copy is the whole portable folder: ({_N}) files and about (\d+\.\d) GiB for\s+"
        r"NVIDIA's usual build, (\d+\.\d\d) to (\d+\.\d\d) GiB for the others\.",
        (
            "comfyui.nvidia.files",
            "comfyui.nvidia.gib",
            "comfyui.others.low",
            "comfyui.others.high",
        ),
    ),
    (rf"Those are ComfyUI ({_V})'s own flags\.", ("comfyui.version",)),
    (rf"a standalone CPython, ({_V}) from", ("python.version",)),
    (r"\(its `install_only_stripped` build, ([\d,]+) bytes\)", ("python.size",)),
    (
        rf"ComfyUI's source at the v({_V}) tag, as GitHub's archive of the tag\s+\(({_N}) bytes\)",
        ("comfyui.version", "comfyui.source.size"),
    ),
    (rf"Every build has PyTorch ({_V}):", ("torch.version",)),
    *(
        (
            rf"\| `{name}`[^|\n]*\|[^|\n]*\| (\d+) \| ({_N}) \| ({_N}) \| ({_N}) \|",
            tuple(
                f"table.{name}.{column}" for column in ("wheels", "download", "unpacked", "files")
            ),
        )
        for name in COMFYUI_LOCKS.values()
    ),
]


class DocsDisagree(Exception):
    """docs/programs.md does not state the pin it is being moved from."""


def rewrite_docs(text: str, before: dict, after: dict) -> str:
    """docs/programs.md with every figure `before` gives replaced by the one
    `after` gives. Refused unless every sentence and example is where it
    is looked for and states `before`'s figure."""
    for pattern, keys in DOC_SITES:
        found = list(re.finditer(pattern, text))
        if len(found) != 1:
            raise DocsDisagree(f"docs/programs.md has {len(found)} places matching {pattern}")
        match = found[0]
        stated = match.groups()
        wanted = tuple(before["prose"][key] for key in keys)
        if stated != wanted:
            raise DocsDisagree(f"docs/programs.md says {stated} where the pin says {wanted}")
        pieces, last = [], match.start()
        for index, key in enumerate(keys, start=1):
            pieces += [text[last : match.start(index)], after["prose"][key]]
            last = match.end(index)
        pieces.append(text[last : match.end()])
        text = text[: match.start()] + "".join(pieces) + text[match.end() :]
    for kind in ("report", "windows", "events"):
        text = _rewrite_block(text, kind, before[kind], after[kind])
    return text


def json_blocks(text: str) -> dict[str, tuple[int, int, object]]:
    """The JSON examples docs/programs.md holds about pins: GET /programs on
    Linux, ComfyUI's setup on Windows and the /ws events, as (start, end,
    parsed). The events block is one object per line."""
    found = {}
    for match in re.finditer(r"```json\n(.*?)```", text, re.S):
        body = match.group(1)
        try:
            parsed = json.loads(body)
        except ValueError:
            lines = [json.loads(line) for line in body.splitlines() if line.strip()]
            if all(isinstance(line, dict) and "type" in line for line in lines):
                found["events"] = (match.start(1), match.end(1), lines)
            continue
        if isinstance(parsed, dict) and "programs" in parsed:
            found["report"] = (match.start(1), match.end(1), parsed)
        elif isinstance(parsed, dict) and str(parsed.get("url", "")).endswith(".7z"):
            found["windows"] = (match.start(1), match.end(1), parsed)
    return found


def _locate(document: object, kind: str, path: tuple) -> tuple[object, object]:
    """(the object holding the figure at `path`, its key in it)."""
    if kind == "events":
        event, program, key = path
        holders = [e for e in document if e.get("type") == event and e.get("program") == program]
        if len(holders) != 1:
            raise DocsDisagree(f"docs/programs.md has {len(holders)} {event} events for {program}")
        return holders[0], key
    for step in path[:-1]:
        document = document[step]  # type: ignore[index]
    return document, path[-1]


def _rewrite_block(text: str, kind: str, before: dict, after: dict) -> str:
    blocks = json_blocks(text)
    if kind not in blocks:
        raise DocsDisagree(f"docs/programs.md has no {kind} example")
    start, end, parsed = blocks[kind]
    expected = copy.deepcopy(parsed)
    for path, value in before.items():
        holder, key = _locate(parsed, kind, path)
        if holder[key] != value:  # type: ignore[index]
            stated = holder[key]  # type: ignore[index]
            raise DocsDisagree(f"docs/programs.md's {kind} example has {stated!r} at {path}")
        holder, key = _locate(expected, kind, path)
        holder[key] = after[path]  # type: ignore[index]
    body = text[start:end]
    for path, value in before.items():
        key = path[-1]
        body = body.replace(f'"{key}": {json.dumps(value)}', f'"{key}": {json.dumps(after[path])}')
    text = text[:start] + body + text[end:]
    # Every figure moved and nothing else did.
    if json_blocks(text).get(kind, (0, 0, None))[2] != expected:
        raise DocsDisagree(f"rewriting the {kind} example changed more than its figures")
    return text


def lock_texts(folder: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in sorted(folder.glob("pylock.*.toml"))}


def _lock_packages(text: bytes) -> dict[str, str]:
    document = tomllib.loads(text.decode("utf-8"))
    return {p["name"]: p["version"] for p in document["packages"]}


def _lock_requirements(text: bytes) -> list[str]:
    document = tomllib.loads(text.decode("utf-8"))
    return list(document["tool"]["localcut"]["comfyui"]["requirements"])


# -- what the pull request says -------------------------------------------------------------


def _files_bytes(asset: dict) -> int:
    return sum(kept["size"] for kept in asset["files"])


def _platform_line(asset: dict, before: dict | None) -> str:
    """One build's download and unpacked size beside what they were."""
    name = {"windows-x64": "Windows", "linux-x64": "Linux"}[asset["platform"]]
    kept = len(asset["files"])
    line = (
        f"{name}: {asset['url'].rsplit('/', 1)[-1]}, {asset['size']:,} bytes, keeping "
        f"{kept} files of {_files_bytes(asset):,} bytes"
    )
    if before is not None:
        line += (
            f" (was {before['size']:,} bytes and {len(before['files'])} files of "
            f"{_files_bytes(before):,} bytes)"
        )
    return line + "."


def _file_changes(before: dict, after: dict) -> list[str]:
    old = {kept["path"]: kept for kept in before["files"]}
    new = {kept["path"]: kept for kept in after["files"]}
    lines = []
    added, removed = sorted(set(new) - set(old)), sorted(set(old) - set(new))
    if added:
        lines.append("Files added: " + ", ".join(f"`{p}`" for p in added) + ".")
    if removed:
        lines.append("Files removed: " + ", ".join(f"`{p}`" for p in removed) + ".")
    return lines


def summarize(
    program: str,
    release: Release,
    before: dict,
    after: dict,
    measured: Measured,
    again: Measured,
    old_locks: dict[str, bytes],
    by_rule: bool,
) -> dict:
    """The commit message and the pull request's title and body. `by_rule`
    says the release is the one `check` takes, rather than one a person
    named."""
    name = NAMES[program]
    old_entry = next(p for p in before["programs"] if p["id"] == program)
    new_entry = measured.entry
    old_version, new_version = old_entry["version"], new_entry["version"]
    title = f"Pin {name} {new_version}"
    if program == "ffmpeg":
        title += f" from BtbN's {release.tag}"
    paragraphs = []
    checks = []
    if program == "ffmpeg":
        old_tag = pinned_release(program, old_entry)
        newest = "BtbN's newest month-end build" if by_rule else "that build of BtbN's"
        lead = (
            f"Moves LocalCut's own FFmpeg from {old_version} ({old_tag}) to {new_version} "
            f"({release.tag}), the LGPL build of the newest FFmpeg release branch in {newest} "
            f"({release.page}). engine/Dockerfile pins the same Linux build."
        )
        method = (
            "scripts/pin-programs.py took each size and SHA-256 from GitHub's asset digest, "
            "which matches the release's checksums.sha256. It read the sizes of the kept "
            "ffmpeg and ffprobe from the archives: the zip's central directory over HTTP range "
            f"requests and the tar.xz streamed once and hashed. Measured the same way, {old_tag} "
            "came out as the pin it replaces, byte for byte."
        )
        paragraphs += [lead, method]
        for asset in new_entry["assets"]:
            old = next(a for a in old_entry["assets"] if a["platform"] == asset["platform"])
            paragraphs.append(_platform_line(asset, old))
        if old_version.split(".")[:2] != new_version.split(".")[:2]:
            checks.append(
                f"This moves to the {'.'.join(new_version.split('.')[:2])} release branch. Read "
                "FFmpeg's Changelog for removed filters, encoders or options the engine passes "
                "(backends/ffmpeg.py)."
            )
        smoke = (
            "Programs smoke sets this build up on Linux and Windows runners, checks that it "
            "draws text and exports a placeholder project to an MP4 that its ffmpeg decodes."
        )
    elif program == "ollama":
        newest = ", the newest release that is not a prerelease" if by_rule else ""
        lead = (
            f"Moves LocalCut's own Ollama from {old_version} to {new_version}{newest} "
            f"({release.page})."
        )
        method = (
            "scripts/pin-programs.py measured every kept file of both archives: the Windows "
            "zip's central directory over HTTP range requests and the Linux tarball streamed "
            "once while hashing it, which matched GitHub's digest. Measured the same way, "
            f"{old_version} came out as the pin it replaces, byte for byte."
        )
        paragraphs += [lead, method]
        for asset in new_entry["assets"]:
            old = next(a for a in old_entry["assets"] if a["platform"] == asset["platform"])
            paragraphs.append(_platform_line(asset, old))
            paragraphs += [f"{asset['platform']}: {line}" for line in _file_changes(old, asset)]
        checks += [
            "The CUDA driver and compute capability floors in "
            "engine/src/localcut_engine/programs/ollama.py were read from Ollama "
            f"{old_version}'s source (discover/ and the build presets). Read them again for "
            f"{new_version}, then update the comment there and the sentence in "
            "docs/programs.md that names the version they hold for.",
            "OLLAMA_NO_CLOUD has to still stop every call Ollama makes to ollama.com by "
            f"itself in {new_version}. The comment on OFFLINE in ollama.py and the paragraph "
            "on cloud features in docs/programs.md name the version that was checked.",
        ]
        smoke = (
            "Programs smoke sets this build up on Linux and Windows runners, pulls qwen3:0.6b "
            "into it and gets an answer on the processor. Nothing here ran it on a GPU."
        )
    else:
        lead = (
            f"Moves LocalCut's own ComfyUI from {old_version} to {new_version} on Windows and "
            f"Linux ({release.page})."
        )
        if by_rule:
            lead += (
                f" It is the newest release. It came out {release.published[:10]}, three or "
                "more days ago."
            )
        method = (
            "scripts/pin-programs.py took each portable build's size and SHA-256 from GitHub's "
            "digest and counted what it unpacks to from its headers alone: range requests for "
            "the start header, the end header and the packed header, written into a sparse "
            f"file that 7-Zip {SEVEN_ZIP['version']} (7zz) listed and the engine's own "
            "parse_listing and check_members counted. The Linux locks are "
            "lock-comfyui-linux.py's, with the Python, the PyTorch and the uv the locks had. "
            "Measured "
            f"the same way, {old_version} came out as the pin it replaces, byte for byte, "
            "locks included."
        )
        paragraphs += [lead, method]
        rows = ["| Windows build | files, bytes before | files, bytes now | PyTorch, Python |"]
        rows.append("|---|---|---|---|")
        for asset in new_entry["assets"]:
            if asset["platform"] != "windows-x64":
                continue
            key = "/".join(part or "usual" for part in (asset.get("gpu"), asset.get("build")))
            old = next(
                a
                for a in old_entry["assets"]
                if (a["platform"], a.get("gpu"), a.get("build"))
                == (asset["platform"], asset.get("gpu"), asset.get("build"))
            )
            was, now = again.notes.get(key, {}), measured.notes.get(key, {})
            stack = f"{now.get('torch')}, {now.get('python')}"
            if (was.get("torch"), was.get("python")) != (now.get("torch"), now.get("python")):
                stack += f" (was {was.get('torch')}, {was.get('python')})"
                checks.append(
                    f"The {key} portable build moves from PyTorch {was.get('torch')} to "
                    f"{now.get('torch')}. Check that its `requires` (driver and compute "
                    "capability) in programs-manifest.json still hold."
                )
            rows.append(
                f"| {key} | {old['tree']['files']:,}, {old['tree']['bytes']:,} | "
                f"{asset['tree']['files']:,}, {asset['tree']['bytes']:,} | {stack} |"
            )
        paragraphs.append("\n".join(rows))
        rows = ["| Linux lock | wheels | download | unpacked | files |", "|---|---|---|---|---|"]
        runtime = next(r for r in after["runtimes"] if r["id"] == "cpython")
        for asset in new_entry["assets"]:
            if asset["platform"] != "linux-x64":
                continue
            env = asset["environment"]
            download = asset["size"] + runtime["size"] + env["wheel_bytes"]
            rows.append(
                f"| {env['lock']} | {env['wheels']} | {download:,} | {env['bytes']:,} | "
                f"{env['files']:,} |"
            )
        paragraphs.append("\n".join(rows))
        new_locks = measured.locks or {}
        cpu = "pylock.comfyui-cpu.toml"
        if cpu in old_locks and cpu in new_locks:
            old_req, new_req = (
                _lock_requirements(old_locks[cpu]),
                _lock_requirements(new_locks[cpu]),
            )
            moved = [f"`{line}`" for line in new_req if line not in old_req]
            gone = [f"`{line}`" for line in old_req if line not in new_req]
            if moved or gone:
                paragraphs.append(
                    "requirements.txt "
                    + "; ".join(
                        part
                        for part in (
                            f"now asks for {', '.join(moved)}" if moved else "",
                            f"no longer asks for {', '.join(gone)}" if gone else "",
                        )
                        if part
                    )
                    + "."
                )
        changed: dict[str, tuple[str, str]] = {}
        for lock, text in new_locks.items():
            if lock not in old_locks:
                continue
            old_packages, new_packages = _lock_packages(old_locks[lock]), _lock_packages(text)
            for package, version in new_packages.items():
                if package in old_packages and old_packages[package] != version:
                    changed.setdefault(package, (old_packages[package], version))
        if changed:
            paragraphs.append(
                "Packages the locks move: "
                + ", ".join(f"{p} {a} to {b}" for p, (a, b) in sorted(changed.items()))
                + "."
            )
        checks.append("A real render on a machine with a GPU, which no runner has.")
        smoke = (
            "Programs smoke sets up the processor's build on Linux, starts it and checks that "
            "its /object_info has every node and input the workflow templates use. On Windows "
            "it takes each portable build through the download, the digest, the listing, the "
            "unpack and the walk, up to the device check, which fails on a runner with no card."
        )
    body = [*paragraphs, smoke]
    if checks:
        body += ["Before merging, a person checks:", "\n".join(f"- {c}" for c in checks)]
    commit = "\n\n".join(_wrap(p) for p in paragraphs[:2])
    return {"title": title, "body": "\n\n".join(body) + "\n", "commit": f"{title}\n\n{commit}\n"}


def _wrap(paragraph: str) -> str:
    return textwrap.fill(paragraph, width=72, break_long_words=False, break_on_hyphens=False)


# -- the commands ---------------------------------------------------------------------------


def _entry(manifest: dict, program: str) -> dict:
    return next(p for p in manifest["programs"] if p["id"] == program)


def _describe(release: Release, pin: dict) -> dict:
    return {
        "program": release.program,
        "pinned": pin["version"],
        "pinned_release": pinned_release(release.program, pin),
        "version": release.version,
        "release": release.tag,
        "published": release.published,
        "branch": release.branch,
        "page": release.page,
    }


def check_report(
    client: httpx.Client,
    manifest: dict,
    now: datetime.datetime,
    skip_existing: str | None,
    program: str | None = None,
    version: str | None = None,
) -> dict:
    """What `check` prints: the releases newer than their pins (`newer`),
    a newer ComfyUI waiting out its three days (`held`) and with
    `skip_existing`, the newer ones already proposed (`skipped`). `program`
    looks at that one alone and `version` at that release of it, which
    passes over the rules for which release a pin takes."""
    report: dict = {"checked": now.isoformat(timespec="seconds"), "newer": [], "held": []}
    if skip_existing:
        report["skipped"] = []
    for program in (program,) if program else PROGRAMS:
        pin = _entry(manifest, program)
        if version:
            release, held = release_named(client, program, version), None
        else:
            release, held = upstream(client, program, now)
        if held is not None and is_newer(program, held, pin):
            published = datetime.datetime.fromisoformat(held.published.replace("Z", "+00:00"))
            report["held"].append(
                {
                    **_describe(held, pin),
                    "reason": "less than three days old; it is pinned from "
                    + (published + COMFYUI_MIN_AGE).isoformat(timespec="minutes"),
                }
            )
        if release is None or not is_newer(program, release, pin):
            continue
        entry = _describe(release, pin)
        if skip_existing:
            reason = existing_proposal(client, skip_existing, release.branch)
            if reason is not None:
                report["skipped"].append({**entry, "reason": reason})
                continue
        report["newer"].append(entry)
    return report


def command_check(args: argparse.Namespace) -> int:
    manifest = json.loads(Tree(args.root).manifest.read_text(encoding="utf-8"))
    if args.version and not args.program:
        raise Unmeasurable("--version names a release of the program --program names")
    with github_client() as client:
        report = check_report(
            client,
            manifest,
            datetime.datetime.now(datetime.UTC),
            args.skip_existing,
            args.program,
            args.version,
        )
    print(json.dumps(report, indent=2))
    return 0


def _measure(
    client: httpx.Client,
    tree: Tree,
    program: str,
    release: Release,
    manifest: dict,
    scratch: Path,
    *,
    hold: bool,
    lister: Path | None,
    uv: str | None,
) -> Measured:
    pinned = _entry(manifest, program)
    if program == "ffmpeg":
        return measure_ffmpeg(client, release, pinned)
    if program == "ollama":
        return measure_ollama(client, release, pinned)
    assert lister is not None and uv is not None
    return measure_comfyui(client, tree, release, manifest, lister, uv, scratch, hold=hold)


def command_pin(args: argparse.Namespace) -> int:
    tree = Tree(args.root)
    program = args.program
    manifest = json.loads(tree.manifest.read_text(encoding="utf-8"))
    pinned = _entry(manifest, program)
    now = datetime.datetime.now(datetime.UTC)
    if args.work:
        args.work.mkdir(parents=True, exist_ok=True)
    with (
        github_client() as client,
        tempfile.TemporaryDirectory(prefix="pin-programs-", dir=args.work) as scratch_dir,
    ):
        scratch = Path(scratch_dir)
        current = release_named(client, program, pinned_release(program, pinned))
        by_rule, held = upstream(client, program, now)
        if args.again:
            target = current
        elif args.version:
            target = release_named(client, program, args.version)
        elif by_rule is not None:
            target = by_rule
        else:
            waiting = f"; {held.tag} is held until it is three days old" if held else ""
            raise Unmeasurable(f"upstream has no {NAMES[program]} a pin takes{waiting}")
        lister = uv = None
        if program == "comfyui":
            uv = uv_for_locks(tree, manifest, args.uv)
            extractor = next(e for e in manifest["extractors"] if e["format"] == "7z")
            if extractor["version"] != SEVEN_ZIP["version"]:
                raise Unmeasurable(
                    f"setups unpack with 7-Zip {extractor['version']} and this script lists "
                    f"with {SEVEN_ZIP['version']}; move SEVEN_ZIP with the manifest's extractor"
                )
            lister = fetch_lister(client, scratch)

        print(
            f"measuring the pinned {NAMES[program]} {pinned['version']} ({current.tag})", flush=True
        )
        again = _measure(
            client, tree, program, current, manifest, scratch, hold=True, lister=lister, uv=uv
        )
        problems = differences(again, manifest, tree, program)
        if problems:
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            raise SystemExit(
                f"measured again, {NAMES[program]} {pinned['version']} does not come out as its "
                "pin, so this method cannot be trusted with the next one. Nothing was written."
            )
        print("  the same as the pin, byte for byte", flush=True)
        if target.tag == current.tag:
            measured = again
        else:
            print(f"measuring {NAMES[program]} {target.version} ({target.tag})", flush=True)
            measured = _measure(
                client, tree, program, target, manifest, scratch, hold=False, lister=lister, uv=uv
            )

        old_locks = lock_texts(tree.locks)
        new_locks = {**old_locks, **(measured.locks or {})}
        updated = copy.deepcopy(manifest)
        updated["programs"] = [
            measured.entry if p["id"] == program else p for p in manifest["programs"]
        ]
        if measured.runtimes is not None:
            updated["runtimes"] = measured.runtimes
        changed = updated != manifest or new_locks != old_locks
        if changed:
            updated["updated"] = now.date().isoformat()
        text = json.dumps(updated, indent=2) + "\n"
        try:
            parse_programs_manifest(text)
        except ValueError as exc:
            raise Unmeasurable(
                f"{NAMES[program]} {target.version} was measured, and the manifest refuses it "
                f"as measured. Nothing was written. {exc}"
            ) from exc
        # Everything is worked out before anything is written, so a refusal
        # leaves the checkout as it was.
        docs = rewrite_docs(
            tree.docs.read_text(encoding="utf-8"),
            doc_facts(manifest, old_locks),
            doc_facts(updated, new_locks),
        )
        dockerfile = None
        if program == "ffmpeg":
            dockerfile = docker_pin(
                tree.dockerfile.read_text(encoding="utf-8"), pinned, measured.entry
            )

        tree.manifest.write_text(text, encoding="utf-8", newline="\n")
        for name, data in (measured.locks or {}).items():
            (tree.locks / name).write_bytes(data)
        tree.docs.write_text(docs, encoding="utf-8", newline="\n")
        if dockerfile is not None:
            tree.dockerfile.write_text(dockerfile, encoding="utf-8", newline="\n")
        if not changed:
            print(f"{NAMES[program]} {pinned['version']} is pinned already; nothing moved")
            return 0
        print(f"pinned {NAMES[program]} {measured.entry['version']} ({target.tag})")
        if args.summary:
            summary = summarize(
                program,
                target,
                manifest,
                updated,
                measured,
                again,
                old_locks,
                by_rule=by_rule is not None and by_rule.tag == target.tag,
            )
            args.summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return 0


def docker_pin(text: str, before: dict, after: dict) -> str:
    """engine/Dockerfile with its FFmpeg moved from the Linux build `before`
    pins to the one `after` pins. Refused unless it pins `before`'s now."""
    old = next(a for a in before["assets"] if a["platform"] == "linux-x64")
    new = next(a for a in after["assets"] if a["platform"] == "linux-x64")
    url, sha = _DOCKER_URL.search(text), _DOCKER_SHA.search(text)
    if url is None or sha is None or (url.group(1), sha.group(1)) != (old["url"], old["sha256"]):
        raise Unmeasurable("engine/Dockerfile does not pin the FFmpeg the manifest pins")
    text = _DOCKER_URL.sub(lambda _: f"ARG FFMPEG_URL={new['url']}", text, count=1)
    return _DOCKER_SHA.sub(lambda _: f"ARG FFMPEG_SHA256={new['sha256']}", text, count=1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=Path,
        default=ENGINE.parent,
        help="the checkout to read and write (default: this one)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="print what upstream has that is newer, as JSON")
    check.add_argument(
        "--skip-existing",
        metavar="OWNER/REPO",
        help="leave out a release whose pins/ branch or pull request exists in this repository",
    )
    check.add_argument("--program", choices=PROGRAMS, help="look at this program alone")
    check.add_argument(
        "--version", help="look at this release of --program, whatever the rules would take"
    )
    pin = commands.add_parser("pin", help="measure a release and write its pin")
    pin.add_argument("program", choices=PROGRAMS)
    which = pin.add_mutually_exclusive_group()
    which.add_argument(
        "--version",
        help="the release to pin: a version or its tag, for FFmpeg a BtbN autobuild tag "
        "(default: the one `check` reports)",
    )
    which.add_argument(
        "--again",
        action="store_true",
        help="measure the pinned release from scratch and write it, which changes nothing "
        "unless the method no longer reproduces the pin",
    )
    pin.add_argument("--uv", default="uv", help="the uv ComfyUI's locks are made with")
    pin.add_argument("--work", type=Path, help="a folder for scratch files (default: the temp dir)")
    pin.add_argument(
        "--summary", type=Path, help="write the commit message and pull request text here, as JSON"
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            return command_check(args)
        return command_pin(args)
    except (Unmeasurable, DocsDisagree) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
