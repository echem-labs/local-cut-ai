"""Lock ComfyUI's Linux environment, for the pinned ComfyUI or a new one.

    cd engine
    uv run python scripts/lock-comfyui-linux.py --comfyui 0.42.1 \\
        --python 3.13.16 --python-release 20261013 --torch 2.14.1

Run it whenever ComfyUI's pin moves (the Windows portable builds move with
it) or PyTorch, the standalone Python or a ComfyUI dependency needs to. It
needs `uv` on PATH and the network. It downloads ComfyUI's source and the
standalone Python (about 50 MB). Wheels are read without being downloaded:
their sizes come from the index and what each unpacks to from its zip
directory, fetched with Range requests. Both of those are what a setup
checks again when it downloads the real thing.

For each of LocalCut's Linux builds (NVIDIA's CUDA 13, NVIDIA's CUDA 12.6
for older drivers, AMD's ROCm, Intel's XPU and the processor's) it

1. resolves ComfyUI's own requirements.txt at the tag, as the source archive
   holds it, with uv: `uv pip compile --torch-backend <backend>
   --generate-hashes --only-binary :all:` for CPython on x86_64 Linux
   (manylinux_2_28), PyTorch held to `--torch` so every build has the same;
2. keeps one wheel per package, the one the target Python prefers, so the
   lock leaves nothing to choose at setup time;
3. counts what the copy holds once a setup has unpacked the runtime, the
   source and the wheels, by the rule the setup itself uses
   (`environment.wheel_target`);
4. writes `src/localcut_engine/programs/locks/pylock.comfyui-<build>.toml`
   (PEP 751, with each wheel's licence from its own metadata) and the
   linux-x64 ComfyUI assets and the runtime pin in programs-manifest.json.

test_programs_comfyui_linux.py then holds the locks to the manifest and to
the pinned source's requirements.
"""

from __future__ import annotations

import argparse
import datetime
import email.parser
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx
from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.tags import Tag, compatible_tags, cpython_tags
from packaging.utils import canonicalize_name, parse_wheel_filename

ENGINE = Path(__file__).resolve().parent.parent
PROGRAMS = ENGINE / "src" / "localcut_engine" / "programs"
MANIFEST = PROGRAMS / "programs-manifest.json"
LOCKS = PROGRAMS / "locks"

sys.path.insert(0, str(ENGINE / "src"))
from localcut_engine.programs import environment  # noqa: E402
from localcut_engine.programs.manifest import RuntimePin, parse_programs_manifest  # noqa: E402

#: (lock name, GPU vendor, build, uv's torch backend, what the card needs).
BUILDS = (
    ("cu130", "nvidia", None, "cu130", {"nvidia_driver": "580", "compute_capability": "7.5"}),
    ("cu126", "nvidia", "older_drivers", "cu126", {"nvidia_driver": "525"}),
    ("rocm72", "amd", None, "rocm7.2", None),
    ("xpu", "intel", None, "xpu", None),
    ("cpu", None, "cpu", "cpu", None),
)
PLATFORM = "x86_64-manylinux_2_28"
# The manylinux versions a glibc 2.28 machine runs, newest first.
_GLIBC_MINOR = 28
SOURCE_URL = "https://github.com/Comfy-Org/ComfyUI/archive/refs/tags/v{version}.tar.gz"
RUNTIME_RELEASE = (
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/{tag}"
)
RUNTIME_ASSET = "cpython-{python}+{tag}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"


def target_tags(python: str) -> list[Tag]:
    """Every tag CPython `python` on x86_64 glibc 2.28 Linux installs, most
    preferred first."""
    major, minor = (int(part) for part in python.split(".")[:2])
    platforms = []
    for glibc in range(_GLIBC_MINOR, 4, -1):
        platforms.append(f"manylinux_2_{glibc}_x86_64")
        legacy = {17: "manylinux2014", 12: "manylinux2010", 5: "manylinux1"}.get(glibc)
        if legacy:
            platforms.append(f"{legacy}_x86_64")
    # Last, as pip on Linux takes it: PyTorch's index tags ROCm's Triton so.
    platforms.append("linux_x86_64")
    return [
        *cpython_tags((major, minor), platforms=platforms),
        *compatible_tags((major, minor), platforms=platforms),
    ]


def marker_environment(python: str) -> dict[str, str]:
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


# -- reading what is published -----------------------------------------------------


def download(client: httpx.Client, url: str, into: Path, cache: Path | None = None) -> Path:
    """`url` into `into`, or from `cache` where an earlier run left it."""
    kept = cache / hashlib.sha256(url.encode()).hexdigest()[:16] if cache else None
    if kept is not None and kept.is_file():
        shutil.copyfile(kept, into)
        return into
    with client.stream("GET", url, follow_redirects=True) as response:
        response.raise_for_status()
        with into.open("wb") as sink:
            for chunk in response.iter_bytes(1 << 20):
                sink.write(chunk)
    if kept is not None:
        kept.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(into, kept)
    return into


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


class RemoteFile(io.RawIOBase):
    """A file on a server that answers Range requests, read in blocks, for
    zipfile to find a wheel's directory in without downloading it."""

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

    def _block(self, index: int) -> bytes:
        if index not in self.blocks:
            start = index * self._BLOCK
            end = min(self.size, start + self._BLOCK) - 1
            response = self.client.get(
                self.url, headers={"Range": f"bytes={start}-{end}"}, follow_redirects=True
            )
            if response.status_code != 206:
                raise RuntimeError(
                    f"{self.url} answered a Range request with {response.status_code}"
                )
            self.blocks[index] = response.content
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


def licence_of(metadata: bytes) -> str:
    """A wheel's licence as its METADATA states it: the SPDX expression where
    there is one, else the classifiers, else the first line of License."""
    headers = email.parser.BytesHeaderParser().parsebytes(metadata)
    expression = (headers.get("License-Expression") or "").strip()
    if expression:
        return expression
    classifiers = [
        value.split("::")[-1].strip()
        for value in headers.get_all("Classifier") or []
        if value.startswith("License ::") and value.split("::")[-1].strip() != "OSI Approved"
    ]
    if classifiers:
        return " AND ".join(dict.fromkeys(classifiers))
    stated = (headers.get("License") or "").strip().splitlines()
    return stated[0][:80] if stated else "not stated"


_wheels_read: dict[str, tuple[list[zipfile.ZipInfo], str]] = {}


def read_wheel(client: httpx.Client, url: str, size: int) -> tuple[list[zipfile.ZipInfo], str]:
    """A wheel's members and its licence, read from its zip directory and
    its METADATA without downloading the rest. Most wheels are in every
    build's lock and each is read once."""
    if url not in _wheels_read:
        with zipfile.ZipFile(RemoteFile(client, url, size)) as remote:
            members = remote.infolist()
            metadata = next(
                (m for m in members if re.fullmatch(r"[^/]+\.dist-info/METADATA", m.filename)),
                None,
            )
            licence = licence_of(remote.read(metadata)) if metadata else "not stated"
        _wheels_read[url] = (members, licence)
    return _wheels_read[url]


def tar_listing(archive: Path) -> tuple[str, dict[str, tuple[str, int]]]:
    """(top folder, {path under it: (kind, size)}) for a tar.gz."""
    entries: dict[str, tuple[str, int]] = {}
    roots = set()
    with tarfile.open(archive, "r:gz") as untarred:
        for member in untarred:
            parts = member.name.rstrip("/").split("/")
            roots.add(parts[0])
            if len(parts) == 1:
                continue
            path = "/".join(parts[1:])
            if member.isreg():
                entries[path] = ("file", member.size)
            elif member.issym():
                entries[path] = ("link", 0)
            elif member.isdir():
                entries[path] = ("dir", 0)
            else:
                raise SystemExit(f"{archive.name}: {member.name} is not a file, folder or link")
    if len(roots) != 1:
        raise SystemExit(f"{archive.name} has {len(roots)} top folders")
    return roots.pop(), entries


def tree_of(root: str, entries: dict[str, tuple[str, int]]) -> dict:
    files = [size for kind, size in entries.values() if kind == "file"]
    links = sum(1 for kind, _ in entries.values() if kind == "link")
    return {"root": root, "files": len(files), "bytes": sum(files), "links": links}


# -- one build ----------------------------------------------------------------------


def resolve(requirements: Path, backend: str, python: str, torch: str | None, out: Path) -> dict:
    """uv's resolution of `requirements` for the target, as a pylock."""
    command = [
        "uv",
        "pip",
        "compile",
        str(requirements),
        "--no-config",
        "--torch-backend",
        backend,
        "--python-version",
        python,
        "--python-platform",
        PLATFORM,
        "--only-binary",
        ":all:",
        "--generate-hashes",
        "--format",
        "pylock.toml",
        "--no-header",
        "--quiet",
        "-o",
        str(out),
    ]
    if torch:
        constraints = out.with_suffix(".constraints.txt")
        constraints.write_text(f"torch=={torch}\n", encoding="utf-8")
        command += ["--constraints", str(constraints)]
    subprocess.run(command, check=True)
    return tomllib.loads(out.read_text(encoding="utf-8"))


def best_wheel(package: dict, tags: list[Tag]) -> dict:
    """The wheel the target Python prefers of those uv lists."""
    rank = {tag: index for index, tag in enumerate(tags)}

    def score(wheel: dict) -> int:
        filename = wheel.get("name") or unquote(urlsplit(wheel["url"]).path.rsplit("/", 1)[-1])
        _, _, _, wheel_tags = parse_wheel_filename(filename)
        return min((rank[tag] for tag in wheel_tags if tag in rank), default=len(rank))

    wheels = sorted(package["wheels"], key=score)
    if not wheels or score(wheels[0]) == len(rank):
        raise SystemExit(f"{package['name']} has no wheel for the target")
    return wheels[0]


def lock_build(
    client: httpx.Client,
    name: str,
    backend: str,
    resolved: dict,
    python: str,
    copy: dict[str, tuple[str, int]],
    runtime: RuntimePin,
    header: dict,
) -> tuple[str, dict]:
    """The lock's text and its figures for the manifest."""
    tags = target_tags(python)
    markers = marker_environment(python)
    copy = dict(copy)
    packages = []
    for package in sorted(resolved["packages"], key=lambda p: canonicalize_name(p["name"])):
        marker = package.get("marker")
        if marker and not Marker(marker).evaluate(markers):
            continue
        wheel = best_wheel(package, tags)
        url = wheel["url"]
        filename = wheel.get("name") or unquote(urlsplit(url).path.rsplit("/", 1)[-1])
        size = wheel.get("size")
        if not size:
            head = client.head(url, follow_redirects=True)
            head.raise_for_status()
            size = int(head.headers["content-length"])
        members, licence = read_wheel(client, url, size)
        files = total = 0
        for member in members:
            target = environment.wheel_target(member.filename)
            if target is None:
                continue
            base, path = target
            where = environment.copy_path(base, path, runtime)
            if copy.get(where, ("file", 0))[0] == "dir":
                raise SystemExit(f"{filename}: {member.filename} is a file where a folder is")
            copy[where] = ("file", member.file_size)
            files += 1
            total += member.file_size
            parent = where.rpartition("/")[0]
            while parent and copy.get(parent, ("dir", 0))[0] == "dir":
                copy[parent] = ("dir", 0)
                parent = parent.rpartition("/")[0]
            if parent:
                raise SystemExit(f"{filename}: {member.filename} is under a file, {parent}")
        packages.append(
            {
                "name": package["name"],
                "version": package["version"],
                "index": package.get("index"),
                "filename": filename,
                "url": url,
                "size": size,
                "sha256": wheel["hashes"]["sha256"],
                "licence": licence,
                "files": files,
                "bytes": total,
            }
        )
        print(f"  {package['name']} {package['version']}: {size} bytes, {licence}", flush=True)
    whole = tree_of("", copy)
    lines = [
        "# LocalCut's ComfyUI on Linux: every wheel a setup unpacks into the",
        f"# standalone Python, for PyTorch's {backend} build. Written by",
        "# engine/scripts/lock-comfyui-linux.py; do not edit it by hand.",
        'lock-version = "1.0"',
        'created-by = "localcut lock-comfyui-linux.py"',
        f"requires-python = {json.dumps('==' + python)}",
        "environments = [\"sys_platform == 'linux' and platform_machine == 'x86_64'\"]",
        "",
    ]
    for package in packages:
        lines += [
            "[[packages]]",
            f"name = {json.dumps(package['name'])}",
            f"version = {json.dumps(package['version'])}",
        ]
        if package["index"]:
            lines.append(f"index = {json.dumps(package['index'])}")
        lines += [
            "wheels = [{ "
            f"name = {json.dumps(package['filename'])}, url = {json.dumps(package['url'])}, "
            f"size = {package['size']}, hashes = {{ sha256 = {json.dumps(package['sha256'])} }}"
            " }]",
            "",
            "[packages.tool.localcut]",
            f"licence = {json.dumps(package['licence'])}",
            f"files = {package['files']}",
            f"bytes = {package['bytes']}",
            "",
        ]
    lines += [
        "[tool.localcut]",
        f"torch-backend = {json.dumps(backend)}",
        f"platform = {json.dumps(PLATFORM)}",
        f"uv = {json.dumps(header['uv'])}",
        "",
        "[tool.localcut.comfyui]",
        f"version = {json.dumps(header['version'])}",
        f"url = {json.dumps(header['url'])}",
        f"sha256 = {json.dumps(header['sha256'])}",
        f"requirements_sha256 = {json.dumps(header['requirements_sha256'])}",
        "requirements = [",
        *(f"    {json.dumps(line)}," for line in header["requirements"]),
        "]",
        "",
    ]
    text = "\n".join(lines)
    figures = {
        "runtime": runtime.id,
        "lock": f"pylock.comfyui-{name}.toml",
        "lock_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "wheels": len(packages),
        "wheel_bytes": sum(package["size"] for package in packages),
        "files": whole["files"],
        "bytes": whole["bytes"],
        "links": whole["links"],
    }
    return text, figures


def requirement_lines(text: str) -> list[str]:
    lines = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            Requirement(line)
            lines.append(line)
    return lines


def main() -> int:
    manifest_text = MANIFEST.read_text(encoding="utf-8")
    current = json.loads(manifest_text)
    comfy = next(pin for pin in current["programs"] if pin["id"] == "comfyui")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--comfyui", default=comfy["version"])
    parser.add_argument("--python", required=True, help="the CPython version, e.g. 3.13.16")
    parser.add_argument("--python-release", required=True, help="python-build-standalone's tag")
    parser.add_argument("--torch", help="the PyTorch version every build gets")
    parser.add_argument(
        "--cache",
        type=Path,
        help="a folder to keep the source and the runtime in between runs; the runtime is "
        "still held to its published digest",
    )
    args = parser.parse_args()
    if shutil.which("uv") is None:
        raise SystemExit("uv is not on PATH")
    uv = subprocess.run(["uv", "--version"], capture_output=True, text=True, check=True)
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    api_headers = {"Authorization": f"Bearer {token}"} if token else {}

    with tempfile.TemporaryDirectory(prefix="lock-comfyui-") as scratch_dir:
        scratch = Path(scratch_dir)
        with httpx.Client(timeout=httpx.Timeout(60)) as client:
            source_url = SOURCE_URL.format(version=args.comfyui)
            source = download(client, source_url, scratch / "source.tar.gz", args.cache)
            root, source_entries = tar_listing(source)
            with tarfile.open(source, "r:gz") as untarred:
                member = untarred.extractfile(f"{root}/requirements.txt")
                assert member is not None
                requirements_bytes = member.read()
            requirements = scratch / "requirements.txt"
            requirements.write_bytes(requirements_bytes)
            print(f"ComfyUI {args.comfyui}: {source.stat().st_size} bytes", flush=True)

            release = client.get(
                RUNTIME_RELEASE.format(tag=args.python_release), headers=api_headers
            )
            release.raise_for_status()
            asset_name = RUNTIME_ASSET.format(python=args.python, tag=args.python_release)
            published = next(a for a in release.json()["assets"] if a["name"] == asset_name)
            runtime_file = download(
                client, published["browser_download_url"], scratch / "py.tgz", args.cache
            )
            digest = sha256_of(runtime_file)
            if f"sha256:{digest}" != published["digest"]:
                raise SystemExit(f"{asset_name} does not hash to its published digest")
            runtime_root, runtime_entries = tar_listing(runtime_file)
            minor = ".".join(args.python.split(".")[:2])
            site = f"lib/python{minor}/site-packages"
            if not any(path.startswith(f"{site}/") for path in runtime_entries):
                raise SystemExit(f"{asset_name} has no {site}")
            runtime = RuntimePin(
                id="cpython",
                platform="linux-x64",
                version=args.python,
                license="PSF-2.0",
                url=published["browser_download_url"],
                size=published["size"],
                sha256=digest,
                format="tar.gz",
                tree=tree_of(runtime_root, runtime_entries),
                site_packages=site,
            )
            copy = {
                **{
                    environment.copy_path("runtime", p, runtime): e
                    for p, e in runtime_entries.items()
                },
                **{
                    environment.copy_path("source", p, runtime): e
                    for p, e in source_entries.items()
                },
            }
            header = {
                "uv": uv.stdout.split()[1],
                "version": args.comfyui,
                "url": source_url,
                "sha256": sha256_of(source),
                "requirements_sha256": hashlib.sha256(requirements_bytes).hexdigest(),
                "requirements": requirement_lines(requirements_bytes.decode("utf-8")),
            }
            source_tree = tree_of(root, source_entries)
            assets = []
            for name, gpu, build, backend, requires in BUILDS:
                print(f"{name}: resolving with uv ({backend})", flush=True)
                resolved = resolve(
                    requirements, backend, args.python, args.torch, scratch / f"pylock.{name}.toml"
                )
                text, figures = lock_build(
                    client, name, backend, resolved, args.python, copy, runtime, header
                )
                LOCKS.mkdir(exist_ok=True)
                (LOCKS / figures["lock"]).write_text(text, encoding="utf-8", newline="\n")
                assets.append(
                    {
                        "platform": "linux-x64",
                        **({"gpu": gpu} if gpu else {}),
                        **({"build": build} if build else {}),
                        **({"requires": requires} if requires else {}),
                        "url": source_url,
                        "size": source.stat().st_size,
                        "sha256": header["sha256"],
                        "format": "tar.gz",
                        "tree": source_tree,
                        "environment": figures,
                    }
                )
                print(
                    f"{name}: {figures['wheels']} wheels, {figures['wheel_bytes']} bytes; "
                    f"the copy {figures['files']} files, {figures['bytes']} bytes",
                    flush=True,
                )

    comfy["version"] = args.comfyui
    comfy["assets"] = [a for a in comfy["assets"] if a["platform"] != "linux-x64"] + assets
    current["runtimes"] = [
        r
        for r in current.get("runtimes", [])
        if (r["id"], r["platform"]) != ("cpython", "linux-x64")
    ] + [runtime.model_dump(exclude_defaults=False)]
    current["updated"] = datetime.date.today().isoformat()
    text = json.dumps(current, indent=2) + "\n"
    parse_programs_manifest(text)
    MANIFEST.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {MANIFEST.relative_to(ENGINE)} and {len(assets)} locks", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
