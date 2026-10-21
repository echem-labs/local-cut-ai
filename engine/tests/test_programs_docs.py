"""docs/programs.md against the pins it describes.

The page states each pinned program's version, what it downloads and what
it unpacks to, in prose, in a table and in the JSON examples of GET
/programs and its events. scripts/pin-programs.py moves those figures with
the pin. This holds every one of them to programs-manifest.json and the
Linux locks, so a pin moved any other way, or a sentence edited out of step
with the pin, fails here rather than drifting.

Scoped to what the page states as the pin. Two sentences name the Ollama
version whose source a behaviour was read from (the CUDA floors and the
calls to ollama.com). Those are claims a person checks again on a bump, as
programs/ollama.py's comments are, not figures that move with the pin. They
are not read here. Nor is the 105 MB the first start adds, which was
measured on a GPU machine.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import (
    REPO_ROOT,
    ci_engine_paths_by_trigger,
    hook_files_pattern,
    matches_a_path_filter,
)

from localcut_engine.programs import environment
from localcut_engine.programs import manifest as program_manifest
from localcut_engine.programs import setup as program_setup
from localcut_engine.programs.manifest import ProgramAsset, ProgramPin

DOC = REPO_ROOT / "docs" / "programs.md"


def _pins():
    return program_manifest.load_programs_manifest()


def _asset(program: str, platform: str, gpu: str | None = None, build: str | None = None):
    pin = _pins().program(program)
    assert pin is not None
    found = [a for a in pin.assets if (a.platform, a.gpu, a.build) == (platform, gpu, build)]
    assert len(found) == 1, f"{program} pins {len(found)} builds for {platform} {gpu} {build}"
    return found[0]


def _gib(value: int, places: int = 2) -> str:
    return f"{value / 2**30:.{places}f}"


def _recorded_bytes(program: str, asset: ProgramAsset, folder: Path) -> int:
    """The size a copy of this build reports: its files and the record the
    engine writes beside them."""
    pin = _pins().program(program)
    assert pin is not None
    one = ProgramPin(id=pin.id, version=pin.version, license=pin.license, assets=[asset])
    folder.mkdir(parents=True, exist_ok=True)
    program_setup._write_record(folder, one, asset)
    return json.loads((folder / program_setup.RECORD).read_text(encoding="utf-8"))["bytes"]


def _torch(asset: ProgramAsset) -> str:
    lock = environment.load_lock(asset.environment)
    return next(w.version for w in lock.wheels if w.name == "torch").split("+")[0]


# -- what the page says ------------------------------------------------------------------


def _stated(text: str, pattern: str, what: str, problems: list[str]) -> tuple[str, ...] | None:
    """The groups of the one place `pattern` matches, or None with a problem
    noted when there is not exactly one. A sentence reworded so the pattern
    no longer finds it is reported, not skipped."""
    found = [match.groups() for match in re.finditer(pattern, text)]
    if len(found) != 1:
        problems.append(f"{what}: {len(found)} places in the page match {pattern!r}")
        return None
    return found[0]


def _check(text: str, pattern: str, what: str, wanted: tuple, problems: list[str]) -> None:
    said = _stated(text, pattern, what, problems)
    if said is not None and said != tuple(wanted):
        problems.append(f"{what}: the page says {said}, the pin {tuple(wanted)}")


def prose_problems(text: str, tmp: Path) -> list[str]:
    problems: list[str] = []
    version = r"(\d+(?:\.\d+)+)"
    number = r"([\d,]+)"

    ffmpeg = _pins().program("ffmpeg")
    linux = _asset("ffmpeg", "linux-x64")
    top = linux.files[0].member.split("/")[0]
    describe = top.removeprefix("ffmpeg-").rsplit("-linux64-lgpl-", 1)[0]
    _check(
        text,
        rf"`{version}` for FFmpeg's\s+`(n[^`]+)`",
        "FFmpeg's version and the build it is read from",
        (ffmpeg.version, describe),
        problems,
    )

    ollama = _pins().program("ollama")
    windows, linux = _asset("ollama", "windows-x64"), _asset("ollama", "linux-x64")
    _check(
        text,
        rf"\[Ollama's own releases\]\([^)]*\), version\s+{version}\.",
        "Ollama's version",
        (ollama.version,),
        problems,
    )
    _check(
        text,
        r"`ollama-windows-amd64\.zip` on Windows \((\d+\.\d\d) GiB,\s+(\d+\.\d\d) GiB unpacked\)",
        "Ollama's Windows download and unpacked size",
        (_gib(windows.size), _gib(windows.install_bytes)),
        problems,
    )
    _check(
        text,
        r"`ollama-linux-amd64\.tar\.zst` on Linux \((\d+\.\d\d) GiB,\s+(\d+\.\d\d) GiB unpacked\)",
        "Ollama's Linux download and unpacked size",
        (_gib(linux.size), _gib(linux.install_bytes)),
        problems,
    )
    _check(
        text,
        r"On Linux that includes the (\d+) links",
        "the links Ollama's Linux build keeps",
        (str(sum(1 for kept in linux.files if kept.link)),),
        problems,
    )

    comfy = _pins().program("comfyui")
    usual = _asset("comfyui", "windows-x64", "nvidia")
    others = [a.tree.bytes for a in comfy.assets if a.platform == "windows-x64" and a is not usual]
    extractor = _pins().extractor("7z", "windows-x64")
    _check(
        text,
        rf"\[Comfy-Org/ComfyUI's releases\]\([^)]*\),\s+version {version}, pinned",
        "ComfyUI's version on Windows",
        (comfy.version,),
        problems,
    )
    _check(
        text,
        rf"`7zr\.exe` {version}\s+\(([^)]+)\)",
        "the extractor's version and licence",
        (extractor.version, extractor.license),
        problems,
    )
    _check(
        text,
        rf"The copy is the whole portable folder: {number} files and about (\d+\.\d) GiB for\s+"
        r"NVIDIA's usual build, (\d+\.\d\d) to (\d+\.\d\d) GiB for the others\.",
        "what the portable builds unpack to",
        (
            f"{usual.tree.files:,}",
            _gib(usual.tree.bytes, 1),
            _gib(min(others)),
            _gib(max(others)),
        ),
        problems,
    )
    _check(
        text,
        rf"Those are ComfyUI {version}'s own flags\.",
        "the ComfyUI whose flags the launch uses",
        (comfy.version,),
        problems,
    )

    runtime = _pins().runtime("cpython", "linux-x64")
    source = _asset("comfyui", "linux-x64", "nvidia")
    _check(
        text,
        rf"a standalone CPython, {version} from",
        "the Python ComfyUI runs on, on Linux",
        (runtime.version,),
        problems,
    )
    _check(
        text,
        rf"\(its `install_only_stripped` build, {number} bytes\)",
        "the Python's download",
        (f"{runtime.size:,}",),
        problems,
    )
    _check(
        text,
        rf"ComfyUI's source at the v{version} tag, as GitHub's archive of the tag\s+"
        rf"\({number} bytes\)",
        "ComfyUI's source archive",
        (comfy.version, f"{source.size:,}"),
        problems,
    )
    linux_builds = [a for a in comfy.assets if a.platform == "linux-x64"]
    torches = sorted({_torch(a) for a in linux_builds})
    _check(
        text,
        rf"Every build has PyTorch {version}:",
        "the PyTorch every Linux build has",
        (",".join(torches),),
        problems,
    )
    for asset in linux_builds:
        lock = asset.environment.lock.removeprefix("pylock.comfyui-").removesuffix(".toml")
        _check(
            text,
            rf"\| `{re.escape(lock)}`[^|\n]*\|[^|\n]*\| (\d+) \| {number} \| {number} \| "
            rf"{number} \|",
            f"the {lock} row of the Linux table",
            (
                str(asset.environment.wheels),
                f"{program_setup.download_bytes(asset):,}",
                f"{asset.environment.bytes:,}",
                f"{asset.environment.files:,}",
            ),
            problems,
        )
    return problems


def json_examples(text: str) -> dict[str, object]:
    """The JSON examples about the pins: `report` (GET /programs on Linux),
    `windows` (ComfyUI's setup on Windows) and `events` (one per line)."""
    found: dict[str, object] = {}
    for match in re.finditer(r"```json\n(.*?)```", text, re.S):
        body = match.group(1)
        try:
            parsed = json.loads(body)
        except ValueError:
            found["events"] = [json.loads(line) for line in body.splitlines() if line.strip()]
            continue
        if isinstance(parsed, dict) and "programs" in parsed:
            found["report"] = parsed
        elif isinstance(parsed, dict) and str(parsed.get("url", "")).endswith(".7z"):
            found["windows"] = parsed
    return found


def example_problems(text: str, tmp: Path) -> list[str]:
    problems: list[str] = []
    examples = json_examples(text)
    for kind in ("report", "windows", "events"):
        if kind not in examples:
            problems.append(f"the page has no {kind} example")
    if problems:
        return problems

    def compare(what: str, said: object, pinned: object) -> None:
        if said != pinned:
            problems.append(f"{what}: the page says {said!r}, the pin {pinned!r}")

    pins = _pins()
    ffmpeg_linux = _asset("ffmpeg", "linux-x64")
    ollama_linux = _asset("ollama", "linux-x64")
    ffmpeg_bytes = _recorded_bytes("ffmpeg", ffmpeg_linux, tmp / "ffmpeg")
    ollama_bytes = _recorded_bytes("ollama", ollama_linux, tmp / "ollama")

    report = examples["report"]
    rows = {row["id"]: row for row in report["programs"]}
    compare(
        "programs_bytes, every copy the report shows",
        report["programs_bytes"],
        sum(row["managed"]["bytes"] for row in rows.values() if row.get("managed")),
    )
    for program, asset, recorded in (
        ("ffmpeg", ffmpeg_linux, ffmpeg_bytes),
        ("ollama", ollama_linux, ollama_bytes),
    ):
        row, version = rows[program], pins.program(program).version
        compare(f"{program}'s version", row["version"], version)
        compare(f"{program}'s managed.version", row["managed"]["version"], version)
        compare(f"{program}'s managed.bytes", row["managed"]["bytes"], recorded)
        compare(f"{program}'s setup.version", row["setup"]["version"], version)
        compare(
            f"{program}'s setup.download_bytes",
            row["setup"]["download_bytes"],
            program_setup.download_bytes(asset),
        )
        compare(
            f"{program}'s setup.install_bytes", row["setup"]["install_bytes"], asset.install_bytes
        )
        url = row["setup"]["url"]
        if url.endswith("..."):
            if not asset.url.startswith(url.removesuffix("...")):
                problems.append(f"{program}'s setup.url {url!r} is not where the pin is")
        else:
            compare(f"{program}'s setup.url", url, asset.url)

    comfy = rows["comfyui"]["setup"]
    usual = _asset("comfyui", "linux-x64", "nvidia")
    builds = {
        "older_drivers": _asset("comfyui", "linux-x64", "nvidia", "older_drivers"),
        "cpu": _asset("comfyui", "linux-x64", None, "cpu"),
    }
    compare("comfyui's setup.version", comfy["version"], pins.program("comfyui").version)
    compare("comfyui's setup.url", comfy["url"], usual.url)
    compare(
        "comfyui's setup.download_bytes",
        comfy["download_bytes"],
        program_setup.download_bytes(usual),
    )
    compare("comfyui's setup.install_bytes", comfy["install_bytes"], usual.install_bytes)
    for other in comfy["builds"]:
        asset = builds[other["build"]]
        compare(
            f"comfyui's {other['build']} download_bytes",
            other["download_bytes"],
            program_setup.download_bytes(asset),
        )
        compare(
            f"comfyui's {other['build']} install_bytes",
            other["install_bytes"],
            asset.install_bytes,
        )

    windows = examples["windows"]
    usual = _asset("comfyui", "windows-x64", "nvidia")
    older = _asset("comfyui", "windows-x64", "nvidia", "older_drivers")
    compare("the Windows setup's version", windows["version"], pins.program("comfyui").version)
    compare("the Windows setup's url", windows["url"], usual.url)
    compare(
        "the Windows setup's download_bytes",
        windows["download_bytes"],
        program_setup.download_bytes(usual),
    )
    compare("the Windows setup's install_bytes", windows["install_bytes"], usual.install_bytes)
    for other in windows["builds"]:
        compare(
            "the Windows older_drivers download_bytes",
            other["download_bytes"],
            program_setup.download_bytes(older),
        )
        compare(
            "the Windows older_drivers install_bytes", other["install_bytes"], older.install_bytes
        )

    for event in examples["events"]:
        program = event.get("program")
        if event["type"] == "program.setup.progress" and program == "ffmpeg":
            compare(
                "the progress event's total",
                event["total"],
                program_setup.download_bytes(ffmpeg_linux),
            )
        elif event["type"] == "program.setup.done" and program in ("ffmpeg", "ollama"):
            compare(
                f"{program}'s done event version", event["version"], pins.program(program).version
            )
        elif event["type"] == "program.removed" and program == "ffmpeg":
            compare("the removed event's freed_bytes", event["freed_bytes"], ffmpeg_bytes)
    return problems


# -- the tests ---------------------------------------------------------------------------


def test_the_prose_states_the_pins(tmp_path):
    assert prose_problems(DOC.read_text(encoding="utf-8"), tmp_path) == []


def test_the_json_examples_report_the_pins(tmp_path):
    assert example_problems(DOC.read_text(encoding="utf-8"), tmp_path) == []


def _another(value: str) -> str:
    """A figure as the page writes it, with its last digit changed."""
    last = re.search(r"\d(?=\D*$)", value)
    assert last, value
    digit = str((int(last.group()) + 1) % 10)
    return value[: last.start()] + digit + value[last.end() :]


def _change_group(pattern: str):
    """A change to the page: the first group of the one place `pattern`
    matches, given another value."""

    def change(text: str) -> str:
        match = re.search(pattern, text)
        assert match, f"the page no longer matches {pattern!r}"
        return text[: match.start(1)] + _another(match.group(1)) + text[match.end(1) :]

    return change


def _change_example(key: str, holder: str):
    """A change to the page: `key` in the JSON object `holder` starts,
    given another value."""

    def change(text: str) -> str:
        match = re.compile(rf'"{key}": (\d+|"[^"]+")').search(text, text.index(holder))
        assert match, f"no {key} after {holder!r}"
        return text[: match.start(1)] + _another(match.group(1)) + text[match.end(1) :]

    return change


_CHANGES = {
    # What is pinned, in prose...
    "ollama-version": _change_group(
        r"\[Ollama's own releases\]\([^)]*\), version\s+(\d+(?:\.\d+)+)\."
    ),
    "ollama-linux-size": _change_group(r"`ollama-linux-amd64\.tar\.zst` on Linux \((\d\.\d\d)"),
    "comfyui-flags": _change_group(r"Those are ComfyUI (\d+(?:\.\d+)+)'s own flags"),
    # ...in the table...
    "table-cell": _change_group(r"\| `cpu`[^|\n]*\|[^|\n]*\| \d+ \| ([\d,]+) \|"),
    # ...a sentence reworded out of the checker's reach...
    "reworded": lambda text: text.replace("Every build has PyTorch", "Each build has PyTorch"),
    # ...and in each JSON example.
    "ffmpeg-download": _change_example("download_bytes", '"id": "ffmpeg"'),
    "ollama-recorded": _change_example("bytes", '"id": "ollama"'),
    "windows-install": _change_example(
        "install_bytes", '"url": "https://github.com/Comfy-Org/ComfyUI/releases/'
    ),
    "removed-event": _change_example("freed_bytes", '"type": "program.removed"'),
}


@pytest.mark.parametrize("change", _CHANGES.values(), ids=_CHANGES.keys())
def test_a_figure_out_of_step_with_the_pin_is_reported(tmp_path, change):
    """The checks above, shown failing. Each change is made to the page as
    it is, so this holds whichever version is pinned."""
    text = DOC.read_text(encoding="utf-8")
    changed = change(text)
    assert changed != text
    problems = prose_problems(changed, tmp_path) + example_problems(changed, tmp_path / "x")
    assert problems != []


def test_ci_and_the_hook_run_this_module_for_the_page_it_reads():
    """docs/programs.md is outside engine/, so a commit that edits it alone
    has to reach this module some other way: ci-engine.yml's docs/** filter
    and a pre-push hook of its own."""
    page = DOC.relative_to(REPO_ROOT).as_posix()
    for trigger, globs in ci_engine_paths_by_trigger().items():
        assert matches_a_path_filter(page, globs), f"ci-engine.yml's {trigger} filter skips it"
    assert hook_files_pattern("programs-docs-contract").match(page)
