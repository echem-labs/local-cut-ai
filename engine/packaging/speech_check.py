"""Makes a frozen engine render and export a video, and fails unless it really did.

`localcut --version` proves the freeze starts. It cannot prove the freeze does
the work an installer exists for, because PyInstaller collects a package's
modules and leaves behind any file the package reads from beside them. An
engine missing kokoro-onnx's vocabulary or espeak-ng's voice data starts,
serves, answers `--version`, and fails every narration it is given.

So this runs the path a first video takes, through the frozen binary and
nothing else: its own `download` command fetches the weights, `serve` runs the
engine, `create` and `render` drive it, and `export` writes the cut to disk.
The verdict on the render is read off the job rows rather than off `render`'s
exit status. The script, keyframes and music render on the mock backend here,
and a failure in that part of the graph says nothing about whether the
installer can make a video.

The chain is kokoro,align,ffmpeg,mock, with ffmpeg in it because captions are
aligned against the timeline and the export is cut from it. Mock declines to
assemble a timeline in any chain that is not mock alone, so without ffmpeg the
captions job never starts.

The cut itself is judged as a file, because its job row cannot say enough.
ffmpeg burns the titles and captions in through libass, reading an ASS document
from the temp dir and fonts from the install folder, and on Windows both sit
under the user's profile. A path the filtergraph misreads fails the export,
but a font libass cannot open draws nothing while ffmpeg exits 0. So the file
has to carry a picture and a soundtrack as long as the timeline, decode to its
last frame, and show a title and a caption where the timeline puts them.

Usage, from engine/ after `pyinstaller localcut.spec`, with ffmpeg and ffprobe
on PATH:

    uv run python packaging/speech_check.py dist/localcut/localcut --data-dir DIR

Weights land in DIR/models and the cut in DIR. A file already there with the
manifest's checksum is not downloaded again, which is what lets CI restore
them from a cache.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CHAIN = "kokoro,align,ffmpeg,mock"

#: Fetched through the frozen binary, so its download path is exercised too.
WEIGHTS = ("kokoro-82m", "faster-whisper-base-en")

#: Who has to serve each kind for the run to count. kokoro and align claim
#: their kinds only while their weights are on disk, and align and ffmpeg only
#: while an ffmpeg binary can be found. When a claim lapses the kind falls
#: through to mock, which renders it "successfully" and proves nothing, so a
#: `done` status means something here only beside the backend that produced it.
#: The timeline is in the list because it is what the captions read, and the
#: export because it is the video.
ROUTES = {"narration": "kokoro", "timeline": "ffmpeg", "captions": "align", "export": "ffmpeg"}

#: Sixteen seconds is two scenes in the mock screenplay: two narrations to
#: synthesise and two to align, which is the whole path at the least cost. The
#: first scene carries an on-screen title and the second does not, which is
#: what the drawn-text measurement below needs.
PROMPT = "a short film about bees"
DURATION_S = 16

#: Brighter than this on a 0-255 grey scale counts as lit, the measure the
#: engine's own assembly tests use. Titles and captions are white. The mock's
#: slates are deep colours whose brightest channel is a third of full scale,
#: so a frame of slate alone lights nothing.
LIT = 127

#: Fewer lit pixels than this in half a frame is no text drawn there. At the
#: export's size the narrowest caption, a lone capital I, lights 500, and a
#: five-word cue lights over 10000.
DRAWN = 250

#: ffmpeg crop windows (w:h:x:y). A title hangs from 14% of the frame height
#: and captions stand on a bottom margin, so each keeps to its own half.
TOP_HALF = "iw:ih/2:0:0"
BOTTOM_HALF = "iw:ih/2:0:ih/2"

#: The shortest stretch with no caption on screen that a bare frame may come
#: from. Its middle is then two frames clear of either cue at 24 fps.
BARE_STRETCH_S = 0.2

#: How far the soundtrack, the picture and the timeline may disagree on
#: length. An encoder pads the last packet by a frame or two. A scene or a
#: line that went missing is seconds.
LENGTH_SLACK_S = 0.25

#: Matches the timing line of an SRT cue.
_SRT_TIMING = re.compile(r"(\d+):(\d\d):(\d\d)[,.](\d{3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{3})")

#: What kokoro-onnx logs when the espeak-ng library inside espeakng_loader does
#: not load. It then falls back to whatever espeak-ng the machine has, so a
#: narration that succeeds after this line proves the build machine has
#: espeak-ng installed rather than that the installer carries it.
FALLBACK_MARKER = "Failed to load espeak shared library"

_LOG_TAIL = 80


class CheckFailed(Exception):
    """A failure that ends the run before there are job rows to read."""


def say(text: str) -> None:
    """Print ASCII only. A Windows runner's stdout is the ANSI code page when
    it is a pipe, and neither the narration text nor every engine error is
    ASCII."""
    print(text.encode("ascii", "backslashreplace").decode("ascii"), flush=True)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _cli(binary: Path, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[bytes]:
    """Run one frozen CLI command, echoing what it printed.

    Less httpx's line per request: a render polls every two seconds, and a
    weights download logs each signed redirect URL it follows.
    """
    say(f"$ localcut {' '.join(args)}")
    result = subprocess.run([str(binary), *args], env=env, capture_output=True, check=False)
    for stream in (result.stdout, result.stderr):
        for line in stream.decode("utf-8", "replace").splitlines():
            if " httpx HTTP Request: " not in line:
                say(f"  | {line}")
    return result


def _get(url: str, token: str) -> bytes:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def _wait_until_serving(base: str, engine: subprocess.Popen, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if engine.poll() is not None:
            raise CheckFailed(f"the engine exited with status {engine.returncode} before serving")
        try:
            with urllib.request.urlopen(f"{base}/health", timeout=5) as response:
                if response.status == 200:
                    return
        except OSError:  # URLError is one; refused and reset arrive as either
            pass
        time.sleep(0.5)
    raise CheckFailed(f"the engine did not answer /health within {timeout_s:.0f}s")


def _stop(engine: subprocess.Popen) -> None:
    if engine.poll() is not None:
        return
    engine.terminate()
    try:
        engine.wait(timeout=30)
    except subprocess.TimeoutExpired:
        engine.kill()
        engine.wait()


def _cue_times(srt: str) -> list[tuple[float, float]]:
    """Every cue's (start, end), in seconds."""

    def seconds(h: str, m: str, s: str, ms: str) -> float:
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

    return [
        (seconds(*match.group(1, 2, 3, 4)), seconds(*match.group(5, 6, 7, 8)))
        for match in _SRT_TIMING.finditer(srt)
    ]


def _uncaptioned(
    start: float, end: float, cues: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    """The stretches of `start`..`end` that no cue covers."""
    stretches: list[tuple[float, float]] = []
    cursor = start
    for cue_start, cue_end in sorted(cues):
        if cue_start > cursor:
            stretches.append((cursor, min(cue_start, end)))
        cursor = max(cursor, cue_end)
        if cursor >= end:
            break
    if cursor < end:
        stretches.append((cursor, end))
    return [(a, b) for a, b in stretches if b > a]


def _frames_to_read(
    edl: dict, cues: list[tuple[float, float]]
) -> tuple[float | None, float | None]:
    """Two moments in the cut: one with a title and a caption on screen, the
    middle of the first cue inside a titled scene, and one with neither, the
    middle of the longest stretch of an untitled scene that no cue covers.

    The bare frame is what makes the other one evidence. It has the same kind
    of slate behind it, so if it lights up, the slates are bright enough to
    pass for text and a lit half frame proves nothing."""
    drawn: float | None = None
    bare: tuple[float, float] | None = None
    for segment in edl["video"]:
        start = float(segment["start"])
        end = start + float(segment["duration"])
        if segment.get("onscreen_text"):
            inside = [(a, b) for a, b in cues if start <= a and b <= end]
            if drawn is None and inside:
                drawn = (inside[0][0] + inside[0][1]) / 2
            continue
        for stretch in _uncaptioned(start, end, cues):
            if bare is None or stretch[1] - stretch[0] > bare[1] - bare[0]:
                bare = stretch
    if bare is None or bare[1] - bare[0] < BARE_STRETCH_S:
        return drawn, None
    return drawn, (bare[0] + bare[1]) / 2


def _lit(cut: Path, at: float, window: str) -> int | None:
    """Pixels brighter than LIT in the frame `at` seconds into `cut`, inside
    the crop `window`. None when no frame decodes there."""
    frame = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{at:.3f}", "-i", str(cut), "-vf", f"crop={window}"]
        + ["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
        capture_output=True,
        check=False,
    )
    if frame.returncode or not frame.stdout:
        return None
    return sum(1 for value in frame.stdout if value > LIT)


def _stream_lengths(cut: Path) -> dict[str, float | None]:
    """The length of the first video and the first audio stream in `cut`, by
    kind. A kind with no stream is missing; one ffprobe cannot time is None."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration"]
        + ["-of", "json", str(cut)],
        capture_output=True,
        check=False,
    )
    lengths: dict[str, float | None] = {}
    for stream in json.loads(probe.stdout or b"{}").get("streams", []):
        kind = stream.get("codec_type")
        if kind in ("video", "audio") and kind not in lengths:
            try:
                lengths[kind] = float(stream["duration"])
            except (KeyError, ValueError):  # ffprobe prints N/A for an untimed stream
                lengths[kind] = None
    return lengths


def _judge_cut(
    binary: Path, env: dict[str, str], project_id: str, cut: Path, edl: dict, srt: str
) -> list[str]:
    """Export the project to `cut` through the frozen CLI, and return
    everything wrong with the file."""
    exported = _cli(binary, "export", project_id, "--out", str(cut), env=env)
    if exported.returncode:
        return [f"`export` exited {exported.returncode}"]

    problems: list[str] = []
    lengths = _stream_lengths(cut)
    picture, sound = lengths.get("video"), lengths.get("audio")
    program = float(edl["duration"])
    if picture is None or sound is None:
        problems.append(
            f"the cut needs a timed video stream and a timed audio stream, and ffprobe "
            f"read {lengths or 'neither'}"
        )
    else:
        say(f"the cut runs {picture:.2f}s of picture and {sound:.2f}s of sound")
        say(f"the timeline runs {program:.2f}s")
        if abs(sound - picture) > LENGTH_SLACK_S:
            problems.append(f"the soundtrack runs {sound:.2f}s against {picture:.2f}s of picture")
        if abs(picture - program) > LENGTH_SLACK_S:
            problems.append(f"the picture runs {picture:.2f}s against a {program:.2f}s timeline")

    # Every frame, not only the header ffprobe reads.
    decode = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(cut), "-f", "null", "-"],
        capture_output=True,
        check=False,
    )
    errors = decode.stderr.decode("utf-8", "replace").strip()
    if decode.returncode or errors:
        problems.append(
            f"the cut does not decode to its last frame (ffmpeg exited {decode.returncode}): "
            f"{errors[-400:]}"
        )
    else:
        say("every frame of the cut decodes")

    drawn_at, bare_at = _frames_to_read(edl, _cue_times(srt))
    if drawn_at is None:
        problems.append("no caption cue lies inside a titled scene, so no frame shows both")
    if bare_at is None:
        problems.append(
            f"no untitled scene goes {BARE_STRETCH_S}s without a caption, so no frame shows "
            "what the slates light alone"
        )
    if drawn_at is None or bare_at is None:
        return problems
    title, caption = _lit(cut, drawn_at, TOP_HALF), _lit(cut, drawn_at, BOTTOM_HALF)
    bare_top, bare_bottom = _lit(cut, bare_at, TOP_HALF), _lit(cut, bare_at, BOTTOM_HALF)
    say(f"lit pixels at {drawn_at:.2f}s, title and caption: {title} top, {caption} bottom")
    say(f"lit pixels at {bare_at:.2f}s, neither: {bare_top} top, {bare_bottom} bottom")
    if title is None or caption is None or bare_top is None or bare_bottom is None:
        problems.append(f"ffmpeg decoded no frame at {drawn_at:.2f}s or {bare_at:.2f}s")
    elif bare_top or bare_bottom:
        problems.append(
            f"the frame at {bare_at:.2f}s has no title or caption and still lights "
            f"{bare_top + bare_bottom} pixels: the slates are bright enough to pass for "
            "text, so a lit frame is no evidence that any was drawn"
        )
    else:
        if title < DRAWN:
            problems.append(
                f"the title drew nothing: {title} lit pixels in the top half at {drawn_at:.2f}s"
            )
        if caption < DRAWN:
            problems.append(
                f"the burned-in captions drew nothing: {caption} lit pixels in the bottom "
                f"half at {drawn_at:.2f}s"
            )
    return problems


def _render_and_judge(
    binary: Path, base: str, token: str, env: dict[str, str], timeout_s: float, cut: Path
) -> list[str]:
    """Create a project, render it, export it to `cut`, and return everything
    that went wrong."""
    system = json.loads(_get(f"{base}/system", token))
    routes = {task["kind"]: task["backend"] for task in system["backends"]["tasks"]}
    misrouted = [
        f"{kind} is routed to {routes.get(kind)!r}, not {backend!r}"
        for kind, backend in ROUTES.items()
        if routes.get(kind) != backend
    ]
    if misrouted:
        # Before the render rather than after it: a kind that fell through to
        # mock would come back done, and the reason would be lost.
        return [
            *misrouted,
            "a backend only claims its kind while its weights are on disk and, for "
            "align and ffmpeg, while ffmpeg and ffprobe are on PATH",
        ]

    created = _cli(binary, "create", PROMPT, "--duration", str(DURATION_S), "--json", env=env)
    if created.returncode:
        return [f"`create` exited {created.returncode}"]
    project_id = json.loads(created.stdout)["id"]

    rendered = _cli(binary, "render", project_id, "--timeout", f"{timeout_s:.0f}", env=env)
    say(f"render exited {rendered.returncode}; the verdict is the job rows below")

    jobs = json.loads(_get(f"{base}/jobs?project_id={project_id}", token))
    for job in sorted(jobs, key=lambda row: (row["spec"]["kind"], row["spec"]["node_id"])):
        say(
            f"  {job['spec']['kind']:10} {job['spec']['node_id']:16} {job['status']:9} "
            f"{job.get('backend') or '-':8} {(job.get('error') or '')[:160]}"
        )

    problems: list[str] = []
    # The EDL and the SRT, which say where in the cut a title and a caption
    # should be on screen.
    documents: dict[str, bytes] = {}
    for kind, backend in ROUTES.items():
        # One row per node, the newest. A node can hold several: the engine
        # starts scene work as soon as the script lands, and `render` enqueues
        # again whatever had failed by then, so the row that says how a node
        # ended is its last one.
        latest: dict[str, dict] = {}
        for job in jobs:
            node = job["spec"]["node_id"]
            if job["spec"]["kind"] == kind and (
                node not in latest or job["created_at"] >= latest[node]["created_at"]
            ):
                latest[node] = job
        if not latest:
            problems.append(f"no {kind} job ran at all")
        for job in latest.values():
            if job["status"] != "done" or job.get("backend") != backend:
                problems.append(
                    f"{job['spec']['node_id']} ({kind}) ended {job['status']} on "
                    f"{job.get('backend')!r}, not done on {backend!r}: {job.get('error') or ''}"
                )
                continue
            if kind not in ("timeline", "captions"):
                continue
            artifact = f"{base}/projects/{project_id}/artifacts/{job['spec']['output_hash']}"
            documents[kind] = _get(artifact, token)
            if kind != "captions":
                continue
            # A timeline with no narrated segments aligns nothing and still
            # publishes an SRT, so `done` alone does not prove whisper ran.
            cues = documents[kind].decode("utf-8", "replace").count("-->")
            say(f"{job['spec']['node_id']} wrote {cues} caption cue(s)")
            if not cues:
                problems.append(f"{job['spec']['node_id']} wrote an SRT with no cues")
    if problems:
        return problems
    return _judge_cut(
        binary,
        env,
        project_id,
        cut,
        json.loads(documents["timeline"]),
        documents["captions"].decode("utf-8", "replace"),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("binary", type=Path, help="the frozen engine, e.g. dist/localcut/localcut")
    parser.add_argument("--data-dir", type=Path, required=True, help="a fresh engine data dir")
    parser.add_argument(
        "--timeout", type=float, default=900.0, help="seconds the render may take (default 900)"
    )
    args = parser.parse_args(argv)

    binary = args.binary.resolve()
    data_dir = args.data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "engine.log"
    base = f"http://127.0.0.1:{_free_port()}"
    token = secrets.token_urlsafe(24)
    env = {**os.environ, "LOCALCUT_ENGINE_URL": base, "LOCALCUT_TOKEN": token}

    # Escaped by `say`, so a run under a non-ASCII folder shows which
    # characters the paths really carried.
    say(f"engine:   {binary}")
    say(f"data dir: {data_dir}")
    say(f"temp dir: {tempfile.gettempdir()}")
    if _cli(binary, "--version", env=env).returncode:
        say("FAIL: the frozen engine does not start from that folder")
        return 1

    started = time.monotonic()
    models_dir = str(data_dir / "models")
    for model in WEIGHTS:
        if _cli(binary, "download", model, "--models-dir", models_dir, env=env).returncode:
            say(f"FAIL: the frozen engine could not download {model}")
            return 1
    say(f"weights ready after {time.monotonic() - started:.0f}s")

    with log_path.open("wb") as log:
        engine = subprocess.Popen(
            [str(binary), "serve", "--backend", CHAIN, "--port", base.rsplit(":", 1)[1]]
            + ["--token", token, "--data-dir", str(data_dir)],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        try:
            _wait_until_serving(base, engine, timeout_s=120)
            problems = _render_and_judge(
                binary, base, token, env, args.timeout, cut=data_dir / f"{PROMPT}.mp4"
            )
        except (CheckFailed, OSError, ValueError, KeyError, TypeError) as exc:
            problems = [f"{type(exc).__name__}: {exc}"]
            if engine.poll() is not None and not isinstance(exc, CheckFailed):
                # A refused connection says nothing about why. An engine that
                # is gone does, and the log tail below shows how it went.
                problems.append(
                    f"the engine exited with status {engine.returncode} while the check "
                    "was driving it"
                )
        finally:
            _stop(engine)

    log_text = log_path.read_text(encoding="utf-8", errors="replace")
    if FALLBACK_MARKER in log_text:
        problems.append(
            "kokoro-onnx could not load the espeak-ng library the freeze carries and fell "
            "back to one installed on this machine - an installer without it cannot speak"
        )
    if problems:
        say(f"engine log, last {_LOG_TAIL} lines:")
        for line in log_text.splitlines()[-_LOG_TAIL:]:
            say(f"  | {line}")
        for problem in problems:
            say(f"FAIL: {problem}")
        return 1
    elapsed = time.monotonic() - started
    say(f"PASS: the frozen engine made a finished video, {elapsed:.0f}s in all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
