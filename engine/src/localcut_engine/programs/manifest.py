"""The builds LocalCut can set up, pinned: programs-manifest.json, a data file
shipped in this package.

A pin is exact. Per program it gives the version, and per platform (an OS
and an architecture, and a GPU vendor where one build does not serve every
card) the download's URL, its size in bytes, its SHA-256, the archive's
format, and every file LocalCut keeps out of it: the member's exact name in
the archive, the path it is written under inside the program's folder, and
its size. GitHub
publishes each release asset's SHA-256 in its API `digest` field, which is
where the digests here come from. A download whose size or digest differs is
discarded, and nothing in an archive is written unless a pin names it.

Versions are pinned, never "latest", and nothing at runtime can change what
is fetched: there is no override file in the data dir and no request field
that names a URL. A newer build of LocalCut ships newer pins.
"""

from __future__ import annotations

import functools
import importlib.resources
import json
import platform
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import PROGRAM_IDS

#: The newest manifest format this engine reads.
MANIFEST_VERSION = 1

#: Every platform a pin can name: the OS, then the architecture.
PLATFORMS = (
    "windows-x64",
    "windows-arm64",
    "linux-x64",
    "linux-arm64",
    "macos-x64",
    "macos-arm64",
)

_SYSTEMS = {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}
_MACHINES = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}

# What each segment of a kept file's path may be called, with nothing a
# path separator, a drive or an alternate data stream could be read out of.
# Segments are joined by "/" alone.
_BARE_NAME = re.compile(r"[A-Za-z0-9._+-]+")
_DIGEST = re.compile(r"[0-9a-f]{64}")


class ManifestTooNew(ValueError):
    """A manifest written for a newer engine. Refused rather than read as far
    as this engine understands it, which would drop what it does not."""


class _Strict(BaseModel):
    # The file is this package's own, so a key nothing reads is a typo, and a
    # typo in a pin should fail the suite rather than fall back to a default.
    model_config = ConfigDict(extra="forbid")


class KeptFile(_Strict):
    """One file taken out of the archive."""

    #: The member's name in the archive, matched exactly.
    member: str = Field(min_length=1)
    #: Where it is written in the program's folder: a file name, or a path
    #: of them joined by "/" for a program that finds its libraries beside
    #: its binary (Ollama's lib/ollama). Never absolute and never "..".
    path: str
    #: Its size unpacked, in bytes. 0 for a link.
    size: int = Field(ge=0)
    #: Set for a symbolic link (a tar member only): the name of the kept
    #: file it points at, in the same folder. A Linux library is loaded by
    #: its soname (libggml.so.0), which the archive ships as a link to the
    #: versioned file, and a copy in its place would double the disk it takes.
    link: str | None = None

    @model_validator(mode="after")
    def _a_file_or_a_link(self) -> KeptFile:
        if self.link is None and self.size <= 0:
            raise ValueError(f"{self.path} is a file of no size")
        if self.link is not None:
            if self.size != 0:
                raise ValueError(f"{self.path} is a link, and a link has no size")
            if not _BARE_NAME.fullmatch(self.link) or self.link in (".", ".."):
                raise ValueError(f"{self.path} links outside its own folder")
        return self

    @field_validator("path")
    @classmethod
    def _inside_the_folder(cls, value: str) -> str:
        segments = value.split("/")
        if not all(_BARE_NAME.fullmatch(part) and part not in (".", "..") for part in segments):
            raise ValueError(
                f"a kept file is written under a relative path of plain names, not {value!r}"
            )
        return value


class ProgramAsset(_Strict):
    """One downloadable build of a program, for one platform."""

    platform: str
    #: Set when the program publishes a build per GPU vendor (nvidia, amd,
    #: intel). None is the build for any card.
    gpu: str | None = None
    url: str = Field(min_length=1)
    size: int = Field(gt=0)
    sha256: str
    format: Literal["zip", "tar.xz", "tar.zst"]
    files: list[KeptFile] = Field(min_length=1)

    @field_validator("platform")
    @classmethod
    def _a_known_platform(cls, value: str) -> str:
        if value not in PLATFORMS:
            raise ValueError(f"unknown platform {value!r} (known: {', '.join(PLATFORMS)})")
        return value

    @field_validator("sha256")
    @classmethod
    def _a_digest(cls, value: str) -> str:
        if not _DIGEST.fullmatch(value):
            raise ValueError("sha256 is 64 lowercase hex digits")
        return value

    @model_validator(mode="after")
    def _links_point_at_kept_files(self) -> ProgramAsset:
        """A link is followed only to another file kept beside it, never out
        of the program's folder, and only an archive that can hold one has
        one."""
        paths = {kept.path for kept in self.files}
        for kept in self.files:
            if kept.link is None:
                continue
            if self.format == "zip":
                raise ValueError(f"{self.url} is a zip, and a zip keeps no links")
            folder = kept.path.rpartition("/")[0]
            if (f"{folder}/{kept.link}" if folder else kept.link) not in paths:
                raise ValueError(f"{kept.path} links to {kept.link}, which is not kept")
        return self

    @model_validator(mode="after")
    def _each_file_once(self) -> ProgramAsset:
        paths = [kept.path.lower() for kept in self.files]
        members = [kept.member for kept in self.files]
        if len(set(paths)) != len(paths) or len(set(members)) != len(members):
            raise ValueError(f"{self.url} keeps the same file twice")
        # Compared without case, as Windows compares them: a file there
        # cannot also be the folder another kept file goes in.
        folders = {
            "/".join(parts[:depth])
            for parts in (path.split("/")[:-1] for path in paths)
            for depth in range(1, len(parts) + 1)
        }
        if folders & set(paths):
            raise ValueError(f"{self.url} keeps a file where another one's folder goes")
        return self

    @property
    def install_bytes(self) -> int:
        """The disk the kept files take once unpacked."""
        return sum(kept.size for kept in self.files)


class ProgramPin(_Strict):
    id: str
    version: str = Field(min_length=1)
    license: str = ""
    assets: list[ProgramAsset] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _a_known_program(cls, value: str) -> str:
        if value not in PROGRAM_IDS:
            raise ValueError(f"unknown program {value!r} (known: {', '.join(PROGRAM_IDS)})")
        return value

    @model_validator(mode="after")
    def _one_build_per_platform(self) -> ProgramPin:
        keys = [(asset.platform, asset.gpu) for asset in self.assets]
        if len(set(keys)) != len(keys):
            raise ValueError(f"{self.id} pins two builds for the same platform")
        return self

    def asset_for(self, platform_key: str, gpu: str | None = None) -> ProgramAsset | None:
        """The build for this platform: the one for this GPU vendor where the
        program has one, else the one for any card."""
        builds = [asset for asset in self.assets if asset.platform == platform_key]
        for_vendor = next((a for a in builds if gpu is not None and a.gpu == gpu), None)
        return for_vendor or next((a for a in builds if a.gpu is None), None)


class ProgramsManifest(_Strict):
    schema_version: int = MANIFEST_VERSION
    updated: str = ""
    programs: list[ProgramPin] = Field(default_factory=list)

    @model_validator(mode="after")
    def _each_program_once(self) -> ProgramsManifest:
        ids = [pin.id for pin in self.programs]
        if len(set(ids)) != len(ids):
            raise ValueError("a program is pinned twice")
        return self

    def program(self, program_id: str) -> ProgramPin | None:
        return next((pin for pin in self.programs if pin.id == program_id), None)

    def asset(
        self, program_id: str, platform_key: str | None, gpu: str | None = None
    ) -> ProgramAsset | None:
        pin = self.program(program_id)
        if pin is None or platform_key is None:
            return None
        return pin.asset_for(platform_key, gpu)


def parse_programs_manifest(text: str) -> ProgramsManifest:
    """Validate a manifest document. Raises ManifestTooNew for one written
    for a newer engine, and ValueError for anything else wrong with it."""
    raw = json.loads(text)
    version = raw.get("schema_version", MANIFEST_VERSION) if isinstance(raw, dict) else None
    if isinstance(version, int) and not isinstance(version, bool) and version > MANIFEST_VERSION:
        raise ManifestTooNew(
            f"the programs manifest is format v{version}, and this engine reads up to "
            f"v{MANIFEST_VERSION}"
        )
    return ProgramsManifest.model_validate(raw)


@functools.cache
def _packaged() -> ProgramsManifest:
    source = importlib.resources.files("localcut_engine.programs") / "programs-manifest.json"
    return parse_programs_manifest(source.read_text(encoding="utf-8"))


def load_programs_manifest() -> ProgramsManifest:
    """The pins this engine ships with. Read once per process: the file is
    part of the package and cannot change under a running engine.

    Every caller reaches this through the module (`manifest.load_programs_
    manifest()`), never a name imported out of it, which is what lets a test
    point the pins at a server of its own."""
    return _packaged()


def platform_key() -> str | None:
    """This machine as a pin names it, e.g. `windows-x64`, or None for an OS
    or architecture no pin can name."""
    system = _SYSTEMS.get(platform.system())
    machine = _MACHINES.get(platform.machine().lower())
    if system is None or machine is None:
        return None
    return f"{system}-{machine}"
