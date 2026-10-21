"""LocalCut's own ComfyUI: the Windows portable build for the machine's GPU
vendor, unpacked from its 7z by a pinned 7-Zip extractor, pointed at
LocalCut's models and run while the engine runs.

Nothing here downloads the real 2 GB build or the real 7zr.exe. Archives
are served from loopback, the way test_programs.py serves FFmpeg's. The
extractor is a stand-in, a Python script that answers `l -slt` and `x` the
way 7-Zip does for an archive written as JSON, so a test can hand the setup
any listing, including the ones a real archive should never hold. ComfyUI
itself is a stand-in server that answers /system_stats. The parsing of real
7-Zip output is checked against output 7-Zip 26.04 printed for a real
archive and the real archives' numbers are checked as pins.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest
from conftest import free_port, serve_engine
from test_programs import TOKEN, _Archives, _engine, _row, _settled

from localcut_engine import cli

from localcut_engine.config import EngineConfig
from localcut_engine.hardware import probe
from localcut_engine.manifest import downloads as downloads_module
from localcut_engine.manifest.loader import load_manifest
from localcut_engine.programs import BUILDS, SETUP_UNAVAILABLE, builds, comfyui, sevenzip
from localcut_engine.programs import manifest as program_manifest
from localcut_engine.programs import setup as program_setup
from localcut_engine.programs.manifest import KeptTree, parse_programs_manifest
from localcut_engine import readiness
from localcut_engine.readiness import readiness_rows

ROOT = "ComfyUI_windows_portable"
TEMPLATES = Path(comfyui.__file__).resolve().parent.parent / "comfy_templates"

# The stand-in for 7-Zip's console extractor. It reads an archive written as
# JSON ({"members": [{"path", "attributes", "data", "size"?}], ...}) and
# answers the two commands a setup gives it as 7-Zip does: `l -slt -ba`
# prints one block of "Key = value" lines per member and `x -o<folder>`
# writes the members under the folder, printing its percentage the way
# `-bsp1` does. Every command it is given is appended to $FAKE7Z_LOG.
FAKE_7Z = textwrap.dedent(
    r"""
    import json, os, sys, time
    args = sys.argv[1:]
    log = os.environ.get("FAKE7Z_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as out:
            out.write(args[0] + "\n")
    archive = json.load(open(args[-1], encoding="utf-8"))
    if args[0] == "l":
        if archive.get("list_exit"):
            sys.stderr.write("ERROR: cannot open the file as archive\n")
            sys.exit(archive["list_exit"])
        for member in archive["members"]:
            folder = "D" in member.get("attributes", "A").split(" ")[0]
            size = member.get("size", 0 if folder else len(member.get("data", "").encode()))
            print("Path = " + member["path"])
            print("Size = " + str(size))
            print("Packed Size = ")
            print("Attributes = " + member.get("attributes", "A"))
            for key in ("Symbolic Link",):
                if key in member:
                    print(key + " = " + member[key])
            print()
        sys.exit(0)
    into = next(arg[2:] for arg in args if arg.startswith("-o"))
    members = archive["members"]
    for index, member in enumerate(members):
        target = os.path.join(into, *member["path"].replace("\\", "/").split("/"))
        if "D" in member.get("attributes", "A").split(" ")[0]:
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="") as out:
                out.write(member.get("data", ""))
        sys.stdout.write("\b\b\b\b %d%%" % (100 * (index + 1) // len(members)))
        sys.stdout.flush()
        time.sleep(archive.get("pace_s", 0))
    for path, data in archive.get("extra_writes", {}).items():
        target = os.path.join(into, *path.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "w", encoding="utf-8").write(data)
    if archive.get("exit"):
        sys.stderr.write("ERROR: Data Error : " + members[-1]["path"] + "\n")
    sys.exit(archive.get("exit", 0))
    """
)

# A stand-in for ComfyUI's server: /system_stats and /queue, on the port it
# is given, until it is stopped.
FAKE_COMFYUI = textwrap.dedent(
    r"""
    import json, sys
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    port = int(sys.argv[sys.argv.index("--port") + 1])
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/system_stats":
                body = {"system": {"comfyui_version": "0.40.0"}, "devices": [{"type": "cuda"}]}
            elif self.path == "/queue":
                body = {"queue_running": [], "queue_pending": []}
            else:
                self.send_error(404)
                return
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("listening", flush=True)
    server.serve_forever()
    """
)


@pytest.fixture
def archives(tmp_path):
    root = tmp_path / "served"
    root.mkdir()
    server = _Archives(root)
    yield server
    server.close()


def _portable(extra: list[dict] | None = None, **settings) -> dict:
    """A portable build's archive as the stand-in extractor reads it: the
    top folder, the embedded Python, ComfyUI's main.py and a launch script."""
    members = [
        {"path": ROOT, "attributes": "D"},
        {"path": f"{ROOT}/python_embeded", "attributes": "D"},
        {"path": f"{ROOT}/python_embeded/python.exe", "attributes": "A", "data": "MZ python"},
        {"path": f"{ROOT}/ComfyUI", "attributes": "D"},
        {"path": f"{ROOT}/ComfyUI/main.py", "attributes": "A", "data": "print('comfy')\n"},
        {
            "path": f"{ROOT}/run_nvidia_gpu.bat",
            "attributes": "A",
            "data": r".\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build",
        },
        *(extra or []),
    ]
    return {"members": members, **settings}


def _tree_of(archive: dict) -> dict:
    files = [m for m in archive["members"] if "D" not in m.get("attributes", "A").split(" ")[0]]
    return {
        "root": ROOT,
        "files": len(files),
        "bytes": sum(len(m.get("data", "").encode()) for m in files),
    }


class _Pins:
    """Serves a set of portable builds and the stand-in extractor and makes
    them the pins for a windows-x64 machine."""

    def __init__(self, monkeypatch, archives: _Archives, tmp_path: Path) -> None:
        self.monkeypatch = monkeypatch
        self.archives = archives
        self.log = tmp_path / "fake7z.log"
        monkeypatch.setenv("FAKE7Z_LOG", str(self.log))
        extractor = archives.root / "7zr.exe"
        extractor.write_text(FAKE_7Z, encoding="utf-8")
        self.extractor = {
            "format": "7z",
            "platform": "windows-x64",
            "version": "26.04",
            "license": "LGPL-2.1-or-later",
            "url": f"{archives.url}/7zr.exe",
            "size": extractor.stat().st_size,
            "sha256": hashlib.sha256(extractor.read_bytes()).hexdigest(),
        }
        self.assets: list[dict] = []
        monkeypatch.setattr(program_manifest, "platform_key", lambda: "windows-x64")
        monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
        # The stand-in is a script, so it runs through this interpreter.
        monkeypatch.setattr(sevenzip, "command", lambda path: [sys.executable, str(path)])

    def build(
        self,
        name: str,
        gpu: str,
        archive: dict,
        *,
        build: str | None = None,
        requires: dict | None = None,
        tree: dict | None = None,
    ) -> dict:
        path = self.archives.root / name
        path.write_text(json.dumps(archive), encoding="utf-8")
        asset = {
            "platform": "windows-x64",
            "gpu": gpu,
            **({"build": build} if build else {}),
            **({"requires": requires} if requires else {}),
            "url": f"{self.archives.url}/{name}",
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "format": "7z",
            "tree": tree or _tree_of(archive),
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
            "extractors": [self.extractor],
        }
        pins = parse_programs_manifest(json.dumps(document))
        self.monkeypatch.setattr(program_manifest, "load_programs_manifest", lambda: pins)

    def commands(self) -> list[str]:
        return self.log.read_text().split() if self.log.exists() else []


def _usual_and_older(pins: _Pins) -> tuple[dict, dict]:
    usual = pins.build(
        "ComfyUI_windows_portable_nvidia.7z",
        "nvidia",
        _portable(),
        requires={"nvidia_driver": "580", "compute_capability": "7.5"},
    )
    older = pins.build(
        "ComfyUI_windows_portable_nvidia_cu126.7z",
        "nvidia",
        _portable([{"path": f"{ROOT}/cu126.txt", "attributes": "A", "data": "older"}]),
        build="older_drivers",
        requires={"nvidia_driver": "525"},
    )
    return usual, older


def _card(monkeypatch, vendor: str | None, driver: str | None = None, compute: str | None = None):
    """Answer the hardware probe with one card of this vendor, or none."""
    backend = {"nvidia": "cuda", "amd": "rocm", "intel": "xpu", "apple": "mps"}
    gpu = (
        None
        if vendor is None
        else probe.GPU(
            vendor=vendor,
            name=f"test {vendor} card",
            vram_gb=12.0,
            backend=backend[vendor],
            driver_version=driver,
            compute_capability=compute,
        )
    )
    profile = probe.HardwareProfile(
        os="windows",
        arch="AMD64",
        ram_gb=32.0,
        disk_free_gb=500.0,
        gpus=[gpu] if gpu else [],
        primary_gpu=gpu,
        tier=probe.Tier.A if gpu else probe.Tier.S,
    )
    monkeypatch.setattr(probe, "probe_hardware", lambda disk_path="/": profile)
    return gpu


def _device_check(monkeypatch, *, device: str | None = "Test GPU", reason: str | None = None):
    """Stands in for the build's own Python, which only Windows can run.
    Records what it was asked about."""
    asked: list[tuple[Path, str | None]] = []

    async def check(self, folder: Path, asset=None) -> dict:  # noqa: ANN001 - a pin
        asked.append((folder, asset.build if asset else None))
        assert (folder / "python_embeded" / "python.exe").is_file()
        if reason is not None:
            raise program_setup.SetupFailed(reason, "PyTorch finds no cuda device")
        return {"device": device}

    monkeypatch.setattr(program_setup.ComfyUIInstaller, "check", check)
    return asked


def _fake_server(monkeypatch, tmp_path: Path) -> None:
    """LocalCut's copy, when the engine starts it, is the stand-in server."""
    script = tmp_path / "fake_comfyui.py"
    script.write_text(FAKE_COMFYUI, encoding="utf-8")

    def argv(folder: Path, *, host: str, port: int, cpu: bool = False) -> list[str]:
        return [sys.executable, str(script), "--port", str(port)]

    monkeypatch.setattr(comfyui, "server_argv", argv)


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


# -- the pins --------------------------------------------------------------------


def test_comfyui_is_pinned_per_gpu_vendor_from_one_release():
    """Every number the setup screen shows is the release's own: one portable
    build per vendor from one tagged release, sizes and digests as GitHub
    publishes them and what each unpacks to as 7-Zip lists it. The usual
    NVIDIA build is CUDA 13, which needs a 580 driver and a Turing card or
    newer; the build for older drivers is CUDA 12.6, from 525."""
    pins = program_manifest.load_programs_manifest()
    pin = pins.program("comfyui")
    # Any release: the version is whichever scripts/pin-programs.py took.
    # Every URL below has to name it.
    assert pin is not None and re.fullmatch(r"\d+\.\d+\.\d+", pin.version)
    assert pin.license == "GPL-3.0-only"
    release = f"https://github.com/Comfy-Org/ComfyUI/releases/download/v{pin.version}/"
    # Linux's builds are made of pinned pieces (test_programs_comfyui_linux.py).
    portable = [asset for asset in pin.assets if asset.platform.startswith("windows")]
    names = {(asset.gpu, asset.build): asset.url.removeprefix(release) for asset in portable}
    assert names == {
        ("nvidia", None): "ComfyUI_windows_portable_nvidia.7z",
        ("nvidia", "older_drivers"): "ComfyUI_windows_portable_nvidia_cu126.7z",
        ("amd", None): "ComfyUI_windows_portable_amd.7z",
        ("intel", None): "ComfyUI_windows_portable_intel.7z",
    }
    for asset in portable:
        assert asset.platform == "windows-x64"
        assert asset.format == "7z" and asset.files == []
        assert asset.tree is not None and asset.tree.root == ROOT
        assert asset.size > 1_000_000_000 and asset.tree.bytes > asset.size
        assert re.fullmatch(r"[0-9a-f]{64}", asset.sha256)
        assert program_setup.INSTALLERS["comfyui"].fits(asset)
    usual = pin.asset_for("windows-x64", "nvidia")
    older = pin.asset_for("windows-x64", "nvidia", "older_drivers")
    assert usual.requires.model_dump() == {"nvidia_driver": "580", "compute_capability": "7.5"}
    assert older.requires.model_dump() == {"nvidia_driver": "525", "compute_capability": None}

    extractor = pins.extractor("7z", "windows-x64")
    assert extractor is not None
    assert re.fullmatch(
        r"https://github\.com/ip7z/7zip/releases/download/\d+\.\d+/7zr\.exe", extractor.url
    )
    assert extractor.license == "LGPL-2.1-or-later"
    # Every archive Python cannot read has its extractor on the same platform.
    for program in pins.programs:
        for asset in program.assets:
            if asset.format == "7z":
                assert pins.extractor("7z", asset.platform) is not None


def _document(**asset) -> str:
    base = {
        "platform": "windows-x64",
        "gpu": "nvidia",
        "url": "https://example.com/a.7z",
        "size": 1,
        "sha256": "0" * 64,
        "format": "7z",
        "tree": {"root": ROOT, "files": 1, "bytes": 1},
    }
    base.update(asset)
    base = {key: value for key, value in base.items() if value is not None}
    return json.dumps(
        {"schema_version": 1, "programs": [{"id": "comfyui", "version": "1", "assets": [base]}]}
    )


@pytest.mark.parametrize(
    "change",
    [
        # A tree and a list of files at once, or a tree from an archive
        # Python reads member by member.
        {"files": [{"member": "a/b", "path": "b", "size": 1}]},
        {"format": "zip"},
        # A 7z with nothing kept from it.
        {"tree": None},
        # A top folder that is a path, or climbs.
        {"tree": {"root": "a/b", "files": 1, "bytes": 1}},
        {"tree": {"root": "..", "files": 1, "bytes": 1}},
        # Builds and vendors no client could ask for or word.
        {"build": "newest"},
        {"gpu": "matrox"},
        # Another build with no usual build beside it.
        {"build": "older_drivers"},
        {"requires": {"nvidia_driver": "five eighty"}},
    ],
)
def test_a_pin_that_could_unpack_anything_else_is_refused(change):
    parse_programs_manifest(_document())
    with pytest.raises(ValueError):
        parse_programs_manifest(_document(**change))


# -- which build a machine gets -----------------------------------------------------


@pytest.mark.parametrize(
    ("vendor", "driver", "compute", "picked"),
    [
        ("nvidia", "581.57", "8.6", ("nvidia", None)),
        ("nvidia", "595.91.07", "12.0", ("nvidia", None)),
        # A driver older than CUDA 13 needs, or a card it has no kernels for.
        ("nvidia", "551.86", "8.6", ("nvidia", "older_drivers")),
        ("nvidia", "591.00", "6.1", ("nvidia", "older_drivers")),
        # What the probe could not read is taken as met; the setup's check
        # is what finds a build that cannot use the card.
        ("nvidia", None, None, ("nvidia", None)),
        # Older than either build supports: the usual one, which will say so.
        ("nvidia", "470.10", "8.6", ("nvidia", None)),
        ("amd", None, None, ("amd", None)),
        ("intel", None, None, ("intel", None)),
        ("apple", None, None, None),
        (None, None, None, None),
    ],
)
def test_the_card_picks_the_build(vendor, driver, compute, picked):
    pin = program_manifest.load_programs_manifest().program("comfyui")
    gpu = None
    if vendor is not None:
        gpu = probe.GPU(
            vendor=vendor,
            name="card",
            vram_gb=8,
            backend="cuda",
            driver_version=driver,
            compute_capability=compute,
        )
    asset = builds.choose(pin, "windows-x64", gpu)
    assert (None if asset is None else (asset.gpu, asset.build)) == picked
    # Linux has its own builds (test_programs_comfyui_linux.py) and macOS none.
    assert builds.choose(pin, "macos-arm64", gpu) is None


def test_another_build_is_only_one_pinned_for_the_cards_vendor():
    pin = program_manifest.load_programs_manifest().program("comfyui")
    nvidia = probe.GPU(vendor="nvidia", name="c", vram_gb=8, backend="cuda")
    amd = probe.GPU(vendor="amd", name="c", vram_gb=8, backend="rocm")
    chosen = builds.choose(pin, "windows-x64", nvidia, "older_drivers")
    assert (chosen.gpu, chosen.build) == ("nvidia", "older_drivers")
    assert builds.choose(pin, "windows-x64", amd, "older_drivers") is None
    assert [other.build for other in builds.others(pin, "windows-x64", chosen)] == [None]
    # Windows pins no build for the processor.
    assert builds.choose(pin, "windows-x64", amd, "cpu") is None
    assert set(BUILDS) == {"older_drivers", "cpu"}


# -- reading a 7z listing ------------------------------------------------------------

# What 7-Zip 26.04 printed for `l -slt -ba` of an archive it had written with
# `-mf=BCJ2 -snl`, a symlink in it: the shape every listing here is parsed in.
REAL_LISTING = textwrap.dedent(
    """\
    Path = Top
    Size = 0
    Packed Size = 0
    Modified = 2026-10-15 10:56:05.4120541
    Attributes = D drwxrwxr-x
    CRC =
    Encrypted = -
    Method =
    Block =

    Path = Top/a.txt
    Size = 3
    Packed Size = 34
    Modified = 2026-10-15 10:56:05.3915937
    Attributes = A -rw-rw-r--
    CRC = ED6F7A7A
    Encrypted = -
    Method = BCJ2 LZMA2:12 LZMA:12:lc0:lp2 LZMA:12:lc0:lp2
    Block = 0

    Path = Top\\sub\\b.bin
    Size = 4
    Packed Size =
    Modified = 2026-10-15 10:56:05.3915937
    Attributes = RA
    CRC = 1314C5B7
    Encrypted = -
    Method = BCJ2 LZMA2:12 LZMA:12:lc0:lp2 LZMA:12:lc0:lp2
    Block = 0
    """
)


def test_a_real_listing_is_read_as_7zip_writes_it():
    members = sevenzip.parse_listing(REAL_LISTING)
    assert [(m.path, m.size, m.folder) for m in members] == [
        ("Top", 0, True),
        ("Top/a.txt", 3, False),
        ("Top\\sub\\b.bin", 4, False),
    ]
    sevenzip.check_members(members, KeptTree(root="Top", files=2, bytes=7))
    with pytest.raises(sevenzip.ArchiveRefused, match="pin says 2 files of 8 bytes"):
        sevenzip.check_members(members, KeptTree(root="Top", files=2, bytes=8))
    with pytest.raises(sevenzip.ArchiveRefused, match="would land outside"):
        sevenzip.check_members(members, KeptTree(root="Other", files=2, bytes=7))


@pytest.mark.parametrize(
    ("block", "said"),
    [
        ("Path = Top/sub/link\nSize = 8\nAttributes = A lrwxrwxrwx\n", "is not a plain file"),
        ("Path = Top/junction\nSize = 0\nAttributes = DL\n", "link or a junction"),
        ("Path = Top/x\nSize = 1\nAttributes = A\nSymbolic Link = /etc/passwd\n", "is a link"),
        ("Path = Top/../escape.txt\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = ../escape.txt\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = /etc/cron.d/x\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = \\\\server\\share\\x\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = C:\\Windows\\x\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = Top/file.txt:hidden\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = Top//x\nSize = 1\nAttributes = A\n", "would land outside"),
        ("Path = Top/A.txt\nSize = 1\nAttributes = A\n", "twice"),
        ("Path = Top\nSize = 1\nAttributes = A\n", "where the top folder should be"),
    ],
)
def test_a_member_that_would_land_anywhere_else_refuses_the_archive(block, said):
    # The top folder's own entry is optional; 7-Zip lists one when the
    # archive holds it.
    listing = "Path = Top/a.txt\nSize = 1\nAttributes = A\n"
    tree = KeptTree(root="Top", files=2, bytes=2)
    with pytest.raises(sevenzip.ArchiveRefused, match=re.escape(said)):
        sevenzip.check_members(sevenzip.parse_listing(f"{listing}\n{block}"), tree)


def test_windows_long_paths_take_the_extended_form():
    assert sevenzip.extended(r"C:\Users\you\.localcut") == r"\\?\C:\Users\you\.localcut"
    assert sevenzip.extended(r"\\box\share\x") == r"\\?\UNC\box\share\x"
    assert sevenzip.extended(r"\\?\C:\x") == r"\\?\C:\x"
    here = Path("anything")
    assert sevenzip.long_path(here) == (
        here if os.name != "nt" else Path(sevenzip.extended(str(here.absolute())))
    )


def _link(target: Path, link: Path) -> None:
    """A link the walk must refuse: a symlink, or on Windows a junction,
    which needs no privilege to make."""
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target)


def test_what_was_unpacked_is_walked_without_following_anything(tmp_path):
    root = tmp_path / "Top"
    (root / "sub").mkdir(parents=True)
    (root / "a.txt").write_text("abc")
    (root / "sub" / "b.bin").write_bytes(b"defg")
    tree = KeptTree(root="Top", files=2, bytes=7)
    sevenzip.verify_tree(root, tree)
    (root / "sub" / "extra").write_text("!")
    with pytest.raises(sevenzip.ArchiveRefused, match="3 files of 8 bytes were unpacked"):
        sevenzip.verify_tree(root, tree)
    (root / "sub" / "extra").unlink()
    outside = tmp_path / "outside"
    outside.mkdir()
    _link(outside, root / "sub" / "elsewhere")
    with pytest.raises(sevenzip.ArchiveRefused, match="is a link"):
        sevenzip.verify_tree(root, tree)


def test_the_extractor_reports_its_percentage_and_stops_when_told(tmp_path, monkeypatch):
    script = tmp_path / "7zr.exe"
    script.write_text(FAKE_7Z, encoding="utf-8")
    monkeypatch.setattr(sevenzip, "command", lambda path: [sys.executable, str(path)])
    archive = tmp_path / "a.7z"
    archive.write_text(json.dumps(_portable()), encoding="utf-8")
    seen: list[int] = []
    sevenzip.extract(script, archive, tmp_path / "out", report=seen.append, stop=threading.Event())
    assert seen[-1] == 100 and seen == sorted(seen)
    assert (tmp_path / "out" / ROOT / "ComfyUI" / "main.py").is_file()
    assert not (tmp_path / "out" / "extractor-errors.txt").exists()

    archive.write_text(json.dumps(_portable(exit=2)), encoding="utf-8")
    with pytest.raises(sevenzip.ArchiveRefused, match="exit 2: ERROR: Data Error"):
        sevenzip.extract(
            script, archive, tmp_path / "again", report=seen.append, stop=threading.Event()
        )

    archive.write_text(json.dumps(_portable(pace_s=5)), encoding="utf-8")
    stop = threading.Event()
    threading.Timer(0.5, stop.set).start()
    with pytest.raises(sevenzip.Stopped):
        sevenzip.extract(script, archive, tmp_path / "stopped", report=seen.append, stop=stop)


# -- the model paths file and the command line ----------------------------------------


def test_the_model_paths_file_names_every_folder_the_templates_load_from(tmp_path):
    """ComfyUI finds the engine's weights through this file alone, so every
    folder a workflow template loads a model from has to be in it, with the
    engine's models folder as its base, quoted so no folder name can end the
    YAML string early."""
    models = tmp_path / "Zoë's #models"
    text = comfyui.model_paths_yaml(models)
    lines = text.splitlines()
    assert lines[0] == "localcut:"
    assert lines[1] == "  base_path: " + json.dumps(str(models.resolve()).replace("\\", "/"))
    assert [line.strip() for line in lines[2:]] == [
        f"{name}: {name}" for name in comfyui.MODEL_FOLDERS
    ]
    # What the templates load, as the manifest downloads it.
    loaders = {
        "CheckpointLoaderSimple": "checkpoints",
        "UNETLoader": "diffusion_models",
        "CLIPLoader": "text_encoders",
        "VAELoader": "vae",
    }
    wanted = set()
    for template in TEMPLATES.glob("*.json"):
        for node in json.loads(template.read_text(encoding="utf-8")).values():
            if isinstance(node, dict) and node.get("class_type") in loaders:
                wanted.add(loaders[node["class_type"]])
    entries = load_manifest(EngineConfig(data_dir=tmp_path / "data")).models
    for entry in entries:
        if entry.comfy_graph_template:
            wanted |= {file.dest.split("/")[0] for file in entry.files}
    assert wanted and wanted <= set(comfyui.MODEL_FOLDERS)

    copy = tmp_path / "comfyui"
    copy.mkdir()
    written = comfyui.write_model_paths(copy, models)
    assert written.read_text(encoding="utf-8") == text
    stamp = written.stat().st_mtime_ns
    comfyui.write_model_paths(copy, models)
    assert written.stat().st_mtime_ns == stamp


def test_the_copy_starts_the_way_its_own_launch_script_does(tmp_path):
    """run_nvidia_gpu.bat's line, plus the address, the model paths file and
    no browser: the standalone build opens one otherwise."""
    folder = tmp_path / "comfyui"
    (folder / "python_embeded").mkdir(parents=True)
    (folder / "python_embeded" / "python.exe").write_bytes(b"MZ")
    argv = comfyui.server_argv(folder, host="127.0.0.1", port=8190)
    assert argv[:4] == [
        str(folder / "python_embeded" / "python.exe"),
        "-s",
        str(folder / "ComfyUI" / "main.py"),
        "--windows-standalone-build",
    ]
    assert argv[4:] == [
        "--disable-auto-launch",
        "--listen",
        "127.0.0.1",
        "--port",
        "8190",
        "--extra-model-paths-config",
        str(folder / "extra_model_paths.yaml"),
    ]
    assert comfyui.server_argv(folder, host="127.0.0.1", port=8190, cpu=True)[-1] == "--cpu"


@pytest.mark.parametrize(
    ("url", "address"),
    [
        ("http://127.0.0.1:8188", ("127.0.0.1", 8188)),
        ("http://localhost:8000/", ("127.0.0.1", 8000)),
        ("http://[::1]:8188", ("::1", 8188)),
        ("http://gpu-box.invalid:8188", None),
        ("http://192.168.1.20:8188", None),
        ("https://127.0.0.1:8188", None),
        ("http://127.0.0.1:8188/comfy", None),
    ],
)
def test_only_an_address_on_this_machine_can_be_served_by_its_own_copy(url, address):
    assert comfyui.local_address(url) == address


async def test_only_comfyui_answering_is_taken_for_comfyui(tmp_path):
    script = tmp_path / "fake_comfyui.py"
    script.write_text(FAKE_COMFYUI, encoding="utf-8")
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    assert await comfyui.identify(url) is None
    process = subprocess.Popen(
        [sys.executable, str(script), "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Printed once the port is bound: it answers from here on.
        if process.stdout.readline().strip() != b"listening":
            process.kill()
            raise AssertionError(f"the stand-in did not start: {process.stderr.read()!r}")
        assert await comfyui.identify(url) == "self"
        # Something else that answers HTTP there.
        assert await comfyui.identify(f"{url}/nothing-here") == "other"
    finally:
        process.kill()
        process.wait()


# -- the device check -------------------------------------------------------------------

FAKE_TORCH = textwrap.dedent(
    """\
    import os
    __version__ = "2.14.0+cu130"
    if os.environ.get("FAKE_TORCH_BROKEN"):
        raise ImportError("DLL load failed while importing _C")
    class _Device:
        def __init__(self, kind):
            self.kind = kind
        def is_available(self):
            return os.environ.get("FAKE_TORCH_DEVICE") == self.kind
        def get_device_name(self, index):
            return "NVIDIA GeForce RTX 4070" if self.kind == "cuda" else "Intel(R) Arc(TM) A770"
    cuda = _Device("cuda")
    xpu = _Device("xpu")
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
        return _Ones(n)
    """
)


@pytest.mark.parametrize(
    ("vendor", "device", "broken", "outcome"),
    [
        ("nvidia", "cuda", False, {"device": "NVIDIA GeForce RTX 4070"}),
        ("intel", "xpu", False, {"device": "Intel(R) Arc(TM) A770"}),
        ("nvidia", "", False, "gpu_not_usable"),
        ("intel", "cuda", False, "gpu_not_usable"),
        ("nvidia", "cuda", True, "does_not_run"),
    ],
)
async def test_the_builds_own_python_has_to_use_the_card(
    tmp_path, monkeypatch, vendor, device, broken, outcome
):
    """The check runs the unpacked build's own Python, which has to import
    its PyTorch and sum a few numbers on the vendor's device. Here the
    Python is this one and PyTorch a stand-in, since the build's own runs
    only on Windows."""
    site = tmp_path / "site"
    (site / "torch").mkdir(parents=True)
    (site / "torch" / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")
    # The folder is a portable build's, whose Python honours PYTHONPATH.
    (tmp_path / "python_embeded").mkdir()
    (tmp_path / "python_embeded" / "python.exe").write_bytes(b"MZ")
    monkeypatch.setenv("PYTHONPATH", str(site))
    monkeypatch.setenv("FAKE_TORCH_DEVICE", device)
    if broken:
        monkeypatch.setenv("FAKE_TORCH_BROKEN", "1")
    monkeypatch.setattr(comfyui, "python_of", lambda folder: Path(sys.executable))
    asset = program_manifest.load_programs_manifest().asset("comfyui", "windows-x64", vendor)
    installer = program_setup.ComfyUIInstaller()
    if isinstance(outcome, dict):
        assert await installer.check(tmp_path, asset) == outcome
        return
    with pytest.raises(program_setup.SetupFailed) as failed:
        await installer.check(tmp_path, asset)
    assert failed.value.reason == outcome


# -- a setup, end to end -------------------------------------------------------------


def _record(folder: Path) -> dict:
    return json.loads((folder / "program.json").read_text(encoding="utf-8"))


async def test_setup_downloads_the_extractor_with_the_build_and_unpacks_the_whole_tree(
    tmp_path, monkeypatch, archives
):
    """The click fetches 7-Zip's extractor first and then the build for the
    card, both held to their pins; the extractor lists the archive, the
    listing is checked, the tree is unpacked and walked; the build's Python
    is asked whether it can use the card; then the folder is moved into
    place whole and started, pointed at the engine's models. The extractor
    and the archive are gone afterwards and the report's sizes are the
    ones the setup recorded."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    usual, older = _usual_and_older(pins)
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    asked = _device_check(monkeypatch)
    _fake_server(monkeypatch, tmp_path)
    port = free_port()
    data = tmp_path / "data"

    async with _engine(_config(data, port)) as http:
        before = _row((await http.get("/programs")).json(), "comfyui")
        setup = before["setup"]
        assert (setup["available"], setup["takes_effect"]) == (True, True)
        assert (setup["gpu"], setup["build"]) == ("nvidia", None)
        assert setup["download_bytes"] == usual["size"] + pins.extractor["size"]
        assert setup["install_bytes"] == usual["tree"]["bytes"]
        assert setup["builds"] == [
            {
                "build": "older_drivers",
                "download_bytes": older["size"] + pins.extractor["size"],
                "install_bytes": older["tree"]["bytes"],
            }
        ]

        started = await http.post("/programs/comfyui/setup")
        assert started.json()["status"] == "started"
        row = await _settled(http, "comfyui")
        assert row["setup"]["last"]["outcome"] == "done", row["setup"]["last"]
        assert row["setup"]["last"]["build"] is None
        # The report asks the address with a two-second timeout, and a busy
        # runner can miss one answer; the copy itself answered before the
        # setup said done, and is never restarted here.
        async with asyncio.timeout(30):
            while row["state"] != "ready":
                await asyncio.sleep(0.2)
                row = _row((await http.get("/programs")).json(), "comfyui")
        assert (row["state"], row["source"], row["version"]) == ("ready", "managed", "0.40.0")
        managed = row["managed"]
        assert managed["server"]["state"] == "running"
        assert managed["server"]["restarts"] == 0
        assert (managed["in_use"], managed["current"], managed["build"]) == (True, True, None)
        assert row["setup"]["available"]

    requests = [path.rsplit("/", 1)[-1] for path in archives.requests]
    assert requests == ["7zr.exe", "ComfyUI_windows_portable_nvidia.7z"]
    assert pins.commands() == ["l", "x"]
    assert [build for _, build in asked] == [None]
    folder = data / "programs" / "comfyui"
    assert (folder / "ComfyUI" / "main.py").read_text() == "print('comfy')\n"
    assert not (folder / "cu126.txt").exists()
    record = _record(folder)
    assert (record["gpu"], record["build"], record["sha256"]) == ("nvidia", None, usual["sha256"])
    on_disk = sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())
    # The model paths file came with the first start, after the record.
    paths_file = folder / "extra_model_paths.yaml"
    assert paths_file.read_text() == comfyui.model_paths_yaml(data / "models")
    assert record["bytes"] == on_disk - paths_file.stat().st_size
    assert managed["bytes"] == record["bytes"]
    assert sorted(entry.name for entry in (data / "programs").iterdir()) == ["comfyui"]


async def test_a_card_on_an_older_driver_gets_the_build_for_it(tmp_path, monkeypatch, archives):
    """The probe's driver picks the build for older drivers by itself and
    a copy of that build stays that build: a later setup does not move it
    back to the usual one and is not reported as out of date."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    _usual_and_older(pins)
    _card(monkeypatch, "nvidia", "551.86", "8.6")
    _device_check(monkeypatch)
    _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"

    async with _engine(_config(data, free_port())) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["gpu"], setup["build"]) == ("nvidia", "older_drivers")
        assert [other["build"] for other in setup["builds"]] == [None]
        await http.post("/programs/comfyui/setup")
        row = await _settled(http, "comfyui")
        assert row["setup"]["last"]["outcome"] == "done"
        assert row["managed"]["build"] == "older_drivers"
        assert row["managed"]["current"] is True
        again = await http.post("/programs/comfyui/setup")
        assert again.json() == {"status": "installed"}
    assert (data / "programs" / "comfyui" / "cu126.txt").read_text() == "older"


async def test_after_the_usual_build_cannot_use_the_card_the_other_can_be_asked_for(
    tmp_path, monkeypatch, archives
):
    """The usual build's PyTorch cannot use the card: the setup fails with
    gpu_not_usable, keeps nothing and the report offers the vendor's other
    build, which a client asks for by name. A name that is not a build, or
    a build not pinned for this card, is refused."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    _usual_and_older(pins)
    _card(monkeypatch, "nvidia", None, None)
    _device_check(monkeypatch, reason="gpu_not_usable")
    _fake_server(monkeypatch, tmp_path)
    data = tmp_path / "data"

    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        row = await _settled(http, "comfyui")
        last = row["setup"]["last"]
        assert (last["outcome"], last["reason"], last["build"]) == (
            "failed",
            "gpu_not_usable",
            None,
        )
        assert row["managed"] is None
        assert [other["build"] for other in row["setup"]["builds"]] == ["older_drivers"]
        assert not [p for p in (data / "programs").iterdir()]

        _device_check(monkeypatch)
        assert (await http.post("/programs/comfyui/setup?build=newest")).status_code == 422
        started = await http.post("/programs/comfyui/setup?build=older_drivers")
        assert started.json()["status"] == "started"
        job = _row((await http.get("/programs")).json(), "comfyui")["setup"]["job"]
        assert job is None or job["build"] == "older_drivers"
        row = await _settled(http, "comfyui")
        assert (row["setup"]["last"]["outcome"], row["setup"]["last"]["build"]) == (
            "done",
            "older_drivers",
        )

    _card(monkeypatch, "amd")
    pins.build("ComfyUI_windows_portable_amd.7z", "amd", _portable())
    async with _engine(_config(tmp_path / "amd", free_port())) as http:
        refused = await http.post("/programs/comfyui/setup?build=older_drivers")
        assert refused.status_code == 409
        assert "older_drivers" in refused.json()["detail"]


@pytest.mark.parametrize(
    ("member", "said"),
    [
        ({"path": f"{ROOT}/../evil.txt", "attributes": "A", "data": "x"}, "would land outside"),
        ({"path": "elsewhere/evil.txt", "attributes": "A", "data": "x"}, "would land outside"),
        ({"path": f"{ROOT}/link", "attributes": "A lrwxrwxrwx", "data": "/"}, "plain file"),
    ],
)
async def test_an_archive_that_would_write_outside_its_folder_is_never_extracted(
    tmp_path, monkeypatch, archives, member, said
):
    pins = _Pins(monkeypatch, archives, tmp_path)
    archive = _portable([member])
    tree = _tree_of(archive)
    pins.build("ComfyUI_windows_portable_nvidia.7z", "nvidia", archive, tree=tree)
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    _device_check(monkeypatch)
    data = tmp_path / "data"

    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        last = (await _settled(http, "comfyui"))["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "unpack_failed")
    assert said in last["error"]
    assert pins.commands() == ["l"]
    assert not (data / "programs" / "evil.txt").exists()
    assert sorted(path.name for path in (data / "programs").iterdir()) == []


async def test_a_tree_that_is_not_the_pins_is_refused_after_the_unpack(
    tmp_path, monkeypatch, archives
):
    """A listing that agrees with the pin and an unpack that writes more
    than it listed: the walk counts what is there and refuses it."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    pins.build(
        "ComfyUI_windows_portable_nvidia.7z",
        "nvidia",
        _portable(extra_writes={f"{ROOT}/unlisted.dll": "!"}),
    )
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    _device_check(monkeypatch)
    data = tmp_path / "data"
    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        last = (await _settled(http, "comfyui"))["setup"]["last"]
    assert (last["outcome"], last["reason"]) == ("failed", "unpack_failed")
    assert "were unpacked" in last["error"]
    assert not (data / "programs" / "comfyui").exists()


async def test_cancel_stops_the_extractor_partway_and_removes_what_it_wrote(
    tmp_path, monkeypatch, archives
):
    pins = _Pins(monkeypatch, archives, tmp_path)
    pins.build("ComfyUI_windows_portable_nvidia.7z", "nvidia", _portable(pace_s=2))
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    _device_check(monkeypatch)
    data = tmp_path / "data"
    async with _engine(_config(data, free_port())) as http:
        await http.post("/programs/comfyui/setup")
        async with asyncio.timeout(60):
            while True:
                job = _row((await http.get("/programs")).json(), "comfyui")["setup"]["job"]
                if job and job["phase"] == "unpacking" and job["done"] > 0:
                    break
                await asyncio.sleep(0.05)
        assert job["total"] == pins.assets[0]["tree"]["bytes"]
        assert (await http.delete("/programs/comfyui/setup")).status_code == 200
        last = (await _settled(http, "comfyui"))["setup"]["last"]
    assert last["outcome"] == "cancelled"
    assert not [p for p in (data / "programs").iterdir()]


async def test_no_card_a_build_is_pinned_for_means_no_setup(tmp_path, monkeypatch, archives):
    """Builds are per vendor; with no card from one of them there is nothing
    to set up and a remote address is never served by a copy here."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    _usual_and_older(pins)
    _card(monkeypatch, None)
    async with _engine(_config(tmp_path / "data", free_port())) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["available"], setup["unavailable_reason"]) == (False, "gpu_not_supported")
        assert setup["download_bytes"] is None and setup["builds"] == []
        assert "gpu_not_supported" in SETUP_UNAVAILABLE
        assert (await http.post("/programs/comfyui/setup")).status_code == 409

    _card(monkeypatch, "nvidia", "581.57", "8.6")
    remote = _config(tmp_path / "remote", free_port(), comfyui_url="http://gpu-box.invalid:8188")
    async with _engine(remote) as http:
        setup = _row((await http.get("/programs")).json(), "comfyui")["setup"]
        assert (setup["available"], setup["takes_effect"]) == (True, False)


async def test_the_report_reads_a_copys_size_from_its_record(tmp_path, monkeypatch, archives):
    """A ComfyUI copy is tens of thousands of files and GET /programs is
    asked every few seconds: the size is the figure the setup recorded and
    nothing walks the folder to find it."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    usual, _ = _usual_and_older(pins)
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    data = tmp_path / "data"
    folder = data / "programs" / "comfyui"
    (folder / "python_embeded").mkdir(parents=True)
    record = {
        "format": 1,
        "program": "comfyui",
        "version": "0.40.0",
        "platform": "windows-x64",
        "gpu": "nvidia",
        "build": None,
        "url": usual["url"],
        "sha256": usual["sha256"],
        "files": {},
        "bytes": 4_421_749_000,
    }
    (folder / "program.json").write_text(json.dumps(record))

    def no_walks(path):  # noqa: ANN001
        raise AssertionError(f"GET /programs walked {path}")

    monkeypatch.setattr(program_setup.storage, "_dir_size", no_walks)
    remote = _config(data, free_port(), comfyui_url="http://gpu-box.invalid:8188")
    async with _engine(remote) as http:
        report = (await http.get("/programs")).json()
    assert report["programs_bytes"] == 4_421_749_000
    managed = _row(report, "comfyui")["managed"]
    assert (managed["bytes"], managed["current"], managed["version"]) == (
        4_421_749_000,
        True,
        "0.40.0",
    )


# -- the readiness report ------------------------------------------------------------


async def test_a_comfyui_that_is_down_offers_localcuts_own(tmp_path, monkeypatch):
    """Where LocalCut's copy would be the ComfyUI renders use, each
    `comfyui_down` row carries the setup, with the download's size; for an
    address on another machine, or a card no build is for, it carries none."""
    monkeypatch.setattr(program_manifest, "platform_key", lambda: "windows-x64")
    # Nothing answers anywhere, without waiting on a connect to find out.
    monkeypatch.setattr(readiness, "_comfy_alive", lambda config: False)
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    usual = program_manifest.load_programs_manifest().asset("comfyui", "windows-x64", "nvidia")
    extractor = program_manifest.load_programs_manifest().extractor("7z", "windows-x64")

    async def down_rows(config: EngineConfig) -> list[dict]:
        probe.machine_profile(str(config.data_dir))
        from localcut_engine.api.app import _build_backends
        from localcut_engine.graph.model import NodeKind

        rows = await readiness_rows(
            config, _build_backends(config), [(NodeKind.KEYFRAME, None), (NodeKind.MUSIC, None)]
        )
        return [row for row in rows if row["reason"] == "comfyui_down"]

    base = {"backend": "comfy,mock", "comfy_kinds": "keyframe,thumbnail,clip,music"}
    local = _config(tmp_path / "local", free_port(), **base)
    rows = await down_rows(local)
    assert rows and all(
        row["fix"]
        == {
            "type": "setup_program",
            "program": "comfyui",
            "size_bytes": usual.size + extractor.size,
        }
        for row in rows
    )

    remote = _config(tmp_path / "remote", 1, **base).model_copy(
        update={"comfyui_url": "http://192.0.2.1:8188"}
    )
    assert [row["fix"] for row in await down_rows(remote)] == [None, None]
    _card(monkeypatch, None)
    assert [row["fix"] for row in await down_rows(_config(tmp_path / "bare", 1, **base))] == [
        None,
        None,
    ]


# -- from a terminal -------------------------------------------------------------------


def test_the_cli_sets_comfyui_up_and_can_ask_for_the_other_build(
    tmp_path, monkeypatch, archives, capsys
):
    """`localcut programs setup comfyui` waits through the unpack like the
    download, says which build `list` would fetch and after the usual build
    could not use the card names the command that fetches the other one."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    _usual_and_older(pins)
    _card(monkeypatch, "nvidia", None, None)
    _device_check(monkeypatch, reason="gpu_not_usable")
    # The copy is set up and not started: serve_engine runs uvicorn on a
    # worker thread, where uvloop never hears that a child process exited,
    # so the engine could not wait for its ComfyUI to stop. The start is
    # covered through the API above.
    monkeypatch.setattr(program_setup.ComfyUIInstaller, "takes_effect", lambda self, c: False)
    monkeypatch.setattr(cli, "_SETUP_POLL_S", 0.05)
    port = free_port()

    with serve_engine(
        tmp_path / "engine", TOKEN, backend="ffmpeg,mock", comfyui_url=f"http://127.0.0.1:{port}"
    ) as url:

        def run(*args: str) -> int:
            return cli.main(["programs", *args, "--engine", url, "--token", TOKEN])

        assert run("list") == 0
        listed = capsys.readouterr().out
        assert "downloads" in listed and "the build for NVIDIA cards" in listed, listed

        assert run("setup", "comfyui") == 1
        assert "gpu_not_usable" in capsys.readouterr().err
        assert run("list") == 0
        listed = capsys.readouterr().out
        assert "--build older_drivers` downloads" in listed, listed

        _device_check(monkeypatch)
        assert run("setup", "comfyui", "--build", "older_drivers") == 0
        assert "comfyui is set up" in capsys.readouterr().out
    record = _record(tmp_path / "engine" / "programs" / "comfyui")
    assert record["build"] == "older_drivers"
    with pytest.raises(SystemExit):
        cli.main(["programs", "setup", "comfyui", "--build", "newest", "--engine", url])


# -- deleting a tree -------------------------------------------------------------------


def test_a_tree_is_deleted_through_read_only_files_and_never_through_a_link(tmp_path):
    """7-Zip writes the read-only flags an archive holds and Windows will not
    delete a read-only file; a link inside is removed, never followed."""
    tree = tmp_path / ".setup-comfyui-0"
    (tree / "python_embeded" / "Lib").mkdir(parents=True)
    locked = tree / "python_embeded" / "Lib" / "readonly.pyd"
    locked.write_bytes(b"x")
    locked.chmod(0o444)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    _link(outside, tree / "python_embeded" / "elsewhere")
    program_setup._remove_tree(tree)
    assert not tree.exists()
    assert (outside / "keep.txt").read_text() == "keep"


def test_a_deletion_stops_between_files_when_the_engine_does(tmp_path):
    tree = tmp_path / ".setup-comfyui-1"
    (tree / "a").mkdir(parents=True)
    for index in range(20):
        (tree / "a" / f"{index}.dll").write_bytes(b"x")
    stop = threading.Event()
    stop.set()
    program_setup._remove_tree(tree, stop)
    assert len(list((tree / "a").iterdir())) == 20
    program_setup._remove_tree(tree)
    assert not tree.exists()


async def test_quitting_mid_unpack_leaves_the_scratch_folder_to_the_next_start(
    tmp_path, monkeypatch, archives
):
    """The desktop gives the engine a few seconds to stop. A half-unpacked
    ComfyUI is tens of thousands of files, so a quit during the unpack stops
    the extractor and exits without deleting them; the next start's sweep
    deletes them while the engine serves."""
    pins = _Pins(monkeypatch, archives, tmp_path)
    pins.build("ComfyUI_windows_portable_nvidia.7z", "nvidia", _portable(pace_s=2))
    _card(monkeypatch, "nvidia", "581.57", "8.6")
    _device_check(monkeypatch)
    data = tmp_path / "data"
    slow = threading.Event()
    real_remove = program_setup._remove_tree

    def remove(path, stop=None):  # noqa: ANN001 - a Path and an Event
        # A deletion that would take minutes, unless it is told to stop.
        if stop is not None and stop.wait(30):
            return
        slow.set()
        real_remove(path, stop)

    monkeypatch.setattr(program_setup, "_remove_tree", remove)
    config = _config(data, free_port())
    async with _engine(config) as http:
        await http.post("/programs/comfyui/setup")
        async with asyncio.timeout(60):
            while True:
                job = _row((await http.get("/programs")).json(), "comfyui")["setup"]["job"]
                if job and job["phase"] == "unpacking" and job["done"] > 0:
                    break
                await asyncio.sleep(0.05)
        quit_began = time.monotonic()
    assert time.monotonic() - quit_began < 5
    assert not slow.is_set()
    left = [entry.name for entry in (data / "programs").iterdir()]
    assert len(left) == 1 and left[0].startswith(".setup-comfyui-")

    monkeypatch.setattr(program_setup, "_remove_tree", real_remove)
    async with _engine(config):
        async with asyncio.timeout(30):
            while any((data / "programs").iterdir()):
                await asyncio.sleep(0.05)


async def test_quitting_while_leftovers_are_deleted_does_not_wait_for_them(tmp_path, monkeypatch):
    """What an interrupted setup left is deleted while the engine serves. A
    quit during that deletion stops it between files and exits; the next
    start carries on with it."""
    data = tmp_path / "data"
    leftover = data / "programs" / ".setup-comfyui-0123456789ab"
    (leftover / "python_embeded").mkdir(parents=True)
    (leftover / "python_embeded" / "python.exe").write_bytes(b"MZ")
    real_remove = program_setup._remove_tree
    began = threading.Event()

    def remove(path, stop=None):  # noqa: ANN001 - a Path and an Event
        began.set()
        # A deletion that would take minutes, unless it is told to stop.
        if stop is not None and stop.wait(30):
            return
        real_remove(path, stop)

    monkeypatch.setattr(program_setup, "_remove_tree", remove)
    config = _config(data, free_port())
    async with _engine(config):
        async with asyncio.timeout(10):
            while not began.is_set():
                await asyncio.sleep(0.02)
        quit_began = time.monotonic()
    assert time.monotonic() - quit_began < 5
    assert leftover.exists()

    monkeypatch.setattr(program_setup, "_remove_tree", real_remove)
    async with _engine(config):
        async with asyncio.timeout(30):
            while leftover.exists():
                await asyncio.sleep(0.05)
