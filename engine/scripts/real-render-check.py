"""Render one real project on this machine and check what comes out.

    cd engine
    uv run python scripts/real-render-check.py
    uv run python scripts/real-render-check.py --data-dir ~/localcut-test/comfyui-042
    uv run python scripts/real-render-check.py --script-model qwen3:8b --keep-running

Run it before merging a change to a program pin (ComfyUI, Ollama, FFmpeg)
and after an engine change that touches rendering, on a machine with an
NVIDIA card. docs/running-real-models.md says what it downloads and how long
it takes.

1. Starts an engine from this checkout on ports it picks, with its own token
   and data dir (`~/localcut-test/real-render` unless --data-dir names
   another). It never uses ~/.localcut or the usual ports, so a ComfyUI or
   Ollama of the user's own keeps running beside it untouched.
2. Sets up LocalCut's own FFmpeg and ComfyUI (and Ollama, with
   --script-model) through POST /programs/{id}/setup when a copy is missing
   or is not the build pinned now. It downloads the models the engine
   recommends for this machine. It prints the sizes before anything
   downloads. Everything lands in the data dir, so the next run reuses it.
   A model download that stops partway resumes there.
3. Checks that ComfyUI's /object_info has every node class and input name
   the packaged workflow templates use.
4. Renders a fixed prompt through the job API and exports the MP4.
5. Checks the MP4's streams, that every clip moves, that the music is not
   silent and that the final mix has sound.
6. Writes report.json and summary.md to <data dir>/reports/<timestamp>/,
   beside the MP4, the clips, the music and a few frames.
7. Stops the engine with POST /shutdown (which stops the servers it started)
   and checks that no process it started is left. --keep-running leaves the
   engine up and prints how to reach it.

Exit status, as for every LocalCut command: 0 every check passed, 1 a check
or the render failed, 2 the engine could not be started or reached.
"""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import platform
import random
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psutil

import localcut_engine
from localcut_engine.aspects import EXPORT_RESOLUTIONS
from localcut_engine.automation import (
    EXIT_FAILED,
    EXIT_OK,
    EXIT_UNREACHABLE,
    EngineClient,
    EngineError,
    finished_cut_hash,
    outstanding_jobs,
    unfinished_jobs,
)

ENGINE = Path(__file__).resolve().parent.parent
TEMPLATES = ENGINE / "src" / "localcut_engine" / "comfy_templates"

DEFAULT_DATA_DIR = Path.home() / "localcut-test" / "real-render"
DEFAULT_PROMPT = "A red fox trotting through a snowy pine forest at sunrise"
DEFAULT_DURATION_S = 16
DEFAULT_ASPECT = "9:16"

# `mock` last serves only the script: every other stage runs on its real
# backend. EXPECTED_BACKENDS says so when one did not.
MOCK_SCRIPT_CHAIN = "comfy,kokoro,align,ffmpeg,mock"
LLM_SCRIPT_CHAIN = "llm," + MOCK_SCRIPT_CHAIN

# The backend each stage has to have rendered on. A stage that fell back
# (a clip from the still-clip tier on ffmpeg, a mock music bed) still makes
# a playable MP4, so the checks on the output alone would pass it.
EXPECTED_BACKENDS = {
    "keyframe": "comfyui",
    "clip": "comfyui",
    "music": "comfyui",
    "narration": "kokoro",
    "captions": "align",
    "timeline": "ffmpeg",
    "export": "ffmpeg",
}

# Where LocalCut's engine, ComfyUI and Ollama listen by default. A user's
# own servers are likely there, so the check never takes these.
DEFAULT_PORTS = frozenset({7830, 8188, 11434})
# Below Linux's ephemeral range (32768 and up), so an outgoing connection
# cannot take a picked port before the server it was picked for binds it.
PORT_RANGE = (20000, 32000)

# -- thresholds ------------------------------------------------------------------

# The export's video track, audio track and container may disagree by this
# much: an AAC frame is 21 ms and the muxer pads the last one. More is a
# track that stops early, which plays as the picture or the voice running
# out before the other.
STREAM_DURATION_TOLERANCE_S = 0.25
# The shortest project the engine accepts is 5 s. An export shorter than
# that was cut off.
MIN_DURATION_S = 5.0
# A cut is as long as its narration, which the script fits to the target.
# Half again past the target is a stage that looped or a timeline that lost
# its timing.
MAX_DURATION_RATIO = 1.5

# freezedetect's noise floor: frames closer than this are the same picture.
# -60 dB is its own default, close enough to identical that encoder noise on
# a moving clip stays above it.
FREEZE_NOISE_DB = -60
# Identical frames for this long is a stalled clip: the model returned its
# keyframe over and over, or something padded the clip with a held frame.
FREEZE_MIN_S = 1.0
# PSNR of a clip's last frame against its first. A fox walking across the
# frame measures about 10 dB. A clip that ends on the picture it started
# from measures 30 dB and up (identical frames are infinite). Above this the
# clip went nowhere.
MAX_FIRST_LAST_PSNR_DB = 25.0

# Loudness as volumedetect reports it, in dBFS, where digital silence reads
# -91 dB. The music bed is quiet by design: an "ambient, understated" ACE-Step
# bed measures about -34 dB mean and -16 dB peak. Below these the bed is
# silence, or a model output at the noise floor.
MUSIC_MIN_MEAN_DB = -55.0
MUSIC_MIN_PEAK_DB = -35.0
# The mix carries the narration well above the bed: about -24 dB mean and
# -6 dB peak. Below these it is silent or close to it, which is what a mix
# of placeholder narration and music sounds like.
MIX_MIN_MEAN_DB = -40.0
MIX_MIN_PEAK_DB = -20.0

# Other processes holding more GPU memory than this make the stage times
# (and any out-of-memory retry) about them rather than the change under test.
GPU_BUSY_WARN_MIB = 1024

# Where in the export the frames kept with the report come from.
FRAME_POINTS = (0.25, 0.5, 0.75)

# -- waits -----------------------------------------------------------------------

ENGINE_START_TIMEOUT_S = 120.0
# A copy's first start compiles PyTorch's and every node's bytecode. The
# engine itself gives it ten minutes.
SERVER_READY_TIMEOUT_S = 900.0
SHUTDOWN_TIMEOUT_S = 60.0
# How long the processes the engine started get to exit after the engine
# has. Its own stop waits a second for each before killing it.
LEFTOVER_GRACE_S = 10.0
POLL_S = 2.0


# -- what the templates need from ComfyUI ----------------------------------------


def load_templates(directory: Path = TEMPLATES) -> dict[str, dict]:
    """Every packaged workflow template, by file name."""
    return {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.json"))
    }


def template_requirements(templates: dict[str, dict]) -> dict[str, set[str]]:
    """Each node class the templates use, with every input name they send it."""
    needed: dict[str, set[str]] = {}
    for workflow in templates.values():
        for node in workflow.values():
            needed.setdefault(node["class_type"], set()).update(node.get("inputs") or {})
    return needed


def object_info_gaps(needed: dict[str, set[str]], object_info: dict) -> list[str]:
    """What ComfyUI's /object_info lacks of `needed`: a class it does not
    serve, or an input name a class does not declare as required or
    optional. ComfyUI refuses a prompt over either."""
    gaps = []
    for class_type in sorted(needed):
        spec = object_info.get(class_type)
        if not isinstance(spec, dict):
            gaps.append(f"no node class {class_type}")
            continue
        declared = spec.get("input") or {}
        offered: set[str] = set()
        for group in ("required", "optional"):
            offered.update(declared.get(group) or {})
        gaps.extend(
            f"{class_type} has no input {name}" for name in sorted(needed[class_type] - offered)
        )
    return gaps


def object_info_check(needed: dict[str, set[str]], object_info: dict) -> dict:
    gaps = object_info_gaps(needed, object_info)
    inputs = sum(len(names) for names in needed.values())
    if gaps:
        return check("object_info", False, "; ".join(gaps), missing=gaps)
    return check(
        "object_info",
        True,
        f"all {len(needed)} node classes and {inputs} input names the templates use",
        classes=len(needed),
        inputs=inputs,
    )


# -- reading what FFmpeg says ------------------------------------------------------

_FREEZE = re.compile(r"lavfi\.freezedetect\.freeze_(start|end): (-?[0-9.]+)")
_VOLUME = re.compile(r"\] (n_samples|mean_volume|max_volume): (-?inf|-?[0-9.]+)")
_PSNR = re.compile(r"PSNR .*?average:(inf|[0-9.]+)")


def parse_freezes(stderr: str, duration_s: float) -> list[tuple[float, float]]:
    """Each still stretch freezedetect reported, as (start, end) seconds. A
    stretch still running when the clip ends has a start and no end in
    freezedetect's output; it ends at `duration_s`."""
    freezes = []
    start: float | None = None
    for which, value in _FREEZE.findall(stderr):
        if which == "start":
            start = float(value)
        elif start is not None:
            freezes.append((start, float(value)))
            start = None
    if start is not None:
        freezes.append((start, duration_s))
    return freezes


def parse_volume(stderr: str) -> dict | None:
    """volumedetect's mean and peak level, or None when it measured no audio.

    FFmpeg can configure a filter graph twice and print an empty report
    (`n_samples: 0`) for the first one, so the last report that saw samples
    is the measurement."""
    reports: list[dict] = []
    for key, value in _VOLUME.findall(stderr):
        if key == "n_samples":
            reports.append({"samples": int(value)})
        elif reports:
            reports[-1][key] = float(value)
    for report in reversed(reports):
        if report["samples"] and "mean_volume" in report and "max_volume" in report:
            return {
                "mean_db": report["mean_volume"],
                "peak_db": report["max_volume"],
                "samples": report["samples"],
            }
    return None


def parse_psnr(stderr: str) -> float | None:
    """The psnr filter's average over its two inputs, infinite when they
    are identical, or None when it printed none."""
    found = _PSNR.findall(stderr)
    return float(found[-1]) if found else None


# -- verdicts ----------------------------------------------------------------------


def check(name: str, passed: bool, detail: str, **measured: object) -> dict:
    """One line of the report."""
    entry: dict = {"name": name, "passed": passed, "detail": detail}
    if measured:
        entry["measured"] = measured
    return entry


def _listed(items: list[str]) -> str:
    """`a, b and c`."""
    return " and ".join(filter(None, [", ".join(items[:-1]), items[-1] if items else ""]))


def _seconds(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def streams_check(probe: dict, *, target_s: float, size: tuple[int, int]) -> dict:
    """ffprobe's view of the export against what the export stage promises:
    one H.264 track at the aspect's canvas, one AAC track at 48 kHz stereo,
    tracks as long as each other and a length that fits the target."""
    streams = probe.get("streams") or []
    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    v = video[0] if video else {}
    a = audio[0] if audio else {}
    problems = []
    if len(video) != 1:
        problems.append(f"{len(video)} video tracks, not 1")
    if len(audio) != 1:
        problems.append(f"{len(audio)} audio tracks, not 1")
    if video and v.get("codec_name") != "h264":
        problems.append(f"video is {v.get('codec_name')}, not h264")
    if video and (v.get("width"), v.get("height")) != tuple(size):
        problems.append(f"video is {v.get('width')}x{v.get('height')}, not {size[0]}x{size[1]}")
    if audio and a.get("codec_name") != "aac":
        problems.append(f"audio is {a.get('codec_name')}, not aac")
    if audio and str(a.get("sample_rate")) != "48000":
        problems.append(f"audio is {a.get('sample_rate')} Hz, not 48000")
    if audio and a.get("channels") != 2:
        problems.append(f"audio has {a.get('channels')} channels, not 2")
    duration = _seconds((probe.get("format") or {}).get("duration"))
    if duration is None:
        problems.append("the container states no duration")
    else:
        if duration < MIN_DURATION_S:
            problems.append(f"{duration:.2f} s is shorter than {MIN_DURATION_S:g} s")
        if duration > MAX_DURATION_RATIO * target_s:
            problems.append(
                f"{duration:.2f} s is more than {MAX_DURATION_RATIO:g} times the {target_s:g} s asked"
            )
        for label, track in (("video", v), ("audio", a)):
            seconds = _seconds(track.get("duration"))
            if (
                track
                and seconds is not None
                and abs(seconds - duration) > STREAM_DURATION_TOLERANCE_S
            ):
                problems.append(f"the {label} track is {seconds:.2f} s of {duration:.2f} s")
    measured = {
        "duration_s": duration,
        "video": {
            key: v.get(key)
            for key in ("codec_name", "width", "height", "avg_frame_rate", "nb_frames", "duration")
        },
        "audio": {key: a.get(key) for key in ("codec_name", "sample_rate", "channels", "duration")},
    }
    if problems:
        return check("streams", False, "; ".join(problems), **measured)
    rate = v.get("avg_frame_rate") or "?"
    fps = rate
    if "/" in str(rate):
        top, _, bottom = str(rate).partition("/")
        if bottom not in ("", "0"):
            fps = f"{int(top) / int(bottom):g}"
    return check(
        "streams",
        True,
        f"H.264 {v['width']}x{v['height']} at {fps} fps, AAC 48 kHz stereo, {duration:.2f} s",
        **measured,
    )


def _db(value: float) -> str:
    return "inf" if math.isinf(value) else f"{value:.1f}"


def motion_check(
    node: str,
    *,
    duration_s: float | None,
    frames: object,
    freezes: list[tuple[float, float]],
    psnr_db: float | None,
) -> dict:
    """Whether one clip moves: no stretch of identical frames freezedetect
    flags and a last frame that is not the first one again."""
    problems = []
    still = sum(end - start for start, end in freezes)
    if freezes:
        problems.append(f"still for {still:.1f} s, from {freezes[0][0]:.1f} s")
    if psnr_db is None:
        problems.append("its first and last frames could not be compared")
    elif psnr_db > MAX_FIRST_LAST_PSNR_DB:
        problems.append(
            f"its last frame is {_db(psnr_db)} dB PSNR from its first, over "
            f"{MAX_FIRST_LAST_PSNR_DB:g} dB"
        )
    length = f"{duration_s:.2f} s" if duration_s is not None else "unknown length"
    # JSON has no infinity, so identical frames are recorded as "inf".
    psnr: float | str | None = psnr_db
    if psnr_db is not None:
        psnr = "inf" if math.isinf(psnr_db) else round(psnr_db, 2)
    measured = {
        "duration_s": duration_s,
        "frames": frames,
        "still_s": round(still, 3),
        "first_last_psnr_db": psnr,
    }
    if problems:
        return check(f"motion {node}", False, f"{length}: " + "; ".join(problems), **measured)
    return check(
        f"motion {node}",
        True,
        f"{length}, {frames} frames, no still second, first to last frame {_db(psnr_db)} dB PSNR",
        **measured,
    )


def loudness_check(
    name: str, volume: dict | None, *, min_mean_db: float, min_peak_db: float
) -> dict:
    """Whether audio is loud enough to be what it should be rather than silence."""
    if volume is None:
        return check(name, False, "volumedetect measured no audio")
    loud = volume["mean_db"] >= min_mean_db and volume["peak_db"] >= min_peak_db
    detail = f"mean {_db(volume['mean_db'])} dB, peak {_db(volume['peak_db'])} dB"
    if not loud:
        detail += f", needs a mean of {min_mean_db:g} dB and a peak of {min_peak_db:g} dB"
    return check(name, loud, detail, **volume)


def stage_rows(jobs: list[dict]) -> list[dict]:
    """GET /jobs for one project as the report's stage table, in the order
    the stages started."""
    rows = []
    for job in jobs:
        spec = job.get("spec") or {}
        started, finished = job.get("started_at"), job.get("finished_at")
        timed = isinstance(started, (int, float)) and isinstance(finished, (int, float))
        rows.append(
            {
                "node": spec.get("node_id"),
                "kind": spec.get("kind"),
                "status": job.get("status"),
                "backend": job.get("backend"),
                "model": job.get("model"),
                "attempt": job.get("attempt", 0),
                "error": job.get("error"),
                "seconds": round(finished - started, 1) if timed else None,
                "created_at": job.get("created_at"),
                "started_at": started,
                "finished_at": finished,
            }
        )
    rows.sort(key=lambda r: (r["started_at"] is None, r["started_at"] or 0, r["created_at"] or 0))
    return rows


def finished_by_node(jobs: list[dict], kind: str) -> list[dict]:
    """The newest finished job of each node of `kind`, in node order. A
    re-plan can render a node again and the export is built from the last."""
    newest: dict[str, dict] = {}
    for job in jobs:
        spec = job.get("spec") or {}
        if spec.get("kind") != kind or job.get("status") != "done":
            continue
        seen = newest.get(spec.get("node_id"))
        if seen is None or (job.get("finished_at") or 0) > (seen.get("finished_at") or 0):
            newest[spec.get("node_id")] = job
    return [newest[node] for node in sorted(newest)]


def backends_check(rows: list[dict], expected: dict[str, str]) -> dict:
    """Every stage rendered, each on the backend it has to have used."""
    done = [row for row in rows if row["status"] == "done"]
    problems = []
    for kind, backend in expected.items():
        of_kind = [row for row in done if row["kind"] == kind]
        if not of_kind:
            problems.append(f"no {kind} rendered")
            continue
        wrong = [
            f"{row['node']} on {row['backend']}" for row in of_kind if row["backend"] != backend
        ]
        if wrong:
            problems.append(f"{_listed(wrong)} instead of {backend}")
    if problems:
        return check("backends", False, "; ".join(problems))
    used = _listed([f"{kind} on {backend}" for kind, backend in expected.items()])
    return check("backends", True, used)


def program_ready(row: dict) -> bool:
    """Whether GET /programs shows LocalCut's copy as the build pinned now
    (and, for Ollama, holding the script model), so no setup is needed."""
    managed = row.get("managed")
    if not managed or not managed.get("current"):
        return False
    if row["id"] == "ollama":
        return (row.get("checks") or {}).get("model_present") is True
    return True


def models_to_download(recommendations: list[dict], models: list[dict]) -> list[dict]:
    """The models GET /system recommends for this machine that the engine
    downloads and does not have yet, as GET /models rows. A recommendation
    with no files (a script model, which Ollama pulls) is not one."""
    rows = {row["id"]: row for row in models}
    wanted = []
    for recommendation in recommendations:
        model = recommendation.get("model") or {}
        row = rows.get(model.get("id"))
        if row is not None and row.get("size_bytes") and not row.get("downloaded"):
            wanted.append(row)
    return wanted


def recommended_downloads(recommendations: list[dict], models: list[dict]) -> list[dict]:
    """Every recommended model that has files, downloaded or not."""
    rows = {row["id"]: row for row in models}
    return [
        rows[(r.get("model") or {}).get("id")]
        for r in recommendations
        if (r.get("model") or {}).get("id") in rows and rows[r["model"]["id"]].get("size_bytes")
    ]


def this_runs_log(text: str, url: str) -> str:
    """The part of a managed server's log from the last time the engine
    started it at `url`. The engine marks each start with a line naming the
    address and every run of the check picks a new one."""
    marker = re.compile(rf"^-- LocalCut started \S+ at .*: {re.escape(url)}$", re.M)
    starts = list(marker.finditer(text))
    return text[starts[-1].start() :] if starts else text


# -- the report --------------------------------------------------------------------


def build_report(
    *,
    started: float,
    finished: float,
    request: dict,
    versions: dict,
    setup: dict,
    project: dict,
    stages: list[dict],
    checks: list[dict],
    unreachable: str | None = None,
    notes: list[str] | None = None,
) -> dict:
    """The run as report.json holds it, with the verdict and exit status
    the checks add up to."""
    if unreachable:
        verdict, status = "engine_unreachable", EXIT_UNREACHABLE
    elif checks and all(entry["passed"] for entry in checks):
        verdict, status = "passed", EXIT_OK
    else:
        verdict, status = "failed", EXIT_FAILED
    finished_at = [row["finished_at"] for row in stages if row.get("finished_at")]
    created = project.get("created_at")
    return {
        "format": 1,
        "verdict": verdict,
        "exit_status": status,
        "unreachable": unreachable,
        "started": _iso(started),
        "finished": _iso(finished),
        "wall_s": round(finished - started, 1),
        "request": request,
        "versions": versions,
        "setup": setup,
        "project": project,
        "render_s": round(max(finished_at) - created, 1) if finished_at and created else None,
        "stages": stages,
        "checks": checks,
        "notes": notes or [],
    }


def json_safe(value: object) -> object:
    """`value` with every infinite or NaN float as a string: JSON has no
    such numbers, while volumedetect and the psnr filter both produce them."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def _iso(stamp: float) -> str:
    return datetime.datetime.fromtimestamp(stamp, datetime.UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    if seconds < 60:
        return f"{seconds:.1f} s"
    minutes, rest = divmod(round(seconds), 60)
    return f"{minutes} min {rest} s"


def summary_markdown(report: dict) -> str:
    """The short version of report.json, for a PR description."""
    versions = report["versions"]
    request = report["request"]
    title = {
        "passed": "passed",
        "failed": "failed",
        "engine_unreachable": "the engine could not be reached",
    }[report["verdict"]]
    lines = [f"# Real render check: {title}", ""]
    engine = versions.get("engine") or {}
    commit = engine.get("commit") or "unknown commit"
    if engine.get("dirty"):
        commit += " with uncommitted changes"
    lines.append(f"{report['started']}, engine {commit}, {report['wall_s']:.0f} s in all.")
    lines.append("")
    gpu = versions.get("gpu") or {}
    lines.append(
        f"FFmpeg {versions.get('ffmpeg') or '-'}, ComfyUI {versions.get('comfyui') or '-'} "
        f"(Python {versions.get('comfyui_python') or '-'}, PyTorch {versions.get('torch') or '-'}), "
        f"Ollama {versions.get('ollama') or 'not used'}, engine Python {versions.get('python') or '-'}. "
        f"{gpu.get('name') or ('no GPU found' if 'gpu' in versions else 'GPU not read')}"
        + (f", {gpu['vram_gb']:g} GB" if gpu.get("vram_gb") else "")
        + (f", driver {gpu['driver']}" if gpu.get("driver") else "")
        + "."
    )
    lines.append("")
    script = (
        f"the script from {request['script_model']}"
        if request.get("script_model")
        else "the script from the mock"
    )
    lines.append(
        f'"{request["prompt"]}", {request["duration_s"]} s, {request["aspect"]}, {script}.'
    )
    setup = report.get("setup") or {}
    fetched = setup.get("downloaded_bytes") or 0
    if setup.get("seconds") is not None:
        lines.append(
            f"Getting the programs and models ready took {_duration(setup['seconds'])} "
            "and downloaded " + (f"{fetched / 2**30:.2f} GiB." if fetched else "nothing.")
        )
    lines.append("")
    stages = report.get("stages") or []
    if stages:
        lines += ["| Stage | Backend | Status | Time |", "|---|---|---|---|"]
        for row in stages:
            lines.append(
                f"| {row['node']} | {row['backend'] or '-'} | {row['status']} | "
                f"{_duration(row['seconds'])} |"
            )
        lines.append(f"| create to finished export | | | {_duration(report.get('render_s'))} |")
        lines.append("")
    if report.get("unreachable"):
        lines += [f"The engine could not be reached: {report['unreachable']}", ""]
    checks = report.get("checks") or []
    if checks:
        lines += ["| Check | Verdict | Detail |", "|---|---|---|"]
        for entry in checks:
            verdict = "pass" if entry["passed"] else "FAIL"
            detail = entry["detail"].replace("|", "/")
            lines.append(f"| {entry['name']} | {verdict} | {detail} |")
        lines.append("")
    for note in report.get("notes") or []:
        lines.append(f"Note: {note}")
    return "\n".join(lines).rstrip() + "\n"


# -- the engine this check runs ------------------------------------------------------


class Stop(Exception):
    """A step failed in a way the steps after it cannot get past. Its check
    is on the report already."""


class Unreachable(EngineError):
    def __init__(self, message: str) -> None:
        super().__init__(message, unreachable=True)


def pick_ports(count: int) -> list[int]:
    """`count` loopback ports nothing is bound to, none of LocalCut's defaults."""
    picked: list[int] = []
    while len(picked) < count:
        port = random.randrange(*PORT_RANGE)
        if port in DEFAULT_PORTS or port in picked:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        picked.append(port)
    return picked


def _alive(proc: psutil.Process) -> bool:
    """Whether the process the engine started is still running. psutil
    compares its start time too, so a PID the system has since given to
    another process reads as gone and is never killed."""
    try:
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.Error:
        return False


def _answers(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


class EngineProcess:
    """An engine from this checkout, on ports and a token of its own."""

    def __init__(self, *, data_dir: Path, log_path: Path, script_model: str | None) -> None:
        self.data_dir = data_dir
        self.log_path = log_path
        self.script_model = script_model
        self.port, self.comfyui_port, self.llm_port = pick_ports(3)
        self.token = secrets.token_urlsafe(24)
        self.process: subprocess.Popen | None = None
        self.answered = False
        # Every process seen under the engine, with its name taken while
        # it ran: a process that has exited no longer has one to ask for.
        self.seen: dict[int, tuple[psutil.Process, str]] = {}
        self._log = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def comfyui_url(self) -> str:
        return f"http://127.0.0.1:{self.comfyui_port}"

    @property
    def backend(self) -> str:
        return LLM_SCRIPT_CHAIN if self.script_model else MOCK_SCRIPT_CHAIN

    def environment(self) -> dict[str, str]:
        """This shell's environment without any LOCALCUT_ setting of the
        user's, plus the check's own."""
        env = {key: value for key, value in os.environ.items() if not key.startswith("LOCALCUT_")}
        env["LOCALCUT_TOKEN"] = self.token
        env["LOCALCUT_COMFYUI_URL"] = self.comfyui_url
        env["LOCALCUT_LLM_URL"] = f"http://127.0.0.1:{self.llm_port}/v1"
        if self.script_model:
            env["LOCALCUT_LLM_MODEL"] = self.script_model
        return env

    def start(self) -> EngineClient:
        command = [
            sys.executable,
            "-P",
            "-m",
            "localcut_engine",
            "serve",
            "--port",
            str(self.port),
            "--data-dir",
            str(self.data_dir),
            "--backend",
            self.backend,
        ]
        # Its own process group: the Ctrl+C that stops this script must not
        # reach the engine before the script has asked it to stop.
        group = (
            {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            if os.name == "nt"
            else {"start_new_session": True}
        )
        self._log = self.log_path.open("ab")
        self.process = subprocess.Popen(
            command,
            env=self.environment(),
            stdin=subprocess.DEVNULL,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            **group,
        )
        self.track()
        deadline = time.monotonic() + ENGINE_START_TIMEOUT_S
        while True:
            code = self.process.poll()
            if code is not None:
                raise Unreachable(
                    f"the engine exited with status {code} before it answered:\n{self.log_tail()}"
                )
            try:
                if httpx.get(f"{self.url}/health", timeout=2).json().get("ok"):
                    self.answered = True
                    break
            except (httpx.HTTPError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise Unreachable(
                    f"the engine did not answer at {self.url} within "
                    f"{ENGINE_START_TIMEOUT_S:.0f} s:\n{self.log_tail()}"
                )
            time.sleep(0.5)
        return EngineClient(self.url, self.token, timeout=120)

    def track(self) -> None:
        """Remember every process the engine runs now, so a stop can check
        each of them is gone even when the engine itself is."""
        if self.process is None:
            return
        try:
            engine = psutil.Process(self.process.pid)
            found = [engine, *engine.children(recursive=True)]
        except psutil.Error:
            return
        for proc in found:
            if proc.pid not in self.seen:
                try:
                    self.seen[proc.pid] = (proc, proc.name())
                except psutil.Error:
                    continue

    def log_tail(self, lines: int = 20) -> str:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(text.splitlines()[-lines:])

    def stop(self, client: EngineClient | None) -> dict:
        """POST /shutdown, then check the engine and everything it started
        have exited and nothing answers on the ports it was given. Kills
        whatever is left, so a failed check leaves the machine clean."""
        assert self.process is not None
        self.track()
        problems = []
        if self.process.poll() is None:
            try:
                if client is None:
                    raise EngineError("no client")
                client.post("/shutdown")
            except EngineError as exc:
                problems.append(f"POST /shutdown failed: {exc}")
            try:
                self.process.wait(SHUTDOWN_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                problems.append(
                    f"the engine still ran {SHUTDOWN_TIMEOUT_S:.0f} s after POST /shutdown"
                )
                self.process.kill()
                self.process.wait(10)
        elif self.answered:
            problems.append(
                f"the engine had exited by itself, with status {self.process.returncode}"
            )
        others = [proc for pid, (proc, _) in self.seen.items() if pid != self.process.pid]
        started = sorted(name for pid, (_, name) in self.seen.items() if pid != self.process.pid)
        deadline = time.monotonic() + LEFTOVER_GRACE_S
        alive = [proc for proc in others if _alive(proc)]
        while alive and time.monotonic() < deadline:
            time.sleep(0.2)
            alive = [proc for proc in alive if _alive(proc)]
        left = []
        for proc in alive:
            try:
                left.append(f"{proc.pid} {' '.join(proc.cmdline())[:120]}")
                proc.kill()
            except psutil.Error:
                continue
        if left:
            problems.append("still running, so killed: " + "; ".join(left))
        listening = [
            port for port in (self.port, self.comfyui_port, self.llm_port) if _answers(port)
        ]
        if listening:
            problems.append(
                "something still answers on port " + ", ".join(str(port) for port in listening)
            )
        if self._log is not None:
            self._log.close()
        if problems:
            return check("shutdown", False, "; ".join(problems), started=started)
        return check(
            "shutdown",
            True,
            f"the engine and the {len(others)} process{'es' if len(others) != 1 else ''} "
            "it started exited after POST /shutdown"
            if self.answered
            else "the engine never answered and nothing it started is running",
            started=started,
        )


# -- the run -----------------------------------------------------------------------


def say(line: str = "") -> None:
    print(line, flush=True)


def _size(count: int | float | None) -> str:
    count = count or 0
    if count >= 2**30:
        return f"{count / 2**30:.2f} GiB"
    return f"{count / 2**20:.0f} MiB"


def _run(command: list[str], timeout: float = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def gpu_processes() -> list[dict]:
    """What nvidia-smi says holds GPU memory now, or nothing when there is
    no nvidia-smi to ask."""
    if shutil.which("nvidia-smi") is None:
        return []
    try:
        result = _run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ],
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 3 and parts[2].isdigit():
            found.append({"pid": parts[0], "name": parts[1], "mib": int(parts[2])})
    return found


def checkout_commit() -> dict:
    def git(*args: str) -> str:
        try:
            return _run(["git", "-C", str(ENGINE), *args], timeout=30).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""

    return {
        "commit": git("rev-parse", "--short=12", "HEAD") or None,
        "dirty": bool(git("status", "--porcelain", "--untracked-files=no")),
    }


class Run:
    def __init__(self, args: argparse.Namespace, data_dir: Path, report_dir: Path) -> None:
        self.args = args
        self.data_dir = data_dir
        self.report_dir = report_dir
        self.started = time.time()
        self.checks: list[dict] = []
        self.notes: list[str] = []
        self.versions: dict = {"python": platform.python_version(), "os": platform.platform()}
        self.setup: dict = {"programs": [], "models": [], "seconds": None, "downloaded_bytes": 0}
        self.project: dict = {}
        self.stages: list[dict] = []
        self.unreachable: str | None = None
        self.engine: EngineProcess | None = None
        self.client: EngineClient | None = None
        self.ffmpeg: Path | None = None
        self.jobs: list[dict] = []
        self.interrupted = False

    @property
    def request(self) -> dict:
        return {
            "prompt": self.args.prompt,
            "duration_s": self.args.duration,
            "aspect": self.args.aspect,
            "script_model": self.args.script_model,
            "backend": self.engine.backend if self.engine else None,
            "data_dir": str(self.data_dir),
            "report_dir": str(self.report_dir),
        }

    def fail(self, name: str, detail: str, **measured: object) -> Stop:
        self.checks.append(check(name, False, detail, **measured))
        say(f"FAIL {name}: {detail}")
        return Stop(detail)

    def passed(self, entry: dict) -> None:
        self.checks.append(entry)
        say(f"{'ok  ' if entry['passed'] else 'FAIL'} {entry['name']}: {entry['detail']}")

    # -- steps ---------------------------------------------------------------------

    def execute(self) -> None:
        try:
            self.look_at_the_gpu()
            self.start_engine()
            self.cancel_leftovers()
            self.bring_programs_and_models()
            self.check_object_info()
            self.render()
            self.verify()
        except Stop:
            pass
        except EngineError as exc:
            if exc.unreachable:
                self.unreachable = str(exc)
                say(f"error: {exc}")
            else:
                self.fail("engine", str(exc))

    def look_at_the_gpu(self) -> None:
        busy = gpu_processes()
        self.versions["gpu_processes_before"] = busy
        held = sum(entry["mib"] for entry in busy)
        if held > GPU_BUSY_WARN_MIB:
            listed = ", ".join(f"{e['name']} ({e['pid']}, {e['mib']} MiB)" for e in busy)
            note = f"other processes held {held} MiB of GPU memory at the start: {listed}"
            self.notes.append(note)
            say(f"warning: {note}. Stage times will not be comparable.")

    def start_engine(self) -> None:
        self.engine = EngineProcess(
            data_dir=self.data_dir,
            log_path=self.report_dir / "engine.log",
            script_model=self.args.script_model,
        )
        say(
            f"Starting an engine from {ENGINE} on port {self.engine.port}, ComfyUI on "
            f"{self.engine.comfyui_port}, the LLM server on {self.engine.llm_port}, "
            f"data in {self.data_dir}"
        )
        self.versions["engine"] = checkout_commit()
        self.client = self.engine.start()
        self.versions["engine"]["version"] = self.client.get("/health").get("engine_version")

    def cancel_leftovers(self) -> None:
        """Cancel the jobs an interrupted earlier run left queued in this
        data dir. The engine resumes them when it starts, and they would
        share the GPU with this run's render and its stage times."""
        assert self.client is not None
        leftovers = outstanding_jobs(self.client.get("/jobs") or [])
        for job in leftovers:
            try:
                self.client.post(f"/jobs/{job['id']}/cancel")
            except EngineError as exc:
                if exc.unreachable:
                    raise
        if leftovers:
            projects = sorted({str(job.get("project_id")) for job in leftovers})
            note = (
                f"cancelled {len(leftovers)} job(s) an earlier run left queued, in "
                f"project {_listed(projects)}"
            )
            self.notes.append(note)
            say(note)

    def programs(self) -> dict[str, dict]:
        assert self.client is not None
        return {row["id"]: row for row in self.client.get("/programs")["programs"]}

    def bring_programs_and_models(self) -> None:
        """Set up what is missing or not the pinned build, download the
        recommended models the data dir lacks, then wait for the servers."""
        assert self.client is not None
        began = time.monotonic()
        wanted = ["ffmpeg", "comfyui"] + (["ollama"] if self.args.script_model else [])
        report = self.client.get("/programs")
        rows = {row["id"]: row for row in report["programs"]}
        to_set_up = []
        for program in wanted:
            row = rows[program]
            if program_ready(row):
                self.setup["programs"].append(
                    {"id": program, "action": "kept", "version": row["managed"]["version"]}
                )
            elif not row["setup"].get("available"):
                raise self.fail(
                    "programs",
                    f"LocalCut has no {program} build to set up here "
                    f"({row['setup'].get('unavailable_reason')})",
                )
            else:
                to_set_up.append(row)

        system = self.client.get("/system")
        hardware = system.get("hardware") or {}
        gpu = hardware.get("primary_gpu") or {}
        self.versions["gpu"] = {
            "name": gpu.get("name"),
            "vram_gb": gpu.get("vram_gb"),
            "driver": gpu.get("driver_version"),
            "compute_capability": gpu.get("compute_capability"),
            "tier": hardware.get("tier"),
        }
        recommendations = system.get("recommendations") or []
        models = self.client.get("/models")
        to_download = models_to_download(recommendations, models)
        for row in recommended_downloads(recommendations, models):
            if row["downloaded"]:
                self.setup["models"].append({"id": row["id"], "action": "kept", "bytes": 0})

        self.announce(wanted, to_set_up, to_download, report.get("disk_free_bytes") or 0)
        jobs = self.start_setups(to_set_up)
        downloading = set()
        for row in to_download:
            if self.client.post(f"/models/{row['id']}/download")["status"] != "downloaded":
                downloading.add(row["id"])
        failures = self.wait_for_downloads(jobs, downloading, {r["id"]: r for r in to_download})
        if failures:
            raise self.fail("setup", "; ".join(failures))
        self.wait_for_servers(wanted)
        self.setup["seconds"] = round(time.monotonic() - began, 1)
        self.confirm_programs(wanted)
        self.confirm_models(recommendations)

    def announce(
        self, wanted: list[str], to_set_up: list[dict], to_download: list[dict], free: int
    ) -> None:
        """Say what is about to download. Refuse a set that cannot fit."""
        if not (to_set_up or to_download):
            say(
                f"Nothing to download: {_listed(wanted)} are the builds pinned now and the "
                f"{len(self.setup['models'])} recommended models are on disk."
            )
            return
        say("Downloads before the render:")
        needed = 0
        for row in to_set_up:
            setup = row["setup"]
            pull = setup.get("pull") or {}
            if (row.get("managed") or {}).get("current"):
                # The copy is the pinned build already: the setup only
                # starts it, or pulls the script model into it.
                say(
                    f"  {row['id']}: start it"
                    + (f", pull {_size(pull.get('bytes'))}" if pull else "")
                )
                needed += pull.get("bytes") or 0
                continue
            line = (
                f"  {row['id']} {setup.get('version')}: {_size(setup.get('download_bytes'))} "
                f"download, {_size(setup.get('install_bytes'))} installed"
            )
            if pull:
                line += f", then {pull.get('model')}, {_size(pull.get('bytes'))}"
            say(line)
            needed += (setup.get("download_bytes") or 0) + (setup.get("install_bytes") or 0)
            needed += pull.get("bytes") or 0
        for row in to_download:
            partial = row.get("partial_bytes") or 0
            resumed = f", {_size(partial)} of it on disk already" if partial else ""
            say(f"  model {row['id']}: {_size(row['size_bytes'])}{resumed}")
            needed += row["size_bytes"] - partial
        say(f"  about {_size(needed)} in all, of the {_size(free)} free in {self.data_dir}")
        if free and needed > free:
            raise self.fail(
                "setup",
                f"the downloads need about {_size(needed)}; {self.data_dir} has {_size(free)}",
            )

    def start_setups(self, to_set_up: list[dict]) -> dict[str, str]:
        """POST /programs/{id}/setup for each. Returns the setup jobs
        that started, by program."""
        assert self.client is not None
        jobs: dict[str, str] = {}
        for row in to_set_up:
            started = self.client.post(f"/programs/{row['id']}/setup")
            if started.get("status") == "started":
                jobs[row["id"]] = started["job"]
            current = (row.get("managed") or {}).get("current")
            fetched = 0 if current or row["id"] not in jobs else row["setup"]["download_bytes"]
            self.setup["downloaded_bytes"] += fetched
            self.setup["programs"].append(
                {
                    "id": row["id"],
                    "action": "set_up" if row["id"] in jobs else "kept",
                    "version": row["setup"].get("version"),
                    "bytes": fetched,
                }
            )
        return jobs

    def confirm_programs(self, wanted: list[str]) -> None:
        """The engine runs LocalCut's copy of each program, the build
        pinned now, not something that outranks it."""
        rows = self.programs()
        problems = []
        for program in wanted:
            row = rows[program]
            if row.get("source") != "managed" or not (row.get("managed") or {}).get("current"):
                problems.append(
                    f"the engine uses the {program} at {row.get('location')} "
                    f"({row.get('source')}), not LocalCut's copy of the build pinned now"
                )
        self.versions["ffmpeg"] = rows["ffmpeg"].get("version")
        self.versions["ollama"] = rows["ollama"].get("version")
        if problems:
            raise self.fail("programs", "; ".join(problems))
        self.ffmpeg = Path(rows["ffmpeg"]["location"])
        self.passed(
            check(
                "programs",
                True,
                _listed([f"{p} {rows[p].get('version')}" for p in wanted])
                + ", LocalCut's copies of the builds pinned now",
                **{p: rows[p].get("version") for p in wanted},
            )
        )

    def confirm_models(self, recommendations: list[dict]) -> None:
        assert self.client is not None
        recommended = recommended_downloads(recommendations, self.client.get("/models"))
        missing = [row["id"] for row in recommended if not row["downloaded"]]
        if missing:
            raise self.fail("models", f"not on disk: {', '.join(missing)}")
        names = [row["id"] for row in recommended]
        self.passed(check("models", True, "on disk: " + _listed(names), models=names))

    def wait_for_downloads(
        self, jobs: dict[str, str], downloading: set[str], sizes: dict[str, dict]
    ) -> list[str]:
        """Until every setup in `jobs` has ended and every model in
        `downloading` is on disk or has stopped. Returns what failed."""
        assert self.client is not None
        failures: list[str] = []
        shown: dict[str, str] = {}
        deadline = time.monotonic() + self.args.setup_timeout
        while jobs or downloading:
            if jobs:
                rows = self.programs()
                for program, job in list(jobs.items()):
                    setup = rows[program]["setup"]
                    last = setup.get("last") or {}
                    if last.get("job") == job:
                        del jobs[program]
                        if last.get("outcome") == "done":
                            say(f"  {program}: set up")
                        else:
                            failures.append(
                                f"setting up {program} {last.get('outcome')} "
                                f"({last.get('reason')}): {last.get('error')}"
                            )
                            say(f"  {program}: {failures[-1]}")
                        continue
                    running = setup.get("job")
                    if running:
                        line = f"  {program}: {running['phase']}"
                        if running.get("total"):
                            tenth = min(10, int(10 * running["done"] / running["total"]))
                            line += f" {_size(tenth * running['total'] // 10)} of {_size(running['total'])}"
                        if line != shown.get(program):
                            shown[program] = line
                            say(line)
            if downloading:
                models = {row["id"]: row for row in self.client.get("/models")}
                for model in list(downloading):
                    row = models[model]
                    if row["downloaded"]:
                        downloading.discard(model)
                        fetched = row["size_bytes"] - (sizes[model].get("partial_bytes") or 0)
                        self.setup["downloaded_bytes"] += fetched
                        self.setup["models"].append(
                            {"id": model, "action": "downloaded", "bytes": fetched}
                        )
                        say(f"  model {model}: downloaded")
                    elif not row["downloading"]:
                        downloading.discard(model)
                        failures.append(
                            f"the download of {model} stopped with {_size(row.get('partial_bytes'))} "
                            f"of {_size(row['size_bytes'])} on disk; run the check again to resume it"
                        )
                        say(f"  model {model}: {failures[-1]}")
                    elif row.get("progress") and row["progress"].get("total"):
                        progress = row["progress"]
                        tenth = min(10, int(10 * progress["done"] / progress["total"]))
                        line = f"  model {model}: {_size(tenth * progress['total'] // 10)} of {_size(progress['total'])}"
                        if line != shown.get(model):
                            shown[model] = line
                            say(line)
            if not (jobs or downloading):
                break
            if time.monotonic() >= deadline:
                failures.append(
                    f"still downloading after {self.args.setup_timeout:.0f} s: "
                    + ", ".join([*jobs, *downloading])
                )
                break
            time.sleep(POLL_S)
        return failures

    def wait_for_servers(self, wanted: list[str]) -> None:
        """Until LocalCut's copy of each server program answers."""
        servers = [program for program in wanted if program != "ffmpeg"]
        deadline = time.monotonic() + SERVER_READY_TIMEOUT_S
        waiting_said = False
        while servers:
            rows = self.programs()
            for program in list(servers):
                row = rows[program]
                server = (row.get("managed") or {}).get("server") or {}
                if row["state"] == "ready" and row.get("source") == "managed":
                    servers.remove(program)
                    say(f"  {program}: running at {row.get('location')}")
                elif server.get("state") == "crashed":
                    raise self.fail(
                        "programs",
                        f"LocalCut's {program} crashed ({server.get('reason')}): {server.get('error')}",
                    )
            if not servers:
                break
            if not waiting_said:
                say(f"Waiting for {', '.join(servers)} to answer")
                waiting_said = True
            if time.monotonic() >= deadline:
                raise self.fail(
                    "programs",
                    f"{', '.join(servers)} did not answer within {SERVER_READY_TIMEOUT_S:.0f} s",
                )
            time.sleep(POLL_S)
        self.engine.track()  # type: ignore[union-attr]

    def check_object_info(self) -> None:
        assert self.engine is not None
        url = self.engine.comfyui_url
        try:
            object_info = httpx.get(f"{url}/object_info", timeout=120).json()
            stats = httpx.get(f"{url}/system_stats", timeout=30).json()
        except (httpx.HTTPError, ValueError) as exc:
            raise self.fail("object_info", f"could not read ComfyUI at {url}: {exc}") from exc
        system = stats.get("system") or {}
        self.versions["comfyui"] = system.get("comfyui_version")
        self.versions["comfyui_python"] = (
            str(system.get("python_version") or "").split(" ")[0] or None
        )
        self.versions["torch"] = system.get("pytorch_version")
        devices = stats.get("devices") or []
        if devices:
            self.versions["comfyui_device"] = devices[0].get("name")
        entry = object_info_check(template_requirements(load_templates()), object_info)
        self.passed(entry)
        if not entry["passed"]:
            raise Stop(entry["detail"])

    def render(self) -> None:
        assert self.client is not None and self.engine is not None
        say(f'Rendering "{self.args.prompt}", {self.args.duration} s, {self.args.aspect}')
        created_at = time.time()
        project = self.client.post(
            "/projects",
            json={
                "prompt": self.args.prompt,
                "aspect": self.args.aspect,
                "target_duration_s": self.args.duration,
            },
        )
        project_id = project["id"]
        self.project = {"id": project_id, "created_at": created_at}
        self.client.post(f"/projects/{project_id}/render")
        reported: set[str] = set()
        deadline = time.monotonic() + self.args.timeout
        while True:
            jobs = self.client.get("/jobs", params={"project_id": project_id}) or []
            # Kept at every poll, so a report on an interrupted render
            # still says how far it got.
            self.stages = stage_rows(jobs)
            for job in jobs:
                if job["status"] in ("done", "failed", "cancelled") and job["id"] not in reported:
                    reported.add(job["id"])
                    row = stage_rows([job])[0]
                    say(
                        f"  {row['node']}: {row['status']} on {row['backend'] or '-'}"
                        + (f" in {_duration(row['seconds'])}" if row["seconds"] is not None else "")
                        + (f" ({row['error']})" if row["error"] else "")
                    )
            if not outstanding_jobs(jobs):
                break
            if time.monotonic() >= deadline:
                raise self.fail(
                    "render",
                    f"still rendering after {self.args.timeout:.0f} s, "
                    f"{len(outstanding_jobs(jobs))} job(s) outstanding",
                )
            self.engine.track()
            time.sleep(POLL_S)
        self.stages = stage_rows(jobs)
        self.jobs = jobs
        unfinished = unfinished_jobs(jobs, not_mine=frozenset())
        if unfinished:
            raise self.fail(
                "render",
                "; ".join(
                    f"{job['spec']['node_id']} {job['status']}: {job.get('error') or '-'}"
                    for job in unfinished
                ),
            )
        artifact = finished_cut_hash(self.client, project_id)
        if artifact is None:
            raise self.fail("render", "the project has no finished cut")
        export = self.report_dir / "export.mp4"
        written = self.client.download(f"/projects/{project_id}/artifacts/{artifact}", export)
        self.project.update({"export": export.name, "export_bytes": written})
        render_s = max(row["finished_at"] or 0 for row in self.stages) - created_at
        self.passed(
            check(
                "render",
                True,
                f"{len(self.stages)} jobs done, create to finished export in {_duration(render_s)}",
            )
        )
        self.passed(backends_check(self.stages, self.expected_backends))

    @property
    def expected_backends(self) -> dict[str, str]:
        return {"script": "llm" if self.args.script_model else "mock", **EXPECTED_BACKENDS}

    def artifact(self, job: dict, name: str) -> Path:
        assert self.client is not None
        suffix = Path(job.get("artifact") or "").suffix
        path = self.report_dir / f"{name}{suffix}"
        self.client.download(
            f"/projects/{self.project['id']}/artifacts/{job['spec']['output_hash']}", path
        )
        return path

    def ffprobe(self, path: Path) -> dict:
        assert self.ffmpeg is not None
        probe = self.ffmpeg.with_name("ffprobe" + self.ffmpeg.suffix)
        result = _run(
            [str(probe), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)]
        )
        try:
            return json.loads(result.stdout or "{}")
        except ValueError:
            return {}

    def ffmpeg_stderr(self, *args: str) -> str:
        assert self.ffmpeg is not None
        result = _run([str(self.ffmpeg), "-hide_banner", "-nostats", *args])
        return result.stderr

    def verify(self) -> None:
        assert self.ffmpeg is not None
        export = self.report_dir / self.project["export"]
        version = _run([str(self.ffmpeg), "-version"]).stdout.split("\n", 1)[0]
        self.versions["ffmpeg_build"] = (
            version.removeprefix("ffmpeg version ").split(" ")[0] or None
        )

        probe = self.ffprobe(export)
        size = EXPORT_RESOLUTIONS[self.args.aspect]
        self.passed(streams_check(probe, target_s=self.args.duration, size=size))

        frames = self.report_dir / "frames"
        frames.mkdir(exist_ok=True)
        duration = _seconds((probe.get("format") or {}).get("duration")) or 0.0
        for point in FRAME_POINTS:
            self.ffmpeg_stderr(
                "-y",
                "-ss",
                f"{duration * point:.3f}",
                "-i",
                str(export),
                "-frames:v",
                "1",
                str(frames / f"export-{round(point * 100):02d}.png"),
            )

        (self.report_dir / "clips").mkdir(exist_ok=True)
        for job in finished_by_node(self.jobs, "clip"):
            node = job["spec"]["node_id"]
            path = self.artifact(job, f"clips/{node}")
            clip = self.ffprobe(path)
            video = next(
                (s for s in clip.get("streams") or [] if s.get("codec_type") == "video"), {}
            )
            length = _seconds(video.get("duration")) or _seconds(
                (clip.get("format") or {}).get("duration")
            )
            stderr = self.ffmpeg_stderr(
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-vf",
                f"freezedetect=n={FREEZE_NOISE_DB}dB:d={FREEZE_MIN_S:g}",
                "-f",
                "null",
                "-",
            )
            freezes = parse_freezes(stderr, length or 0.0)
            first, last = frames / f"{node}-first.png", frames / f"{node}-last.png"
            self.ffmpeg_stderr("-y", "-i", str(path), "-frames:v", "1", str(first))
            self.ffmpeg_stderr("-y", "-sseof", "-0.5", "-i", str(path), "-update", "1", str(last))
            psnr = parse_psnr(
                self.ffmpeg_stderr(
                    "-i", str(first), "-i", str(last), "-lavfi", "psnr", "-f", "null", "-"
                )
            )
            self.passed(
                motion_check(
                    node,
                    duration_s=length,
                    frames=video.get("nb_frames"),
                    freezes=freezes,
                    psnr_db=psnr,
                )
            )

        music = finished_by_node(self.jobs, "music")
        if not music:
            self.passed(check("music", False, "no music was rendered"))
        for job in music:
            path = self.artifact(job, "music")
            volume = parse_volume(
                self.ffmpeg_stderr("-i", str(path), "-af", "volumedetect", "-f", "null", "-")
            )
            self.passed(
                loudness_check(
                    "music", volume, min_mean_db=MUSIC_MIN_MEAN_DB, min_peak_db=MUSIC_MIN_PEAK_DB
                )
            )

        volume = parse_volume(
            self.ffmpeg_stderr(
                "-i", str(export), "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"
            )
        )
        self.passed(
            loudness_check("mix", volume, min_mean_db=MIX_MIN_MEAN_DB, min_peak_db=MIX_MIN_PEAK_DB)
        )

    def save_comfyui_log(self) -> None:
        """What LocalCut's ComfyUI printed during this run, from the end of
        its log the engine serves, which also holds earlier runs'."""
        assert self.client is not None and self.engine is not None
        path = self.report_dir / "comfyui.log"
        self.client.download("/programs/comfyui/log", path)
        text = path.read_text(encoding="utf-8", errors="replace")
        path.write_text(this_runs_log(text, self.engine.comfyui_url), encoding="utf-8")

    # -- the end -------------------------------------------------------------------

    def finish(self) -> int:
        if self.engine is not None and self.engine.process is not None:
            if self.client is not None and self.engine.process.poll() is None:
                try:
                    self.save_comfyui_log()
                except EngineError:
                    pass
            if (
                self.args.keep_running
                and not self.interrupted
                and self.engine.process.poll() is None
            ):
                self.notes.append("the engine was left running (--keep-running)")
            else:
                say("Stopping the engine")
                self.passed(self.engine.stop(self.client))
        if self.client is not None:
            self.client.close()
        report = build_report(
            started=self.started,
            finished=time.time(),
            request=self.request,
            versions=self.versions,
            setup=self.setup,
            project=self.project,
            stages=self.stages,
            checks=self.checks,
            unreachable=self.unreachable,
            notes=self.notes,
        )
        (self.report_dir / "report.json").write_text(
            json.dumps(json_safe(report), indent=2) + "\n", encoding="utf-8"
        )
        summary = summary_markdown(report)
        (self.report_dir / "summary.md").write_text(summary, encoding="utf-8")
        say()
        say(summary)
        say(f"Report: {self.report_dir}")
        if self.args.keep_running and self.engine is not None and self.engine.process is not None:
            if self.engine.process.poll() is None:
                say(f"The engine is still running at {self.engine.url}, token {self.engine.token}.")
                say(
                    f"Stop it with: curl -X POST -H 'Authorization: Bearer {self.engine.token}' "
                    f"{self.engine.url}/shutdown"
                )
        return report["exit_status"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="real-render-check",
        description="Render one real project through an engine from this checkout and check it.",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DEFAULT_DATA_DIR,
        help=f"where the programs, models, projects and reports live (default {DEFAULT_DATA_DIR})",
    )
    parser.add_argument(
        "--keep-running",
        action="store_true",
        help="leave the engine and its servers running afterwards and print how to reach it",
    )
    parser.add_argument(
        "--script-model",
        default=None,
        help="set up LocalCut's own Ollama, pull this model into it and write the script with it "
        "(default: the script comes from the mock)",
    )
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--duration", type=int, default=DEFAULT_DURATION_S, help="seconds")
    parser.add_argument("--aspect", default=DEFAULT_ASPECT, choices=sorted(EXPORT_RESOLUTIONS))
    parser.add_argument(
        "--timeout",
        type=float,
        default=3600.0,
        help="seconds the render may take before the check gives up (default 3600)",
    )
    parser.add_argument(
        "--setup-timeout",
        type=float,
        default=6 * 3600.0,
        help="seconds the setups and model downloads may take (default 21600)",
    )
    args = parser.parse_args(argv)
    # What the engine and the programs report (an error, a device name, the
    # prompt itself) can hold characters a Windows console's code page lacks.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            pass

    data_dir = args.data_dir.expanduser().resolve()
    if data_dir == (Path.home() / ".localcut").resolve():
        parser.error("--data-dir must not be ~/.localcut, the data dir the app itself uses")
    package = Path(localcut_engine.__file__).resolve()
    if not package.is_relative_to(ENGINE / "src"):
        print(
            f"error: this Python imports localcut_engine from {package.parent}, not from this "
            f"checkout. Run the check with `uv run` from {ENGINE}.",
            file=sys.stderr,
        )
        return EXIT_UNREACHABLE

    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    report_dir = data_dir / "reports" / stamp
    report_dir.mkdir(parents=True, exist_ok=False)
    run = Run(args, data_dir, report_dir)
    try:
        run.execute()
    except KeyboardInterrupt:
        run.interrupted = True
        run.checks.append(check("interrupted", False, "the check was interrupted"))
        say("interrupted")
    return run.finish()


if __name__ == "__main__":
    sys.exit(main())
