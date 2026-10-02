"""Makes a frozen engine narrate and caption, and fails unless it really did.

`localcut --version` proves the freeze starts. It cannot prove the freeze does
the work an installer exists for, because PyInstaller collects a package's
modules and leaves behind any file the package reads from beside them. An
engine missing kokoro-onnx's vocabulary or espeak-ng's voice data starts,
serves, answers `--version`, and fails every narration it is given.

So this runs the path a first render takes, through the frozen binary and
nothing else: its own `download` command fetches the weights, `serve` runs the
engine, and `create` and `render` drive it. The verdict is read off the job
rows rather than off `render`'s exit status. Everything except speech renders
on the mock backend here, and a failure in that part of the graph says nothing
about whether the installer can speak.

The chain is kokoro,align,ffmpeg,mock, with ffmpeg in it because captions are
aligned against the timeline. Mock declines to assemble a timeline in any chain
that is not mock alone, so without ffmpeg the captions job never starts.

Usage, from engine/ after `pyinstaller localcut.spec`, with ffmpeg and ffprobe
on PATH:

    uv run python packaging/speech_check.py dist/localcut/localcut --data-dir DIR

Weights land in DIR/models. A file already there with the manifest's checksum
is not downloaded again, which is what lets CI restore them from a cache.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
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
#: The timeline is in the list because it is what the captions read.
ROUTES = {"narration": "kokoro", "timeline": "ffmpeg", "captions": "align"}

#: Sixteen seconds is two scenes in the mock screenplay: two narrations to
#: synthesise and two to align, which is the whole path at the least cost.
PROMPT = "a short film about bees"
DURATION_S = 16

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


def _render_and_judge(
    binary: Path, base: str, token: str, env: dict[str, str], timeout_s: float
) -> list[str]:
    """Create a project, render it, and return everything that went wrong."""
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
            if kind != "captions":
                continue
            # A timeline with no narrated segments aligns nothing and still
            # publishes an SRT, so `done` alone does not prove whisper ran.
            artifact = f"{base}/projects/{project_id}/artifacts/{job['spec']['output_hash']}"
            cues = _get(artifact, token).decode("utf-8", "replace").count("-->")
            say(f"{job['spec']['node_id']} wrote {cues} caption cue(s)")
            if not cues:
                problems.append(f"{job['spec']['node_id']} wrote an SRT with no cues")
    return problems


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
            problems = _render_and_judge(binary, base, token, env, args.timeout)
        except (CheckFailed, OSError, ValueError, KeyError) as exc:
            problems = [f"{type(exc).__name__}: {exc}"]
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
    say(f"PASS: the frozen engine narrated and captioned, {elapsed:.0f}s in all")
    return 0


if __name__ == "__main__":
    sys.exit(main())
