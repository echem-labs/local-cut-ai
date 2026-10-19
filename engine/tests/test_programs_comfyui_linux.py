"""LocalCut's own ComfyUI on Linux: built from pinned pieces, since ComfyUI
publishes no Linux build. A standalone Python, ComfyUI's source at the
pinned tag and the wheels a lock pins for the machine's GPU vendor (or the
processor), each downloaded and held to its size and SHA-256, unpacked by
the engine itself, walked, checked on the card and run.

The pins and the locks are checked as data. Everything that sets a copy up
uses stand-ins served from loopback: a runtime tarball, a source tarball
and wheels written here, a lock that pins them and the device check and
ComfyUI's server replaced the way test_programs_comfyui.py replaces them
for the Windows build. Nothing here downloads PyTorch.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import textwrap
import threading
import tomllib
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from conftest import free_port
from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.tags import compatible_tags, cpython_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version
from test_programs import TOKEN, _Archives, _engine, _row, _settled
from test_programs_comfyui import FAKE_COMFYUI, _card

from localcut_engine import cli
from localcut_engine.config import EngineConfig
from localcut_engine.hardware import probe
from localcut_engine.manifest import downloads as downloads_module
from localcut_engine.programs import builds, comfyui, environment
from localcut_engine.programs import manifest as program_manifest
from localcut_engine.programs import setup as program_setup
from localcut_engine.programs.environment import ArchiveRefused, LockRefused
from localcut_engine.programs.manifest import KeptTree, parse_programs_manifest

LOCKS = Path(environment.__file__).resolve().parent / "locks"
#: Where a locked wheel may come from: PyPI and PyTorch's own index for
#: PyTorch's builds for each card.
INDEX_HOSTS = ("files.pythonhosted.org", "download-r2.pytorch.org", "download.pytorch.org")
SOURCE_ROOT = "ComfyUI-0.40.0"
LINKS_HERE = os.name != "nt"


def _linux_assets():
    pin = program_manifest.load_programs_manifest().program("comfyui")
    return pin, [asset for asset in pin.assets if asset.platform == "linux-x64"]


def _target_tags(python: str):
    major, minor = (int(part) for part in python.split(".")[:2])
    platforms = [f"manylinux_2_{glibc}_x86_64" for glibc in range(28, 4, -1)]
    platforms += ["manylinux2014_x86_64", "manylinux2010_x86_64", "manylinux1_x86_64"]
    platforms.append("linux_x86_64")
    return {
        *cpython_tags((major, minor), platforms=platforms),
        *compatible_tags((major, minor), platforms=platforms),
    }


def _marker_environment(python: str) -> dict[str, str]:
    return {
        "implementation_name": "cpython",
        "implementation_version": python,
        "os_name": "posix",
        "platform_machine": "x86_64",
        "platform_python_implementation": "CPython",
        "platform_release": "",
        "platform_system": "Linux",
        "platform_version": "",
        "python_full_version": python,
        "python_version": ".".join(python.split(".")[:2]),
        "sys_platform": "linux",
    }


def lock_problems(version: str, asset, runtime, document: dict, text: bytes) -> list[str]:  # noqa: ANN001
    """What is wrong with a lock as the lock for this pinned ComfyUI build:
    made for another ComfyUI or another source archive, a requirement of
    that ComfyUI's requirements.txt it does not satisfy, a wheel the target
    Python cannot install, or figures the manifest does not repeat."""
    problems = []
    tool = document.get("tool", {}).get("localcut", {})
    made_for = tool.get("comfyui", {})
    if made_for.get("version") != version:
        problems.append(f"made for ComfyUI {made_for.get('version')} while {version} is pinned")
    if made_for.get("sha256") != asset.sha256 or made_for.get("url") != asset.url:
        problems.append("made from another source archive than the one pinned")
    if document.get("requires-python") != f"=={runtime.version}":
        problems.append(f"made for Python {document.get('requires-python')}")
    locked = {canonicalize_name(p["name"]): Version(p["version"]) for p in document["packages"]}
    markers = _marker_environment(runtime.version)
    for line in made_for.get("requirements", []):
        requirement = Requirement(line)
        if requirement.marker is not None and not requirement.marker.evaluate(markers):
            continue
        name = canonicalize_name(requirement.name)
        if name not in locked:
            problems.append(f"{line} is required and not locked")
        elif not requirement.specifier.contains(locked[name], prereleases=True):
            problems.append(f"{line} is required and {name} {locked[name]} is locked")
    tags = _target_tags(runtime.version)
    for package in document["packages"]:
        marker = package.get("marker")
        if marker and not Marker(marker).evaluate(markers):
            problems.append(f"{package['name']} is locked for another machine")
        for wheel in package.get("wheels", []):
            if urlsplit(wheel["url"]).scheme != "https" or urlsplit(wheel["url"]).hostname not in (
                INDEX_HOSTS
            ):
                problems.append(f"{wheel['name']} comes from {wheel['url']}")
            *_, wheel_tags = parse_wheel_filename(wheel["name"])
            if not wheel_tags & tags:
                problems.append(f"{wheel['name']} does not install on the target")
    figures = asset.environment
    if hashlib.sha256(text).hexdigest() != figures.lock_sha256:
        problems.append("the lock is not the one the manifest pins")
    sizes = [w["size"] for p in document["packages"] for w in p.get("wheels", [])]
    if (len(sizes), sum(sizes)) != (figures.wheels, figures.wheel_bytes):
        problems.append("the manifest's count or size of the wheels is not the lock's")
    return problems


# -- the pins and the locks ------------------------------------------------------------


def test_linux_builds_are_pinned_per_vendor_from_the_same_comfyui():
    """One build per vendor's PyTorch and one for the processor, all from
    the same ComfyUI source archive at the pinned tag, on the same pinned
    Python. The usual NVIDIA build is CUDA 13, which needs a 580 driver and
    a Turing card or newer, as on Windows; the build for older drivers is
    CUDA 12.6."""
    pin, assets = _linux_assets()
    pins = program_manifest.load_programs_manifest()
    assert {(a.gpu, a.build) for a in assets} == {
        ("nvidia", None),
        ("nvidia", "older_drivers"),
        ("amd", None),
        ("intel", None),
        (None, "cpu"),
    }
    runtime = pins.runtime("cpython", "linux-x64")
    assert runtime is not None
    assert re.fullmatch(
        r"https://github\.com/astral-sh/python-build-standalone/releases/download/\d{8}/"
        rf"cpython-{re.escape(runtime.version)}%2B\d{{8}}-x86_64-unknown-linux-gnu-"
        r"install_only_stripped\.tar\.gz",
        runtime.url,
    )
    assert runtime.license == "PSF-2.0" and runtime.tree.root == "python"
    minor = ".".join(runtime.version.split(".")[:2])
    assert runtime.site_packages == f"lib/python{minor}/site-packages"
    source = f"https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v{pin.version}.tar.gz"
    for asset in assets:
        assert asset.url == source and asset.format == "tar.gz"
        assert asset.tree.root == f"ComfyUI-{pin.version}" and asset.tree.links == 0
        assert asset.environment.runtime == "cpython"
        assert asset.environment.lock == f"pylock.comfyui-{_lock_name(asset)}.toml"
        assert program_setup.INSTALLERS["comfyui"].fits(asset), asset.environment.lock
        # The whole copy is more than its parts' downloads.
        assert asset.environment.bytes > asset.environment.wheel_bytes > asset.size
    assert len({asset.sha256 for asset in assets}) == 1
    usual = pin.asset_for("linux-x64", "nvidia")
    older = pin.asset_for("linux-x64", "nvidia", "older_drivers")
    assert usual.requires.model_dump() == {"nvidia_driver": "580", "compute_capability": "7.5"}
    assert older.requires.model_dump() == {"nvidia_driver": "525", "compute_capability": None}


def _lock_name(asset) -> str:  # noqa: ANN001 - a pin
    return {
        ("nvidia", None): "cu130",
        ("nvidia", "older_drivers"): "cu126",
        ("amd", None): "rocm72",
        ("intel", None): "xpu",
        (None, "cpu"): "cpu",
    }[(asset.gpu, asset.build)]


def test_every_lock_is_the_lock_for_the_pinned_comfyui():
    """The contract between the locks and the pin. Each lock was resolved
    from the requirements.txt in the source archive the manifest pins, at
    the version it pins, for the Python it pins; every one of those
    requirements is met by what it locks; every wheel installs on CPython
    for x86_64 Linux; and the manifest repeats its digest, its count of
    wheels and their size. Bumping ComfyUI's pin without running
    scripts/lock-comfyui-linux.py fails here."""
    pin, assets = _linux_assets()
    runtime = program_manifest.load_programs_manifest().runtime("cpython", "linux-x64")
    torches = set()
    for asset in assets:
        text = (LOCKS / asset.environment.lock).read_bytes().replace(b"\r\n", b"\n")
        document = tomllib.loads(text.decode("utf-8"))
        assert lock_problems(pin.version, asset, runtime, document, text) == []
        lock = environment.load_lock(asset.environment)
        assert lock.comfyui == pin.version and lock.source_sha256 == asset.sha256
        torches |= {w.version.split("+")[0] for w in lock.wheels if w.name == "torch"}
        backend = document["tool"]["localcut"]["torch-backend"]
        torch = next(w for w in lock.wheels if w.name == "torch")
        assert torch.version.endswith("+" + backend), torch.version
    # One PyTorch for every card, so a render does not depend on which.
    assert len(torches) == 1
    # Nothing in the folder that the manifest does not name.
    assert sorted(path.name for path in LOCKS.iterdir()) == sorted(
        asset.environment.lock for asset in assets
    )


@pytest.mark.parametrize(
    "change",
    [
        "bump_comfyui",
        "new_requirement",
        "drop_package",
        "other_platform",
        "elsewhere",
        "edit_lock",
    ],
)
def test_a_lock_that_is_not_the_pinned_comfyuis_is_caught(change):
    """The check above, shown failing: on a ComfyUI bump with the old lock,
    a requirement the lock does not meet, a package dropped from it, a
    wheel for another machine and a lock edited after its digest was
    written down."""
    pin, assets = _linux_assets()
    runtime = program_manifest.load_programs_manifest().runtime("cpython", "linux-x64")
    asset = next(a for a in assets if a.gpu == "nvidia" and a.build is None)
    text = (LOCKS / asset.environment.lock).read_bytes().replace(b"\r\n", b"\n")
    document = tomllib.loads(text.decode("utf-8"))
    version = pin.version
    if change == "bump_comfyui":
        version = "0.99.0"
    elif change == "new_requirement":
        document["tool"]["localcut"]["comfyui"]["requirements"].append("nonesuch-package>=1")
    elif change == "drop_package":
        document["packages"] = [p for p in document["packages"] if p["name"] != "numpy"]
    elif change == "elsewhere":
        document["packages"][0]["wheels"][0]["url"] = "https://pypi.example/a.whl"
    elif change == "other_platform":
        wheel = document["packages"][0]["wheels"][0]
        wheel["name"] = re.sub(
            r"-[^-]+-[^-]+-[^-]+\.whl$", "-cp313-cp313-win_amd64.whl", wheel["name"]
        )
    elif change == "edit_lock":
        text = text.replace(b'version = "', b'version = "0', 1)
    assert lock_problems(version, asset, runtime, document, text) != []


def test_every_wheel_says_its_licence():
    """Every wheel's licence is written in its lock, from its own metadata,
    for docs/programs.md to answer to."""
    _, assets = _linux_assets()
    for asset in assets:
        document = tomllib.loads((LOCKS / asset.environment.lock).read_text("utf-8"))
        for package in document["packages"]:
            assert package["tool"]["localcut"]["licence"], package["name"]


# -- where each file of a wheel goes ------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "target"),
    [
        ("torch/__init__.py", ("site", "torch/__init__.py")),
        ("torch-2.14.1.dist-info/RECORD", ("site", "torch-2.14.1.dist-info/RECORD")),
        ("pkg-1.0.data/purelib/pkg_extra.py", ("site", "pkg_extra.py")),
        ("pkg-1.0.data/platlib/pkg/_c.so", ("site", "pkg/_c.so")),
        ("pkg-1.0.data/data/share/pkg/readme.txt", ("prefix", "share/pkg/readme.txt")),
        ("pkg-1.0.data/scripts/pkg-cli", None),
        ("pkg-1.0.data/headers/pkg.h", None),
        ("torch/", None),
    ],
)
def test_a_wheels_files_go_where_an_installer_puts_them(name, target):
    assert environment.wheel_target(name) == target


@pytest.mark.parametrize(
    "name",
    [
        "../evil.py",
        "torch/../../evil.py",
        "/etc/cron.d/x",
        "torch\\..\\evil.py",
        "torch//x.py",
        "pkg-1.0.data/elsewhere/x.py",
        "a\x00b",
    ],
)
def test_a_wheel_member_that_would_land_anywhere_else_is_refused(name):
    with pytest.raises(ArchiveRefused):
        environment.wheel_target(name)


def _lock_document(**overrides) -> str:
    package = {
        "name": "pkg",
        "version": "1.0",
        "wheels": [
            {
                "name": "pkg-1.0-py3-none-any.whl",
                "url": "https://files.example/pkg-1.0-py3-none-any.whl",
                "size": 10,
                "hashes": {"sha256": "0" * 64},
            }
        ],
    }
    package.update(overrides)
    lines = ['lock-version = "1.0"', "", "[[packages]]"]
    for key, value in package.items():
        if key == "wheels":
            lines.append(f"wheels = {_toml(value)}")
        else:
            lines.append(f"{key} = {_toml(value)}")
    lines += [
        "",
        "[tool.localcut.comfyui]",
        'version = "0.40.0"',
        f'sha256 = "{"1" * 64}"',
        f'requirements_sha256 = "{"2" * 64}"',
    ]
    return "\n".join(lines) + "\n"


def _toml(value) -> str:  # noqa: ANN001 - a TOML value
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{k} = {_toml(v)}" for k, v in value.items()) + " }"
    if isinstance(value, list):
        return "[" + ", ".join(_toml(v) for v in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return json.dumps(value)


def test_a_lock_reads_as_one_wheel_per_package():
    lock = environment.parse_lock(_lock_document())
    assert [(w.name, w.filename, w.size) for w in lock.wheels] == [
        ("pkg", "pkg-1.0-py3-none-any.whl", 10)
    ]
    assert (lock.comfyui, lock.wheel_bytes) == ("0.40.0", 10)


@pytest.mark.parametrize(
    ("overrides", "said"),
    [
        ({"wheels": []}, "0 wheels"),
        (
            {
                "wheels": [
                    {
                        "url": "https://x/a-1-py3-none-any.whl",
                        "size": 1,
                        "hashes": {"sha256": "0" * 64},
                    },
                    {
                        "url": "https://x/b-1-py3-none-any.whl",
                        "size": 1,
                        "hashes": {"sha256": "0" * 64},
                    },
                ]
            },
            "2 wheels",
        ),
        ({"sdist": {"url": "https://x/pkg-1.0.tar.gz"}}, "something to build"),
        (
            {
                "wheels": [
                    {
                        "url": "file:///tmp/a-1-py3-none-any.whl",
                        "size": 1,
                        "hashes": {"sha256": "0" * 64},
                    }
                ]
            },
            "web address",
        ),
        (
            {"wheels": [{"url": "https://x/a-1-py3-none-any.whl", "hashes": {"sha256": "0" * 64}}]},
            "no size",
        ),
        (
            {
                "wheels": [
                    {"url": "https://x/a-1-py3-none-any.whl", "size": 1, "hashes": {"md5": "0"}}
                ]
            },
            "SHA-256",
        ),
        (
            {
                "wheels": [
                    {"url": "https://x/a-1.tar.gz", "size": 1, "hashes": {"sha256": "0" * 64}}
                ]
            },
            "named",
        ),
    ],
)
def test_a_lock_that_leaves_anything_to_chance_is_refused(overrides, said):
    with pytest.raises(LockRefused, match=said):
        environment.parse_lock(_lock_document(**overrides))


# -- the stand-ins ---------------------------------------------------------------------


def _tar(path: Path, members: list[tuple[str, bytes | str | None]]) -> Path:
    """A tar.gz of (name, content) members: bytes is a file, a str is a
    link to that name, None a folder."""
    with tarfile.open(path, "w:gz") as out:
        for name, content in members:
            info = tarfile.TarInfo(name)
            if content is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                out.addfile(info)
            elif isinstance(content, str):
                info.type, info.linkname = tarfile.SYMTYPE, content
                out.addfile(info)
            else:
                info.size, info.mode = len(content), 0o755 if name.endswith("python3.13") else 0o644
                out.addfile(info, io.BytesIO(content))
    return path


def _wheel(path: Path, members: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as out:
        for name, data in members.items():
            out.writestr(name, data)
    return path


def _runtime_members() -> list[tuple[str, bytes | str | None]]:
    members: list[tuple[str, bytes | str | None]] = [
        ("python/bin/python3.13", b"#!/bin/sh\n"),
        ("python/lib/python3.13/os.py", b"# os\n"),
        ("python/lib/python3.13/site-packages/README.txt", b"site\n"),
    ]
    # A link needs a privilege Windows runners do not give, so the runtime
    # there names its interpreter by a file.
    members.append(("python/bin/python3", "python3.13" if LINKS_HERE else b"#!/bin/sh\n"))
    return members


REQUIREMENTS = b"torch\npkg>=1.0\n"


def _source_members(requirements: bytes = REQUIREMENTS):
    return [
        (SOURCE_ROOT, None),
        (f"{SOURCE_ROOT}/main.py", b"print('comfy')\n"),
        (f"{SOURCE_ROOT}/requirements.txt", requirements),
        (f"{SOURCE_ROOT}/comfy/__init__.py", b""),
    ]


#: The two wheels: PyTorch's stand-in and a package that uses every place
#: a wheel can put a file. Both carry `nvidia/__init__.py`, as NVIDIA's
#: library wheels do; the later one's copy is the one kept.
WHEELS = {
    "pkg-1.0-py3-none-any.whl": {
        "pkg/__init__.py": b"PKG = 1\n",
        "pkg-1.0.dist-info/METADATA": b"Name: pkg\nVersion: 1.0\n",
        "pkg-1.0.data/purelib/pkg_extra.py": b"EXTRA = 1\n",
        "pkg-1.0.data/data/share/pkg/readme.txt": b"shared\n",
        "pkg-1.0.data/scripts/pkg-cli": b"#!python\n",
        "nvidia/__init__.py": b"# from pkg\n",
    },
    "torch-2.14.1+cu130-cp313-cp313-manylinux_2_28_x86_64.whl": {
        "torch/__init__.py": b"__version__ = '2.14.1+cu130'\n",
        "torch-2.14.1+cu130.dist-info/METADATA": b"Name: torch\nVersion: 2.14.1+cu130\n",
        "nvidia/__init__.py": b"",
    },
}


def _figures(runtime, source, wheels: dict[str, dict[str, bytes]]) -> dict:  # noqa: ANN001
    """What the copy holds once those are unpacked, counted by hand."""
    copy: dict[str, tuple[str, int]] = {}
    for name, content in runtime:
        if content is not None:
            copy[name] = ("link", 0) if isinstance(content, str) else ("file", len(content))
    for name, content in source:
        if content is not None:
            copy["ComfyUI/" + name.split("/", 1)[1]] = ("file", len(content))
    site = "python/lib/python3.13/site-packages/"
    for members in wheels.values():
        for name, data in members.items():
            if ".data/scripts/" in name:
                continue
            if ".data/purelib/" in name:
                name = site + name.split(".data/purelib/", 1)[1]
            elif ".data/data/" in name:
                name = "python/" + name.split(".data/data/", 1)[1]
            else:
                name = site + name
            copy[name] = ("file", len(data))
    files = [size for kind, size in copy.values() if kind == "file"]
    return {
        "files": len(files),
        "bytes": sum(files),
        "links": sum(1 for kind, _ in copy.values() if kind == "link"),
    }


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class _LinuxPins:
    """Serves a standalone Python, a ComfyUI source archive and wheels and
    makes them, with a lock for each build, the pins for a linux-x64
    machine."""

    def __init__(self, monkeypatch, archives: _Archives, tmp_path: Path) -> None:
        self.monkeypatch = monkeypatch
        self.archives = archives
        self.locks = tmp_path / "locks"
        self.locks.mkdir()
        monkeypatch.setattr(program_manifest, "platform_key", lambda: "linux-x64")
        monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
        monkeypatch.setattr(environment, "lock_text", lambda name: (self.locks / name).read_bytes())
        root = archives.root
        self.runtime_file = _tar(root / "cpython.tar.gz", _runtime_members())
        self.runtime = {
            "id": "cpython",
            "platform": "linux-x64",
            "version": "3.13.16",
            "license": "PSF-2.0",
            "url": f"{archives.url}/cpython.tar.gz",
            "size": self.runtime_file.stat().st_size,
            "sha256": _sha(self.runtime_file),
            "format": "tar.gz",
            "tree": {
                "root": "python",
                "files": sum(1 for _, c in _runtime_members() if isinstance(c, bytes)),
                "bytes": sum(len(c) for _, c in _runtime_members() if isinstance(c, bytes)),
                "links": sum(1 for _, c in _runtime_members() if isinstance(c, str)),
            },
            "site_packages": "lib/python3.13/site-packages",
        }
        self.assets: list[dict] = []

    def build(
        self,
        name: str,
        gpu: str | None,
        *,
        build: str | None = None,
        requires: dict | None = None,
        requirements: bytes = REQUIREMENTS,
        locked_requirements: bytes = REQUIREMENTS,
        wheels: dict[str, dict[str, bytes]] | None = None,
        digest_of: dict[str, str] | None = None,
        figures: dict | None = None,
    ) -> dict:
        """One build: its source (each build its own here, so a test can
        give one other requirements), its wheels and its lock."""
        wheels = WHEELS if wheels is None else wheels
        source = _tar(self.archives.root / f"source-{name}.tar.gz", _source_members(requirements))
        packages = []
        for filename, members in wheels.items():
            path = _wheel(self.archives.root / filename, members)
            distribution, version, *_ = parse_wheel_filename(filename)
            packages.append(
                {
                    "name": str(distribution),
                    "version": str(version),
                    "wheels": [
                        {
                            "name": filename,
                            "url": f"{self.archives.url}/{filename}",
                            "size": path.stat().st_size,
                            "hashes": {"sha256": (digest_of or {}).get(filename, _sha(path))},
                        }
                    ],
                }
            )
        lines = ['lock-version = "1.0"', f'requires-python = "=={self.runtime["version"]}"', ""]
        for package in packages:
            lines += ["[[packages]]"] + [f"{k} = {_toml(v)}" for k, v in package.items()] + [""]
        lines += [
            "[tool.localcut.comfyui]",
            'version = "0.40.0"',
            f'sha256 = "{_sha(source)}"',
            f'requirements_sha256 = "{hashlib.sha256(locked_requirements).hexdigest()}"',
        ]
        lock = self.locks / f"pylock.comfyui-{name}.toml"
        # Bytes, so Windows writes the newlines a lock has.
        lock.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
        counted = _figures(_runtime_members(), _source_members(requirements), wheels)
        asset = {
            "platform": "linux-x64",
            **({"gpu": gpu} if gpu else {}),
            **({"build": build} if build else {}),
            **({"requires": requires} if requires else {}),
            "url": f"{self.archives.url}/{source.name}",
            "size": source.stat().st_size,
            "sha256": _sha(source),
            "format": "tar.gz",
            "tree": {
                "root": SOURCE_ROOT,
                "files": 3,
                "bytes": sum(len(c) for _, c in _source_members(requirements) if c is not None),
            },
            "environment": {
                "runtime": "cpython",
                "lock": lock.name,
                "lock_sha256": _sha(lock),
                "wheels": len(packages),
                "wheel_bytes": sum(p["wheels"][0]["size"] for p in packages),
                **counted,
                **(figures or {}),
            },
        }
        self.assets.append(asset)
        self._apply()
        return asset

    def _apply(self) -> None:
        document = {
            "schema_version": 1,
            "programs": [
                {
                    "id": "comfyui",
                    "version": "0.40.0",
                    "license": "GPL-3.0-only",
                    "assets": self.assets,
                }
            ],
            "runtimes": [self.runtime],
        }
        pins = parse_programs_manifest(json.dumps(document))
        self.monkeypatch.setattr(program_manifest, "load_programs_manifest", lambda: pins)

    def download_bytes(self, asset: dict) -> int:
        return asset["size"] + self.runtime["size"] + asset["environment"]["wheel_bytes"]


def _nvidia_and_cpu(pins: _LinuxPins) -> tuple[dict, dict, dict]:
    usual = pins.build(
        "cu130", "nvidia", requires={"nvidia_driver": "580", "compute_capability": "7.5"}
    )
    older = pins.build("cu126", "nvidia", build="older_drivers", requires={"nvidia_driver": "525"})
    cpu = pins.build("cpu", None, build="cpu")
    return usual, older, cpu


def _device_check(monkeypatch, *, failing: set[str | None] = frozenset()):
    """Stands in for the copy's own Python. Fails for the builds named in
    `failing` the way a PyTorch that cannot use the card does. Records what
    it was asked about."""
    asked: list[str | None] = []

    async def check(self, folder: Path, asset=None) -> dict:  # noqa: ANN001 - a pin
        build = asset.build if asset else None
        asked.append(build)
        assert (folder / "python" / "bin" / "python3").exists()
        assert (folder / "ComfyUI" / "main.py").is_file()
        if build in failing:
            raise program_setup.SetupFailed("gpu_not_usable", "PyTorch finds no cuda device")
        return {"device": "CPU" if build == "cpu" else "NVIDIA GeForce RTX 3080 Laptop GPU"}

    monkeypatch.setattr(program_setup.ComfyUIInstaller, "check", check)
    return asked


def _fake_server(monkeypatch, tmp_path: Path) -> list[bool]:
    """LocalCut's copy, when the engine starts it, is the stand-in server.
    Records whether each start asked ComfyUI to run on the processor."""
    script = tmp_path / "fake_comfyui.py"
    script.write_text(FAKE_COMFYUI, encoding="utf-8")
    cpu_asked: list[bool] = []

    def argv(folder: Path, *, host: str, port: int, cpu: bool = False) -> list[str]:
        cpu_asked.append(cpu)
        return [sys.executable, str(script), "--port", str(port)]

    monkeypatch.setattr(comfyui, "server_argv", argv)
    return cpu_asked


def _config(data_dir: Path, port: int, **overrides) -> EngineConfig:
    return EngineConfig(
        **{
            "data_dir": data_dir,
            "token": TOKEN,
            "backend": "ffmpeg,mock",
            "llm_url": "http://127.0.0.1:9/v1",
            "comfyui_url": f"http://127.0.0.1:{port}",
            **overrides,
        }
    )


@pytest.fixture
def archives(tmp_path):
    root = tmp_path / "served"
    root.mkdir()
    server = _Archives(root)
    yield server
    server.close()


def _record(folder: Path) -> dict:
    return json.loads((folder / "program.json").read_text(encoding="utf-8"))


async def _wait_ready(http) -> dict:  # noqa: ANN001 - the engine's client
    row = _row((await http.get("/programs")).json(), "comfyui")
    async with asyncio.timeout(30):
        while row["state"] != "ready":
            await asyncio.sleep(0.2)
            row = _row((await http.get("/programs")).json(), "comfyui")
    return row


# -- a setup, end to end ---------------------------------------------------------------


async def test_setup_builds_the_copy_from_the_runtime_the_source_and_the_wheels(
    tmp_path, monkeypatch, archives
):
    """The click downloads the runtime, the source and every wheel the lock
    pins, each held to its size and digest; unpacks them into one folder in
    the layout the Windows build has, with each wheel's files where an
    installer puts them and its console scripts left out; walks it against
    the pin; asks its PyTorch to use the card; moves it into place and
    starts it. The report's sizes are the pins' before and the record's
    after."""
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    usual, older, cpu = _nvidia_and_cpu(pins)
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    asked = _device_check(monkeypatch)
    cpu_asked = _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"

    async with _engine(_config(data, free_port())) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["available"], setup["takes_effect"]) == (True, True)
        assert (setup["gpu"], setup["build"]) == ("nvidia", None)
        assert setup["download_bytes"] == pins.download_bytes(usual)
        assert setup["install_bytes"] == usual["environment"]["bytes"]
        assert [(b["build"], b["download_bytes"]) for b in setup["builds"]] == [
            ("older_drivers", pins.download_bytes(older)),
            ("cpu", pins.download_bytes(cpu)),
        ]

        assert (await http.post("/programs/comfyui/setup")).json()["status"] == "started"
        row = await _settled(http, "comfyui")
        assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
        row = await _wait_ready(http)
        assert (row["state"], row["source"], row["version"]) == ("ready", "managed", "0.40.0")
        managed = row["managed"]
        assert (managed["in_use"], managed["current"], managed["build"]) == (True, True, None)
        assert managed["server"]["state"] == "running"

    served = sorted(path.rsplit("/", 1)[-1] for path in archives.requests)
    assert served == sorted(["cpython.tar.gz", "source-cu130.tar.gz", *WHEELS])
    assert asked == [None] and set(cpu_asked) == {False}
    folder = data / "programs" / "comfyui"
    site = folder / "python" / "lib" / "python3.13" / "site-packages"
    assert (folder / "ComfyUI" / "main.py").read_text() == "print('comfy')\n"
    assert (site / "torch" / "__init__.py").is_file()
    assert (site / "pkg_extra.py").read_text() == "EXTRA = 1\n"
    assert (folder / "python" / "share" / "pkg" / "readme.txt").read_text() == "shared\n"
    assert not list(folder.rglob("pkg-cli"))
    # The later wheel's copy of a file two wheels carry.
    assert (site / "nvidia" / "__init__.py").read_bytes() == b""
    if LINKS_HERE:
        assert os.readlink(folder / "python" / "bin" / "python3") == "python3.13"
        assert os.access(folder / "python" / "bin" / "python3.13", os.X_OK)
    record = _record(folder)
    assert (record["gpu"], record["build"]) == ("nvidia", None)
    assert record["lock_sha256"] == usual["environment"]["lock_sha256"]
    files, total, links = environment.walk(folder)
    paths_file = folder / "extra_model_paths.yaml"
    assert record["bytes"] == total - paths_file.stat().st_size
    assert managed["bytes"] == record["bytes"]
    assert sorted(entry.name for entry in (data / "programs").iterdir()) == ["comfyui"]


async def test_the_progress_counts_every_wheel_downloaded_then_every_byte_unpacked(
    tmp_path, monkeypatch, archives
):
    """One bar for many files: the download's total is all of them and the
    unpack's is the whole copy."""
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    usual = pins.build("cu130", "nvidia")
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    _device_check(monkeypatch)
    _fake_server(monkeypatch, tmp_path)
    seen: list[dict] = []
    real_progress = program_setup.ProgramSetup._progress

    def progress(self, job, done):  # noqa: ANN001 - a setup and its job
        real_progress(self, job, done)
        seen.append({"phase": job.phase, "done": job.done, "total": job.total})

    monkeypatch.setattr(program_setup.ProgramSetup, "_progress", progress)
    async with _engine(_config(tmp_path / "data", free_port())) as http:
        await http.post("/programs/comfyui/setup")
        assert (await _settled(http, "comfyui"))["setup"]["last"]["outcome"] == "done"
    downloading = [s for s in seen if s["phase"] in ("downloading", "verifying")]
    unpacking = [s for s in seen if s["phase"] == "unpacking"]
    assert {s["total"] for s in downloading} == {pins.download_bytes(usual)}
    assert max(s["done"] for s in downloading) == pins.download_bytes(usual)
    assert {s["total"] for s in unpacking} == {usual["environment"]["bytes"]}
    assert unpacking[-1]["done"] == usual["environment"]["bytes"]


async def test_no_card_gets_the_processors_build_and_says_so(tmp_path, monkeypatch, archives):
    """A machine with no card a build is pinned for gets the build for the
    processor rather than nothing. Its check computes on the processor and
    LocalCut's copy is started with ComfyUI told to run there."""
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    _nvidia_and_cpu(pins)
    _card(monkeypatch, None)
    asked = _device_check(monkeypatch)
    cpu_asked = _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"
    async with _engine(_config(data, free_port())) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["available"], setup["gpu"], setup["build"]) == (True, None, "cpu")
        assert setup["builds"] == []
        await http.post("/programs/comfyui/setup")
        last = (await _settled(http, "comfyui"))["setup"]["last"]
        assert (last["outcome"], last["build"]) == ("done", "cpu")
        row = await _wait_ready(http)
        assert row["managed"]["build"] == "cpu"
    assert asked == ["cpu"] and set(cpu_asked) == {True}
    assert _record(data / "programs" / "comfyui")["build"] == "cpu"


async def test_after_the_cards_builds_cannot_use_it_the_processors_can_be_asked_for(
    tmp_path, monkeypatch, archives
):
    """The usual build's PyTorch cannot use the card: the setup keeps
    nothing and the report offers the build for older drivers and the
    processor's; the processor's, asked for by name, is set up and stays
    that build at the next setup."""
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    _nvidia_and_cpu(pins)
    _card(monkeypatch, "nvidia", None, None)
    _device_check(monkeypatch, failing={None, "older_drivers"})
    _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"
    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        row = await _settled(http, "comfyui")
        assert (row["setup"]["last"]["reason"], row["managed"]) == ("gpu_not_usable", None)
        assert [b["build"] for b in row["setup"]["builds"]] == ["older_drivers", "cpu"]
        await http.post("/programs/comfyui/setup?build=older_drivers")
        row = await _settled(http, "comfyui")
        assert row["setup"]["last"]["reason"] == "gpu_not_usable"
        assert not [p for p in (data / "programs").iterdir()]

        started = await http.post("/programs/comfyui/setup?build=cpu")
        assert started.json()["status"] == "started"
        row = await _settled(http, "comfyui")
        assert (row["setup"]["last"]["outcome"], row["setup"]["last"]["build"]) == ("done", "cpu")
        assert row["setup"]["build"] == "cpu"
        assert (await http.post("/programs/comfyui/setup")).json() == {"status": "installed"}

    # An AMD machine is offered the processor's build beside its own and
    # never NVIDIA's.
    pins.build("rocm72", "amd")
    _card(monkeypatch, "amd")
    async with _engine(_config(tmp_path / "amd", free_port())) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["gpu"], setup["build"]) == ("amd", None)
        assert [b["build"] for b in setup["builds"]] == ["cpu"]
        assert (await http.post("/programs/comfyui/setup?build=older_drivers")).status_code == 409


@pytest.mark.parametrize(
    ("change", "reason", "said"),
    [
        # The source's requirements are not the ones the lock was made from.
        ({"requirements": b"torch\npkg>=2.0\n"}, "unpack_failed", "was made from"),
        # The lock's figures for the copy are not what was unpacked.
        ({"figures": {"files": 1}}, "unpack_failed", "were unpacked"),
        # A wheel that is not the one locked.
        (
            {"digest_of": {"pkg-1.0-py3-none-any.whl": "f" * 64}},
            "checksum_mismatch",
            "SHA-256",
        ),
        # A wheel that would write outside site-packages.
        (
            {"wheels": {"pkg-1.0-py3-none-any.whl": {"../../../../evil.py": b"x"}}},
            "unpack_failed",
            "would land outside",
        ),
    ],
)
async def test_a_copy_that_is_not_the_pins_is_never_kept(
    tmp_path, monkeypatch, archives, change, reason, said
):
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    pins.build("cu130", "nvidia", **change)
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    asked = _device_check(monkeypatch)
    data = tmp_path / "data"
    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        last = (await _settled(http, "comfyui"))["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", reason), last
    assert said in last["error"]
    assert asked == []
    assert not [p for p in (data / "programs").iterdir()]
    assert not list(tmp_path.rglob("evil.py"))


async def test_cancel_partway_through_the_download_removes_everything(
    tmp_path, monkeypatch, archives
):
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    pins.build("cu130", "nvidia")
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    _device_check(monkeypatch)
    _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"
    # A slow link: every file arrives a few bytes at a time.
    archives.pace = (16, 0.2)
    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        async with asyncio.timeout(60):
            while True:
                job = _row((await http.get("/programs")).json(), "comfyui")["setup"]["job"]
                if job and job["phase"] == "downloading" and job["done"] > 0:
                    break
                await asyncio.sleep(0.05)
        assert (await http.delete("/programs/comfyui/setup")).status_code == 200
        last = (await _settled(http, "comfyui"))["setup"]["last"]
    assert last["outcome"] == "cancelled"
    assert not [p for p in (data / "programs").iterdir()]


async def test_the_disk_has_to_hold_the_download_and_the_copy_at_once(
    tmp_path, monkeypatch, archives
):
    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    usual = pins.build("cu130", "nvidia")
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    need = pins.download_bytes(usual) + usual["environment"]["bytes"]
    real = program_setup.shutil.disk_usage

    def tight(path):  # noqa: ANN001 - a path
        return real(path)._replace(free=need - 1)

    monkeypatch.setattr(program_setup.shutil, "disk_usage", tight)
    async with _engine(_config(tmp_path / "data", free_port())) as http:
        refused = await http.post("/programs/comfyui/setup")
    assert refused.status_code == 507
    assert str(need) in refused.json()["detail"]
    assert archives.requests == []


# -- unpacking, piece by piece --------------------------------------------------------------


@pytest.mark.parametrize(
    ("member", "said"),
    [
        (("elsewhere/x.py", b"x"), "would land outside"),
        (("python/../x.py", b"x"), "would land outside"),
        (("python/lib/escape", "../../.."), "links outside"),
        (("python/lib/absolute", "/etc/passwd"), "links outside"),
        (("python/a.txt", b"x"), "twice"),
    ],
)
def test_an_archive_with_a_member_outside_its_top_folder_is_refused(tmp_path, member, said):
    members = [("python/a.txt", b"a"), member]
    archive = _tar(tmp_path / "a.tar.gz", members)
    with tarfile.open(archive) as listed:
        with pytest.raises(ArchiveRefused, match=said):
            environment._tar_plan(listed.getmembers(), KeptTree(root="python", files=2, bytes=2))


def test_nothing_in_an_archive_is_written_through_one_of_its_links(tmp_path):
    archive = _tar(
        tmp_path / "a.tar.gz",
        [("python/sub/a.txt", b"a"), ("python/lnk", "sub"), ("python/lnk/b.txt", b"b")],
    )
    with tarfile.open(archive) as listed:
        with pytest.raises(ArchiveRefused, match="under a link"):
            environment._tar_plan(
                listed.getmembers(), KeptTree(root="python", files=2, bytes=2, links=1)
            )


def test_an_archive_with_a_hard_link_or_a_device_is_refused(tmp_path):
    archive = tmp_path / "a.tar.gz"
    with tarfile.open(archive, "w:gz") as out:
        info = tarfile.TarInfo("python/hard")
        info.type, info.linkname = tarfile.LNKTYPE, "python/a.txt"
        out.addfile(info)
    with tarfile.open(archive) as listed:
        with pytest.raises(ArchiveRefused, match="not a plain file"):
            environment._tar_plan(listed.getmembers(), KeptTree(root="python", files=1, bytes=1))


def test_a_wheel_never_writes_through_a_link_or_onto_a_folder(tmp_path):
    site = tmp_path / "site"
    (site / "pkg" / "sub").mkdir(parents=True)
    wheel = _wheel(tmp_path / "a-1-py3-none-any.whl", {"pkg/sub": b"x"})
    with pytest.raises(ArchiveRefused, match="where a folder is"):
        environment.unpack_wheel(wheel, site, tmp_path, lambda n: None, threading.Event())
    if LINKS_HERE:
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (site / "linked").symlink_to(elsewhere)
        wheel = _wheel(tmp_path / "c-1-py3-none-any.whl", {"linked/evil.py": b"x"})
        with pytest.raises(ArchiveRefused, match="through a link"):
            environment.unpack_wheel(wheel, site, site, lambda n: None, threading.Event())
        assert list(elsewhere.iterdir()) == []
        outside = tmp_path / "outside.txt"
        outside.write_text("keep")
        (site / "pkg" / "linked.py").symlink_to(outside)
        wheel = _wheel(tmp_path / "b-1-py3-none-any.whl", {"pkg/linked.py": b"new"})
        environment.unpack_wheel(wheel, site, tmp_path, lambda n: None, threading.Event())
        assert outside.read_text() == "keep"
        assert (site / "pkg" / "linked.py").read_bytes() == b"new"
        assert not (site / "pkg" / "linked.py").is_symlink()


# -- running it ------------------------------------------------------------------------


def _standalone(folder: Path) -> Path:
    python = folder / "python" / "bin" / "python3"
    python.parent.mkdir(parents=True)
    python.write_text("#!/bin/sh\n")
    return python


def test_the_copy_runs_comfyuis_main_under_its_own_python(tmp_path):
    """The standalone Python with no user site-packages and no PYTHONPATH,
    ComfyUI's main.py, the address, the model paths file and no browser;
    the processor's build adds --cpu. No Windows-only flag."""
    folder = tmp_path / "comfyui"
    _standalone(folder)
    argv = comfyui.server_argv(folder, host="127.0.0.1", port=8190)
    assert argv == [
        str(folder / "python" / "bin" / "python3"),
        "-s",
        "-E",
        str(folder / "ComfyUI" / "main.py"),
        "--disable-auto-launch",
        "--listen",
        "127.0.0.1",
        "--port",
        "8190",
        "--extra-model-paths-config",
        str(folder / "extra_model_paths.yaml"),
    ]
    assert comfyui.server_argv(folder, host="127.0.0.1", port=8190, cpu=True)[-1] == "--cpu"


def test_the_launch_is_the_one_windows_has_with_the_linux_python(tmp_path):
    """LocalCut's copy on Linux is started through the same launch as the
    portable build: the working folder outside the copy, and for the
    processor's build, --cpu."""
    data_dir = tmp_path / "data"
    copy = data_dir / "programs" / "comfyui"
    _standalone(copy)
    config = EngineConfig(data_dir=data_dir, token=TOKEN, comfyui_url="http://127.0.0.1:8190")
    installer = program_setup.INSTALLERS["comfyui"]
    work = (data_dir / "work" / "comfyui").resolve()
    for build in (None, "cpu"):
        (copy / "program.json").write_text(json.dumps({"format": 1, "build": build}))
        launch = installer.launch(config)
        assert launch is not None
        assert launch.argv == [
            *comfyui.server_argv(copy, host="127.0.0.1", port=8190, cpu=build == "cpu"),
            *comfyui.working_argv(work),
        ]
        assert launch.argv[:3] == [str(copy / "python" / "bin" / "python3"), "-s", "-E"]
        after = launch.argv[launch.argv.index("--extra-model-paths-config") + 2]
        assert after == ("--cpu" if build == "cpu" else "--output-directory")
        assert "--windows-standalone-build" not in launch.argv
        assert launch.cwd == copy


def test_a_frozen_engine_gives_the_copy_back_the_library_path_it_started_with(monkeypatch):
    """PyInstaller points LD_LIBRARY_PATH at the freeze's own libraries and
    keeps what it was in LD_LIBRARY_PATH_ORIG. Windows has no such path."""
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert comfyui.child_environment() == {}
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI1234")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/opt/cuda/lib64")
    posix = os.name != "nt"
    assert comfyui.child_environment() == ({"LD_LIBRARY_PATH": "/opt/cuda/lib64"} if posix else {})
    monkeypatch.delenv("LD_LIBRARY_PATH_ORIG")
    assert comfyui.child_environment() == ({"LD_LIBRARY_PATH": ""} if posix else {})


FAKE_TORCH = textwrap.dedent(
    """\
    __version__ = "2.14.1+cpu"
    class _Cuda:
        def is_available(self):
            return False
    cuda = _Cuda()
    class _Ones:
        def __init__(self, n):
            self.n = n
        def __mul__(self, k):
            return _Ones(self.n * k)
        def sum(self):
            return self
        def item(self):
            return self.n
    def ones(n, device=None):
        assert device == "cpu", device
        return _Ones(n)
    """
)


@pytest.mark.parametrize(
    ("build", "outcome"), [("cpu", {"device": "CPU"}), (None, "gpu_not_usable")]
)
async def test_the_check_runs_the_copys_own_python_and_the_processors_build_sums_there(
    tmp_path, monkeypatch, build, outcome
):
    """The copy's Python ignores PYTHONPATH, so the stand-in PyTorch sits in
    the folder it runs in, which is where `-c` looks first. The processor's
    build sums on the processor; a CUDA build whose PyTorch finds no card
    fails as gpu_not_usable."""
    _standalone(tmp_path)
    (tmp_path / "torch").mkdir()
    (tmp_path / "torch" / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "torch").mkdir(parents=True)
    (elsewhere / "torch" / "__init__.py").write_text("raise ImportError('PYTHONPATH')\n")
    monkeypatch.setenv("PYTHONPATH", str(elsewhere))
    monkeypatch.setattr(comfyui, "python_of", lambda folder: Path(sys.executable))
    asset = type("Asset", (), {"build": build, "gpu": None if build else "nvidia"})()
    installer = program_setup.ComfyUIInstaller()
    if isinstance(outcome, dict):
        assert await installer.check(tmp_path, asset) == outcome
        return
    with pytest.raises(program_setup.SetupFailed) as failed:
        await installer.check(tmp_path, asset)
    assert failed.value.reason == outcome


# -- the readiness report and the CLI ---------------------------------------------------


async def test_a_comfyui_that_is_down_offers_the_linux_setup(tmp_path, monkeypatch, archives):
    """A `comfyui_down` row carries the setup once the card is known, with
    everything it downloads: the source, the runtime and the wheels."""
    from localcut_engine import readiness
    from localcut_engine.api.app import _build_backends
    from localcut_engine.graph.model import NodeKind
    from localcut_engine.readiness import readiness_rows

    pins = _LinuxPins(monkeypatch, archives, tmp_path)
    usual, _, _ = _nvidia_and_cpu(pins)
    monkeypatch.setattr(readiness, "_comfy_alive", lambda config: False)
    _card(monkeypatch, "nvidia", "595.58.03", "8.6")
    config = _config(tmp_path / "local", free_port(), backend="comfy,mock", comfy_kinds="keyframe")
    kinds = [(NodeKind.KEYFRAME, None)]
    rows = await readiness_rows(config, _build_backends(config), kinds)
    assert [row["fix"] for row in rows if row["reason"] == "comfyui_down"] == [None]
    probe.machine_profile(str(config.data_dir))
    rows = await readiness_rows(config, _build_backends(config), kinds)
    assert [row["fix"] for row in rows if row["reason"] == "comfyui_down"] == [
        {"type": "setup_program", "program": "comfyui", "size_bytes": pins.download_bytes(usual)}
    ]


def test_the_cli_names_the_processors_build():
    row = {
        "id": "comfyui",
        "state": "missing",
        "version": None,
        "source": "default",
        "location": "http://127.0.0.1:8188",
        "problem": "unreachable",
        "checks": {},
        "managed": None,
        "setup": {
            "available": True,
            "download_bytes": 3 << 30,
            "gpu": "nvidia",
            "build": None,
            "builds": [
                {"build": "older_drivers", "download_bytes": 2 << 30},
                {"build": "cpu", "download_bytes": 1 << 30},
            ],
            "job": None,
            "last": {"outcome": "failed", "reason": "gpu_not_usable", "build": "older_drivers"},
        },
    }
    line = cli._program_line(row)
    assert "--build older_drivers" not in line
    assert "`localcut programs setup comfyui --build cpu` downloads 1024 MiB" in line
    assert "the build for the processor" in line
    assert line.isascii()


def test_the_card_picks_the_linux_build():
    pin, _ = _linux_assets()

    def card(vendor, driver=None, compute=None):  # noqa: ANN001, ANN202
        return probe.GPU(
            vendor=vendor,
            name="c",
            vram_gb=8,
            backend="cuda",
            driver_version=driver,
            compute_capability=compute,
        )

    def picked(gpu, build=None):  # noqa: ANN001, ANN202
        asset = builds.choose(pin, "linux-x64", gpu, build)
        return None if asset is None else (asset.gpu, asset.build)

    assert picked(card("nvidia", "595.58.03", "8.6")) == ("nvidia", None)
    assert picked(card("nvidia", "550.163.01", "8.6")) == ("nvidia", "older_drivers")
    assert picked(card("nvidia", "595.58.03", "6.1")) == ("nvidia", "older_drivers")
    assert picked(card("amd")) == ("amd", None)
    assert picked(card("intel")) == ("intel", None)
    assert picked(card("apple")) == (None, "cpu")
    assert picked(None) == (None, "cpu")
    assert picked(card("amd"), "cpu") == (None, "cpu")
    assert picked(card("amd"), "older_drivers") is None
    # Nothing for Linux on ARM yet.
    assert builds.choose(pin, "linux-arm64", card("nvidia")) is None
