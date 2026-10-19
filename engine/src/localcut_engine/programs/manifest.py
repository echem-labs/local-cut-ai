"""The builds LocalCut can set up, pinned: programs-manifest.json, a data file
shipped in this package.

A pin is exact. Per program it gives the version, and per platform (an OS
and an architecture, and a GPU vendor where one build does not serve every
card) the download's URL, its size in bytes, its SHA-256, the archive's
format and what LocalCut keeps out of it. That is either a list of files
(the member's exact name in the archive, the path it is written under
inside the program's folder and its size), or for a program that is a
whole folder tree, the archive's one top folder with the number of files
under it and their total size. GitHub publishes each release asset's
SHA-256 in its API `digest` field, which is where the digests here come
from. A download whose size or digest differs is discarded and nothing in
an archive is written unless a pin names it or the folder it sits in.

A program with more than one build for the same card (ComfyUI's NVIDIA
build and its build for older drivers) names the others with `build` and
says what each needs of the card in `requires`; builds.py picks between
them. An archive format Python cannot read is unpacked by a pinned
extractor, downloaded beside the archive and held to its own size and
digest (`extractors`).

A program with no build of its own for a platform (ComfyUI on Linux) is its
source archive plus an `environment`: a standalone Python pinned the same
way (`runtimes`) and a lock file beside this one that pins every wheel it
needs by URL, size and SHA-256 (environment.py). The figures the setup
screen shows for it are the lock's, written down here as well and held to
the lock by test_programs_comfyui_linux.py.

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

from . import BUILDS, PROGRAM_IDS

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
_VERSION = re.compile(r"\d+(\.\d+)*")

#: The GPU vendors a build can be for, as the hardware probe names them.
GPU_VENDORS = ("nvidia", "amd", "intel")


def _known_platform(value: str) -> str:
    if value not in PLATFORMS:
        raise ValueError(f"unknown platform {value!r} (known: {', '.join(PLATFORMS)})")
    return value


def _digest(value: str) -> str:
    if not _DIGEST.fullmatch(value):
        raise ValueError("sha256 is 64 lowercase hex digits")
    return value


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


class KeptTree(_Strict):
    """A whole folder taken out of the archive: everything under its one top
    folder, which becomes the program's folder."""

    #: The top folder's name in the archive. Every member is inside it.
    root: str
    #: How many files are under it and their total size unpacked. The
    #: archive's own listing has to agree before anything is unpacked and
    #: what was unpacked has to agree after.
    files: int = Field(gt=0)
    bytes: int = Field(gt=0)
    #: How many symbolic links are under it, each pointing at something else
    #: under it. Only a tar keeps any: a standalone Python names its
    #: interpreter and its library by links. A 7z keeps none.
    links: int = Field(default=0, ge=0)

    @field_validator("root")
    @classmethod
    def _a_bare_folder_name(cls, value: str) -> str:
        if not _BARE_NAME.fullmatch(value) or value in (".", ".."):
            raise ValueError(f"an archive's top folder is a bare name, not {value!r}")
        return value


class Requirements(_Strict):
    """What a build needs of the card, where a build for the same vendor
    exists that needs less. A machine the probe could not read is assumed to
    meet them."""

    #: The oldest NVIDIA driver it runs on, as nvidia-smi spells versions.
    nvidia_driver: str | None = None
    #: The oldest compute capability its CUDA build has kernels for.
    compute_capability: str | None = None

    @field_validator("nvidia_driver", "compute_capability")
    @classmethod
    def _a_dotted_number(cls, value: str | None) -> str | None:
        if value is not None and not _VERSION.fullmatch(value):
            raise ValueError(f"{value!r} is not a version number")
        return value


_LOCK_NAME = re.compile(r"pylock\.[a-z0-9-]+\.toml")


class Environment(_Strict):
    """What a program built from pinned pieces needs beside its source (the
    Python it runs on and the wheels it imports) and what all of it comes to.
    The lock is the list of wheels. Its count and their total are written
    down here too, so the setup screen shows the download without reading
    the lock. A test holds the two to each other."""

    #: The runtime it runs on, by id (`runtimes`), pinned for the same
    #: platform.
    runtime: str = Field(min_length=1)
    #: The lock's file name in programs/locks and its SHA-256: the lock
    #: that is read is the lock that was reviewed.
    lock: str
    lock_sha256: str
    #: The wheels the lock pins and their total size, as downloaded.
    wheels: int = Field(gt=0)
    wheel_bytes: int = Field(gt=0)
    #: The whole copy once unpacked, runtime and source and wheels together:
    #: its files, their total size and its links. What was unpacked has to
    #: agree before it is used.
    files: int = Field(gt=0)
    bytes: int = Field(gt=0)
    links: int = Field(ge=0)

    @field_validator("lock")
    @classmethod
    def _a_lock_name(cls, value: str) -> str:
        if not _LOCK_NAME.fullmatch(value):
            raise ValueError(f"a lock is named pylock.<name>.toml, not {value!r}")
        return value

    @field_validator("lock_sha256")
    @classmethod
    def _a_digest(cls, value: str) -> str:
        return _digest(value)


class ProgramAsset(_Strict):
    """One downloadable build of a program, for one platform."""

    platform: str
    #: Set when the program publishes a build per GPU vendor (nvidia, amd,
    #: intel). None is the build for any card.
    gpu: str | None = None
    #: One of BUILDS, for a second build for the same platform and vendor.
    #: None is the vendor's usual build.
    build: str | None = None
    requires: Requirements | None = None
    url: str = Field(min_length=1)
    size: int = Field(gt=0)
    sha256: str
    format: Literal["zip", "tar.xz", "tar.zst", "tar.gz", "7z"]
    #: What is kept: these files, or the whole tree.
    files: list[KeptFile] = Field(default_factory=list)
    tree: KeptTree | None = None
    #: For a program built from pinned pieces, the rest of them. The archive
    #: is then its source, kept whole as `tree`.
    environment: Environment | None = None

    @field_validator("platform")
    @classmethod
    def _a_known_platform(cls, value: str) -> str:
        return _known_platform(value)

    @field_validator("gpu")
    @classmethod
    def _a_known_vendor(cls, value: str | None) -> str | None:
        if value is not None and value not in GPU_VENDORS:
            raise ValueError(f"unknown GPU vendor {value!r} (known: {', '.join(GPU_VENDORS)})")
        return value

    @field_validator("build")
    @classmethod
    def _a_known_build(cls, value: str | None) -> str | None:
        if value is not None and value not in BUILDS:
            raise ValueError(f"unknown build {value!r} (known: {', '.join(BUILDS)})")
        return value

    @field_validator("sha256")
    @classmethod
    def _a_digest(cls, value: str) -> str:
        return _digest(value)

    @model_validator(mode="after")
    def _kept_one_way(self) -> ProgramAsset:
        # A 7z is unpacked by the extractor as a whole; zip and tar.xz are
        # read member by member in Python, which is what picks single files.
        # A source tar.gz is read member by member too and kept whole, with
        # the environment it runs in.
        if (self.tree is None) == (not self.files):
            raise ValueError(f"{self.url} keeps either a list of files or a tree, not both")
        whole = self.format == "7z" or self.environment is not None
        if (self.tree is not None) != whole:
            raise ValueError(
                f"{self.url}: a tree is kept from a 7z or a program's source and files "
                "from a zip or tar"
            )
        if (self.environment is not None) != (self.format == "tar.gz"):
            raise ValueError(f"{self.url}: a tar.gz is a program's source, with its environment")
        if self.format == "7z" and self.tree is not None and self.tree.links:
            raise ValueError(f"{self.url}: a 7z keeps no links")
        return self

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
        """The disk the kept files take once unpacked: for a program built
        from pinned pieces, all of them together."""
        if self.environment is not None:
            return self.environment.bytes
        if self.tree is not None:
            return self.tree.bytes
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
        keys = [(asset.platform, asset.gpu, asset.build) for asset in self.assets]
        if len(set(keys)) != len(keys):
            raise ValueError(f"{self.id} pins two builds for the same platform")
        for platform_key, gpu, build in keys:
            if build == "cpu":
                # The processor's build is for no card. It is what a machine
                # without one gets, so there is no usual build for it to sit
                # beside.
                if gpu is not None:
                    raise ValueError(f"{self.id} pins a cpu build for {gpu} cards")
            elif build is not None and (platform_key, gpu, None) not in keys:
                raise ValueError(f"{self.id} pins a {build} build with no usual build beside it")
        return self

    def asset_for(
        self, platform_key: str, gpu: str | None = None, build: str | None = None
    ) -> ProgramAsset | None:
        """The build for this platform: the one for this GPU vendor where the
        program has one, else the one for any card. `build` names one of the
        vendor's other builds instead of its usual one."""
        builds = [
            asset
            for asset in self.assets
            if asset.platform == platform_key and asset.build == build
        ]
        for_vendor = next((a for a in builds if gpu is not None and a.gpu == gpu), None)
        return for_vendor or next((a for a in builds if a.gpu is None), None)

    def builds_for(self, platform_key: str, gpu: str | None) -> list[ProgramAsset]:
        """Every build for this platform and vendor, the usual one first."""
        return sorted(
            (a for a in self.assets if a.platform == platform_key and a.gpu == gpu),
            key=lambda asset: asset.build is not None,
        )

    def per_vendor(self, platform_key: str) -> bool:
        """Whether this platform's builds are per GPU vendor, so which one a
        machine gets depends on its card."""
        return any(a.platform == platform_key and a.gpu is not None for a in self.assets)


class ExtractorPin(_Strict):
    """A program that unpacks an archive format Python cannot read, pinned
    like a program's own build and downloaded on the same click as the
    archive it unpacks. It runs only in the scratch folder of that setup
    and is gone with it."""

    format: Literal["7z"]
    platform: str
    version: str = Field(min_length=1)
    license: str = ""
    url: str = Field(min_length=1)
    size: int = Field(gt=0)
    sha256: str

    @field_validator("platform")
    @classmethod
    def _a_known_platform(cls, value: str) -> str:
        return _known_platform(value)

    @field_validator("sha256")
    @classmethod
    def _a_digest(cls, value: str) -> str:
        return _digest(value)


class RuntimePin(_Strict):
    """A standalone Python a program built from pinned pieces runs on,
    pinned like a build and downloaded on the same click. Unpacked whole, it
    is the copy's `python` folder; the wheels go into its own site-packages,
    so it needs no venv, whose interpreter path would not survive the copy
    being moved into place."""

    id: str = Field(min_length=1)
    platform: str
    version: str = Field(min_length=1)
    license: str = ""
    url: str = Field(min_length=1)
    size: int = Field(gt=0)
    sha256: str
    format: Literal["tar.gz"]
    tree: KeptTree
    #: Where the wheels go, as a path inside the tree.
    site_packages: str

    @field_validator("platform")
    @classmethod
    def _a_known_platform(cls, value: str) -> str:
        return _known_platform(value)

    @field_validator("sha256")
    @classmethod
    def _a_digest(cls, value: str) -> str:
        return _digest(value)

    @field_validator("site_packages")
    @classmethod
    def _inside_the_tree(cls, value: str) -> str:
        parts = value.split("/")
        if not all(_BARE_NAME.fullmatch(part) and part not in (".", "..") for part in parts):
            raise ValueError(f"a path inside a runtime is plain names joined by /, not {value!r}")
        return value


class ProgramsManifest(_Strict):
    schema_version: int = MANIFEST_VERSION
    updated: str = ""
    programs: list[ProgramPin] = Field(default_factory=list)
    extractors: list[ExtractorPin] = Field(default_factory=list)
    runtimes: list[RuntimePin] = Field(default_factory=list)

    @model_validator(mode="after")
    def _each_program_once(self) -> ProgramsManifest:
        ids = [pin.id for pin in self.programs]
        if len(set(ids)) != len(ids):
            raise ValueError("a program is pinned twice")
        return self

    @model_validator(mode="after")
    def _every_environment_has_its_runtime(self) -> ProgramsManifest:
        keys = [(runtime.id, runtime.platform) for runtime in self.runtimes]
        if len(set(keys)) != len(keys):
            raise ValueError("a runtime is pinned twice for one platform")
        for pin in self.programs:
            for asset in pin.assets:
                if asset.environment is None:
                    continue
                if (asset.environment.runtime, asset.platform) not in keys:
                    raise ValueError(
                        f"{pin.id} on {asset.platform} runs on {asset.environment.runtime}, "
                        "which is not pinned for that platform"
                    )
        return self

    def runtime(self, runtime_id: str, platform_key: str) -> RuntimePin | None:
        return next(
            (r for r in self.runtimes if r.id == runtime_id and r.platform == platform_key), None
        )

    def program(self, program_id: str) -> ProgramPin | None:
        return next((pin for pin in self.programs if pin.id == program_id), None)

    def asset(
        self,
        program_id: str,
        platform_key: str | None,
        gpu: str | None = None,
        build: str | None = None,
    ) -> ProgramAsset | None:
        pin = self.program(program_id)
        if pin is None or platform_key is None:
            return None
        return pin.asset_for(platform_key, gpu, build)

    def extractor(self, fmt: str, platform_key: str | None) -> ExtractorPin | None:
        """The extractor for this archive format on this platform, or None
        when the format needs none (Python reads it) or none is pinned."""
        return next(
            (e for e in self.extractors if e.format == fmt and e.platform == platform_key), None
        )


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
