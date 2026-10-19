"""A program LocalCut builds the environment of itself, from pinned pieces:
ComfyUI on Linux, which publishes no build to download there.

The copy is one folder, laid out like the Windows portable build:

    python/     a standalone CPython (python-build-standalone), pinned in the
                manifest's `runtimes`, with every wheel the lock pins
                unpacked into its own site-packages
    ComfyUI/    ComfyUI's source at the pinned tag

There is no venv. A venv writes its interpreter's absolute path into
pyvenv.cfg and its `bin/python` link, so one built in the setup's scratch
folder would point at nothing once that folder is renamed into place. The
standalone Python finds its own files from where it is, as the portable
build's embedded Python does, so the folder can move.

The wheels are a lock, `locks/pylock.<name>.toml` (PEP 751), one per GPU
vendor's PyTorch: exactly one wheel per package, each with its URL, size and
SHA-256, resolved against the pinned ComfyUI's own requirements.txt by
`engine/scripts/lock-comfyui-linux.py`. A setup downloads each wheel like
any other pinned file (size to the byte, then the digest) and unpacks it
itself, member by member, by the rule in `wheel_target`. Nothing resolves
or installs anything at setup time and nothing is fetched that the lock
does not name, so the copy's files and bytes are known before the download
starts and checked after the unpack. The script that writes the lock counts
them by the same rule.

Unpacking a wheel is putting its files into site-packages, which is all a
wheel is (the binary distribution format, PEP 427): `<name>.data/purelib`
and `platlib` go there too, `<name>.data/data` goes under the Python's own
prefix and console scripts and C headers are left out, since nothing here
runs one or builds against them. A later wheel's file replaces an earlier
one's, as pip does for the `nvidia/__init__.py` every NVIDIA library wheel
carries. No member is ever written outside the copy: each name is plain
relative folder names and nothing in a wheel may be a link.
"""

from __future__ import annotations

import functools
import gzip
import hashlib
import importlib.resources
import os
import posixpath
import re
import stat
import tarfile
import threading
import tomllib
import zipfile
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .manifest import Environment, KeptTree, ProgramAsset, RuntimePin
from .sevenzip import ArchiveRefused, Stopped

#: The copy's two folders.
RUNTIME_FOLDER = "python"
SOURCE_FOLDER = "ComfyUI"
#: The standalone Python's interpreter, inside its folder.
INTERPRETER = "bin/python3"

_CHUNK = 1 << 20
_REPORT_EVERY = 4 << 20
_DIGEST = re.compile(r"[0-9a-f]{64}")
# A wheel's `.data` folder: `<name>-<version>.data/<scheme>/<path>`.
_DATA = re.compile(r"[^/]+\.data/([^/]+)/(.+)")
# Where each `.data` scheme goes, or None for one that is left out.
_SCHEMES = {
    "purelib": "site",
    "platlib": "site",
    "data": "prefix",
    "scripts": None,
    "headers": None,
}


class LockRefused(ValueError):
    """A lock that is not the one the manifest pins, or not one a setup can
    install from: a package with no wheel or more than one, a wheel with no
    size or digest or no address to fetch it from."""


@dataclass(frozen=True)
class Wheel:
    name: str
    version: str
    #: The wheel file's own name.
    filename: str
    url: str
    size: int
    sha256: str


@dataclass(frozen=True)
class Lock:
    wheels: tuple[Wheel, ...]
    #: The ComfyUI it was resolved for: its version, the SHA-256 of its
    #: source archive and of the requirements.txt in that archive.
    comfyui: str
    source_sha256: str
    requirements_sha256: str

    @property
    def wheel_bytes(self) -> int:
        return sum(wheel.size for wheel in self.wheels)


def parse_lock(text: str) -> Lock:
    """Read a pylock.toml the way a setup installs from it. Raises
    LockRefused for anything that would leave a package to chance."""
    try:
        document = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise LockRefused(f"the lock does not read as TOML: {exc}") from exc
    if document.get("lock-version") != "1.0":
        raise LockRefused(f"lock-version {document.get('lock-version')!r} is not 1.0")
    tool = document.get("tool", {}).get("localcut")
    if not isinstance(tool, dict):
        raise LockRefused("the lock has no [tool.localcut] table")
    wheels = []
    seen: set[str] = set()
    for package in document.get("packages", []):
        name = str(package.get("name", ""))
        version = str(package.get("version", ""))
        if not name or not version or name in seen:
            raise LockRefused(f"package {name!r} is nameless, versionless or locked twice")
        seen.add(name)
        if any(key in package for key in ("sdist", "vcs", "archive", "directory")):
            raise LockRefused(f"{name} is locked as something to build, not a wheel")
        found = package.get("wheels") or []
        if len(found) != 1:
            raise LockRefused(f"{name} has {len(found)} wheels locked where a setup takes one")
        wheel = found[0]
        url = str(wheel.get("url", ""))
        size = wheel.get("size")
        digest = (wheel.get("hashes") or {}).get("sha256", "")
        filename = str(wheel.get("name") or unquote(urlsplit(url).path.rsplit("/", 1)[-1]))
        if urlsplit(url).scheme not in ("https", "http"):
            raise LockRefused(f"{name}'s wheel is not at a web address: {url!r}")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise LockRefused(f"{name}'s wheel has no size")
        if not _DIGEST.fullmatch(str(digest)):
            raise LockRefused(f"{name}'s wheel has no SHA-256")
        if not filename.endswith(".whl") or "/" in filename:
            raise LockRefused(f"{name}'s wheel is named {filename!r}")
        wheels.append(Wheel(name, version, filename, url, size, digest))
    if not wheels:
        raise LockRefused("the lock pins no wheels")
    comfyui = tool.get("comfyui") or {}
    try:
        return Lock(
            wheels=tuple(wheels),
            comfyui=str(comfyui["version"]),
            source_sha256=_digest_or_refuse(comfyui["sha256"], "the source"),
            requirements_sha256=_digest_or_refuse(comfyui["requirements_sha256"], "requirements"),
        )
    except (KeyError, TypeError) as exc:
        raise LockRefused(f"the lock's [tool.localcut.comfyui] lacks {exc}") from None


def _digest_or_refuse(value: object, what: str) -> str:
    if not isinstance(value, str) or not _DIGEST.fullmatch(value):
        raise LockRefused(f"the lock gives no SHA-256 for {what}")
    return value


def lock_text(name: str) -> bytes:
    """A lock as this package ships it."""
    return (importlib.resources.files("localcut_engine.programs") / "locks" / name).read_bytes()


@functools.cache
def _load(name: str, sha256: str, wheels: int, wheel_bytes: int) -> Lock:
    # Hashed with the newlines it was written with: a checkout that turns
    # them into CRLF is the same lock.
    data = lock_text(name).replace(b"\r\n", b"\n")
    if hashlib.sha256(data).hexdigest() != sha256:
        raise LockRefused(f"{name} is not the lock the manifest pins")
    lock = parse_lock(data.decode("utf-8"))
    if (len(lock.wheels), lock.wheel_bytes) != (wheels, wheel_bytes):
        raise LockRefused(
            f"{name} pins {len(lock.wheels)} wheels of {lock.wheel_bytes} bytes and the "
            f"manifest says {wheels} of {wheel_bytes}"
        )
    return lock


def load_lock(environment: Environment) -> Lock:
    """The lock an environment names, held to the manifest's digest and
    figures. Read once per process: it is part of the package."""
    try:
        return _load(
            environment.lock,
            environment.lock_sha256,
            environment.wheels,
            environment.wheel_bytes,
        )
    except OSError as exc:
        raise LockRefused(f"{environment.lock} cannot be read: {exc}") from exc


def lock_ok(asset: ProgramAsset) -> bool:
    """Whether the asset's lock is there and is the one pinned."""
    if asset.environment is None:
        return False
    try:
        load_lock(asset.environment)
    except LockRefused:
        return False
    return True


# -- where each file goes ------------------------------------------------------


def _plain(name: str) -> list[str] | None:
    """A member's name as folder names, or None for one that is not plain
    relative names joined by "/": absolute, climbing with `..`, empty
    segments, a backslash or a NUL."""
    if not name or name.startswith("/") or "\\" in name or "\x00" in name:
        return None
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return parts


def wheel_target(name: str) -> tuple[str, str] | None:
    """Where a wheel's member goes: ("site", path) under site-packages,
    ("prefix", path) under the Python's own folder, or None for one that
    is left out (a folder entry, a console script, a C header). Raises
    ArchiveRefused for a name that is not plain, or a `.data` scheme the
    wheel format does not have."""
    if name.endswith("/"):
        return None
    parts = _plain(name)
    if parts is None:
        raise ArchiveRefused(f"{name!r} would land outside site-packages")
    data = _DATA.fullmatch(name)
    if data is not None:
        scheme, rest = data.groups()
        if scheme not in _SCHEMES:
            raise ArchiveRefused(f"{name} is in a .data folder no wheel has")
        base = _SCHEMES[scheme]
        return None if base is None else (base, rest)
    return ("site", name)


def copy_path(kind: str, path: str, runtime: RuntimePin) -> str:
    """A file's path inside the copy, from where it came: the runtime's
    tree, the source's, or a wheel's target."""
    if kind == "runtime" or kind == "prefix":
        return f"{RUNTIME_FOLDER}/{path}"
    if kind == "source":
        return f"{SOURCE_FOLDER}/{path}"
    if kind == "site":
        return f"{RUNTIME_FOLDER}/{runtime.site_packages}/{path}"
    raise ValueError(kind)


# -- unpacking, on a worker thread ---------------------------------------------


def _tar_plan(members: list[tarfile.TarInfo], tree: KeptTree) -> list[tuple[tarfile.TarInfo, str]]:
    """The members of a source or runtime archive, each with its path under
    the top folder, refused unless every one lands inside the top folder, is
    a file, a folder or a link to something else inside it and the files,
    their size and the links are the pin's."""
    plan = []
    seen: set[str] = set()
    linked: set[str] = set()
    files = total = links = 0
    for member in members:
        parts = _plain(member.name.rstrip("/") if member.isdir() else member.name)
        if parts is None or parts[0] != tree.root:
            raise ArchiveRefused(f"{member.name} would land outside {tree.root}")
        if len(parts) == 1:
            if member.isdir():
                continue
            raise ArchiveRefused(f"{member.name} is a file where the top folder should be")
        path = "/".join(parts[1:])
        if path in seen:
            raise ArchiveRefused(f"{member.name} is in the archive twice")
        seen.add(path)
        # Nothing is written through a link: a link to a folder would carry
        # what is written under it wherever the link points.
        if any("/".join(parts[1:depth]) in linked for depth in range(2, len(parts))):
            raise ArchiveRefused(f"{member.name} is under a link")
        if member.issym():
            linked.add(path)
        if member.isreg():
            files += 1
            total += member.size
        elif member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), member.linkname))
            if (
                member.linkname.startswith("/")
                or "\\" in member.linkname
                or target in (".", "..")
                or target.startswith("../")
            ):
                raise ArchiveRefused(f"{member.name} links outside {tree.root}")
            links += 1
        elif not member.isdir():
            raise ArchiveRefused(f"{member.name} is not a plain file, folder or link")
        plan.append((member, path))
    if (files, total, links) != (tree.files, tree.bytes, tree.links):
        raise ArchiveRefused(
            f"the archive holds {files} files of {total} bytes and {links} links and the pin "
            f"says {tree.files} files of {tree.bytes} bytes and {tree.links} links"
        )
    return plan


def unpack_tar_tree(
    archive: Path,
    tree: KeptTree,
    into: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Write the archive's top folder as `into`, checked against the pin
    before anything is written. `report` gets each file's bytes as they are
    written."""
    try:
        with tarfile.open(archive, "r:gz") as listed:
            plan = _tar_plan(listed.getmembers(), tree)
        wanted = {member.name: path for member, path in plan}
        into.mkdir(parents=True)
        # Read again, in order: a gzip stream cannot be read backwards
        # without starting it over.
        with tarfile.open(archive, "r:gz") as untarred:
            for member in untarred:
                if stop.is_set():
                    raise Stopped
                path = wanted.get(member.name)
                if path is None:
                    continue
                target = into.joinpath(*path.split("/"))
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.issym():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.symlink(member.linkname, target)
                else:
                    source = untarred.extractfile(member)
                    if source is None:
                        raise ArchiveRefused(f"{member.name} could not be read")
                    _write(source, target, member.size, member.mode, report, stop)
    except (tarfile.TarError, EOFError, gzip.BadGzipFile, zlib.error) as exc:
        raise ArchiveRefused(f"{archive.name} cannot be read: {exc}") from exc


def unpack_wheel(
    wheel: Path,
    site: Path,
    prefix: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Put one wheel's files where `wheel_target` says. Every name is
    checked before anything is written. `report` gets each file's bytes as
    they are written, less those of a file it replaces."""
    try:
        with zipfile.ZipFile(wheel) as unzipped:
            plan = []
            for info in unzipped.infolist():
                target = wheel_target(info.filename)
                if target is None:
                    continue
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ArchiveRefused(f"{info.filename} is a link")
                base, path = target
                plan.append((info, (site if base == "site" else prefix).joinpath(*path.split("/"))))
            inside: dict[Path, bool] = {}
            roots = (os.path.realpath(site), os.path.realpath(prefix))
            for info, destination in plan:
                if stop.is_set():
                    raise Stopped
                parent = destination.parent
                if parent not in inside:
                    # Nothing is written through a link out of the copy: the
                    # folder a file goes in is where its path says.
                    real = os.path.realpath(parent)
                    inside[parent] = any(
                        real == root or real.startswith(root + os.sep) for root in roots
                    )
                if not inside[parent]:
                    raise ArchiveRefused(f"{info.filename} would be written through a link")
                if destination.is_symlink() or destination.is_file():
                    # A file an earlier wheel or the runtime put there is
                    # replaced (never written through) and its bytes no
                    # longer count towards the copy.
                    replaced = 0 if destination.is_symlink() else destination.stat().st_size
                    destination.unlink()
                    report(-replaced)
                elif destination.exists():
                    raise ArchiveRefused(f"{info.filename} is a file where a folder is")
                with unzipped.open(info) as source:
                    _write(
                        source, destination, info.file_size, info.external_attr >> 16, report, stop
                    )
    except (zipfile.BadZipFile, EOFError) as exc:
        raise ArchiveRefused(f"{wheel.name} cannot be read: {exc}") from exc
    except (NotADirectoryError, FileExistsError) as exc:
        raise ArchiveRefused(f"{wheel.name} puts a file where a folder is: {exc}") from exc


def _write(
    source,  # noqa: ANN001 - a binary file object
    target: Path,
    size: int,
    mode: int,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with target.open("xb") as sink:
        while chunk := source.read(_CHUNK):
            if stop.is_set():
                raise Stopped
            count += len(chunk)
            if count > size:
                raise ArchiveRefused(f"{target.name} is larger than the {size} bytes listed")
            sink.write(chunk)
            report(len(chunk))
    if count != size:
        raise ArchiveRefused(f"{target.name} is {count} bytes where the archive lists {size}")
    if os.name != "nt":
        target.chmod(0o755 if mode & 0o111 else 0o644)


def walk(folder: Path) -> tuple[int, int, int]:
    """(files, bytes, links) under `folder`, following nothing. Refuses a
    link to anything outside it and anything that is not a file, a folder
    or a link."""
    files = total = links = 0
    root = os.path.realpath(folder)
    pending = [str(folder)]
    while pending:
        current = pending.pop()
        with os.scandir(current) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    resolved = os.path.realpath(entry.path)
                    if os.path.commonpath([root, resolved]) != root:
                        raise ArchiveRefused(f"{entry.path} links outside the copy")
                    links += 1
                elif stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)
                elif stat.S_ISREG(info.st_mode):
                    files += 1
                    total += info.st_size
                else:
                    raise ArchiveRefused(f"{entry.path} is not a plain file")
    return files, total, links


@dataclass(frozen=True)
class Downloads:
    """Where a setup put each piece it downloaded."""

    runtime: Path
    source: Path
    wheels: list[Path]


def unpack(
    asset: ProgramAsset,
    runtime: RuntimePin,
    lock: Lock,
    downloads: Downloads,
    folder: Path,
    report: Callable[[int], None],
    stop: threading.Event,
) -> None:
    """Build the copy in `folder`: the runtime, the source, then each wheel
    in the lock's order, each download deleted once it is unpacked. Then the
    whole folder is walked and held to the environment's figures and the
    source's requirements to the ones the lock was made from. `report` gets
    the bytes written so far."""
    environment = asset.environment
    assert environment is not None and asset.tree is not None
    written = reported = 0

    def count(more: int) -> None:
        # Tens of thousands of small files: the bar hears of every few
        # megabytes rather than of each one.
        nonlocal written, reported
        written += more
        if written - reported >= _REPORT_EVERY:
            reported = written
            report(written)

    folder.mkdir(parents=True)
    python = folder / RUNTIME_FOLDER
    unpack_tar_tree(downloads.runtime, runtime.tree, python, count, stop)
    downloads.runtime.unlink()
    unpack_tar_tree(downloads.source, asset.tree, folder / SOURCE_FOLDER, count, stop)
    downloads.source.unlink()
    requirements = folder / SOURCE_FOLDER / "requirements.txt"
    try:
        said = hashlib.sha256(requirements.read_bytes()).hexdigest()
    except OSError:
        said = None
    if said != lock.requirements_sha256:
        raise ArchiveRefused(
            f"{SOURCE_FOLDER}/requirements.txt is not the one {environment.lock} was made from"
        )
    site = python.joinpath(*runtime.site_packages.split("/"))
    for path in downloads.wheels:
        unpack_wheel(path, site, python, count, stop)
        path.unlink()
    report(written)
    found = walk(folder)
    if found != (environment.files, environment.bytes, environment.links):
        files, total, links = found
        raise ArchiveRefused(
            f"{files} files of {total} bytes and {links} links were unpacked and the pin says "
            f"{environment.files} files of {environment.bytes} bytes and {environment.links} links"
        )
