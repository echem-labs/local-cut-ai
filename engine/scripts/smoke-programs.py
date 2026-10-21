"""Set one of LocalCut's pinned programs up for real through the engine's
own routes and check that the copy works.

    cd engine
    uv run python scripts/smoke-programs.py ffmpeg --work <folder>
    uv run python scripts/smoke-programs.py ollama --work <folder>
    uv run python scripts/smoke-programs.py comfyui --work <folder>
    uv run python scripts/smoke-programs.py comfyui --card amd --work <folder>

programs-smoke.yml runs it on GitHub's Linux and Windows runners for a pull
request that changes a pin or the code that sets one up. It starts an engine
from this checkout with its data in <folder>, on ports nothing else uses,
and asks it what the desktop and the CLI ask it:

- ffmpeg: POST /programs/ffmpeg/setup. GET /programs has to report the
  pinned version, in use and drawing text. A project made on `local,mock`
  is rendered and exported. The MP4 has to hold a video and an audio
  stream that the copy's ffmpeg decodes to the end.
- ollama: the same setup with LOCALCUT_LLM_MODEL=qwen3:0.6b, which starts
  the copy and pulls that model into it. Then the copy has to answer a
  /v1/chat/completions request, on the processor.
- comfyui on Linux: the processor's build (`?build=cpu`), which the setup
  starts. Its /object_info has to name every node class and every input the
  workflow templates in comfy_templates/ use.
- comfyui on Windows: one portable build per run, picked by `--card` and
  `--build`. A runner has no graphics card, which stops a setup twice.
  First the hardware probe finds no card (it asks nvidia-smi, rocm-smi and
  xpu-smi, then the registry), so POST /programs/comfyui/setup answers 409
  gpu_not_supported before anything is downloaded. So the engine is started
  with a stand-in for that vendor's tool on its PATH, which reports a card.
  The setup then downloads the build and 7-Zip, holds both to their digests,
  lists the archive against the pin's tree, unpacks it, walks what landed
  and runs the device check, where the build's own Python imports its
  PyTorch and looks for the card. That is the second stop and the one this
  run expects: `gpu_not_usable`, naming the PyTorch it loaded. Every step
  before it ran on the real archive.

The stand-in is a program in this run's work folder, on the PATH of the
engine process this script starts and nowhere else. Nothing in the engine
knows of it. The API, the CLI and the desktop cannot put a program on the
engine's PATH, so there is no way to reach it from any of them. A user's
setup still needs the card.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import httpx

ENGINE = Path(__file__).resolve().parent.parent
TEMPLATES = ENGINE / "src" / "localcut_engine" / "comfy_templates"
MANIFEST = ENGINE / "src" / "localcut_engine" / "programs" / "programs-manifest.json"
MODEL = "qwen3:0.6b"

# What each vendor's stand-in prints, in the form the hardware probe reads.
# The NVIDIA card meets the usual build's driver and compute capability.
_STAND_INS = {
    "nvidia": (
        "nvidia-smi",
        "print('LocalCut smoke stand-in, 8192, 590.00, 8.9')",
    ),
    "amd": (
        "rocm-smi",
        "import json; print(json.dumps({'card0': {'Card Series': 'LocalCut smoke stand-in', "
        "'VRAM Total Memory (B)': str(16 << 30)}}))",
    ),
    "intel": (
        "xpu-smi",
        "import json; print(json.dumps({'device_list': [{'device_name': "
        "'LocalCut smoke stand-in', 'memory_physical_size_byte': 16 << 30}]}))",
    ),
}


class SmokeFailed(Exception):
    pass


def say(text: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def disk(work: Path) -> str:
    usage = shutil.disk_usage(work)
    return f"{usage.free / 2**30:.1f} GiB free of {usage.total / 2**30:.1f} GiB"


def pinned(program: str) -> dict:
    document = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return next(p for p in document["programs"] if p["id"] == program)


class Engine:
    """An engine from this checkout, with its own data folder and ports."""

    def __init__(self, work: Path, backend: str, env: dict[str, str], path: Path | None) -> None:
        self.work = work
        self.token = secrets.token_urlsafe(18)
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.llm_url = f"http://127.0.0.1:{free_port()}/v1"
        self.comfyui_url = f"http://127.0.0.1:{free_port()}"
        self.log = work / "engine.log"
        environment = {
            **os.environ,
            "LOCALCUT_LLM_URL": self.llm_url,
            "LOCALCUT_COMFYUI_URL": self.comfyui_url,
            **env,
        }
        if path is not None:
            environment["PATH"] = str(path) + os.pathsep + environment.get("PATH", "")
        command = [
            sys.executable,
            "-m",
            "localcut_engine",
            "serve",
            "--port",
            str(self.port),
            "--token",
            self.token,
            "--data-dir",
            str(work / "data"),
            "--backend",
            backend,
        ]
        say(f"starting the engine at {self.url} with data in {work / 'data'}")
        self.process = subprocess.Popen(
            command,
            cwd=ENGINE,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=self.log.open("wb"),
            stderr=subprocess.STDOUT,
        )
        self.client = httpx.Client(
            base_url=self.url,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=httpx.Timeout(60),
        )
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SmokeFailed(f"the engine exited with {self.process.returncode}")
            try:
                if self.client.get("/health").status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        raise SmokeFailed("the engine did not answer /health in three minutes")

    def get(self, path: str) -> dict:
        response = self.client.get(path)
        response.raise_for_status()
        return response.json()

    def row(self, program: str) -> dict:
        return next(row for row in self.get("/programs")["programs"] if row["id"] == program)

    def setup(self, program: str, build: str | None, timeout_s: float) -> dict:
        """POST /programs/<program>/setup and wait for it to end: its
        `setup.last`, with every phase it was seen in."""
        before = self.row(program)["setup"]
        say(
            f"{program}: the engine would set up {before.get('url')} "
            f"(gpu {before.get('gpu')}, build {before.get('build')}, "
            f"{before.get('download_bytes')} bytes down, {before.get('install_bytes')} unpacked)"
        )
        query = f"?build={build}" if build else ""
        response = self.client.post(f"/programs/{program}/setup{query}")
        if response.status_code != 200:
            raise SmokeFailed(f"the setup was refused: {response.status_code} {response.text}")
        started = response.json()
        say(f"{program}: {started}")
        if started.get("status") != "started":
            raise SmokeFailed(f"expected a setup to start, got {started}")
        seen: list[str] = []
        shown = None
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            setup = self.row(program)["setup"]
            last = setup.get("last")
            if last is not None and last.get("job") == started["job"]:
                last["phases"] = seen
                return last
            job = setup.get("job")
            if job is not None:
                if not seen or seen[-1] != job["phase"]:
                    seen.append(job["phase"])
                tenth = int(10 * job["done"] / job["total"]) if job.get("total") else 0
                line = f"{program}: {job['phase']} {tenth * 10}%"
                if line != shown:
                    shown = line
                    say(f"{line} ({job['done']} of {job['total']}; {disk(self.work)})")
            time.sleep(1)
        raise SmokeFailed(f"the setup of {program} did not end in {timeout_s:.0f}s")

    def cli(self, *args: str, timeout_s: float = 900) -> str:
        """A `localcut` command against this engine; its standard output."""
        done = subprocess.run(
            [sys.executable, "-m", "localcut_engine", *args],
            cwd=ENGINE,
            env={**os.environ, "LOCALCUT_ENGINE_URL": self.url, "LOCALCUT_TOKEN": self.token},
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            check=False,
        )
        if done.returncode != 0:
            raise SmokeFailed(
                f"`localcut {' '.join(args)}` exited {done.returncode}: "
                f"{done.stderr.strip() or done.stdout.strip()}"
            )
        return done.stdout

    def stop(self) -> None:
        if self.process.poll() is None:
            try:
                self.client.post("/shutdown", timeout=30)
            except httpx.HTTPError:
                pass
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.client.close()

    def tail(self, lines: int = 60) -> str:
        try:
            text = self.log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(text.splitlines()[-lines:])


def expect(condition: bool, what: str) -> None:
    if not condition:
        raise SmokeFailed(what)
    say(f"ok: {what}")


def smoke_ffmpeg(work: Path) -> None:
    version = pinned("ffmpeg")["version"]
    engine = Engine(work, "local,mock", {}, None)
    try:
        last = engine.setup("ffmpeg", None, 1800)
        expect(last["outcome"] == "done", f"the setup is done ({last})")
        row = engine.row("ffmpeg")
        expect(row["source"] == "managed", f"the engine runs LocalCut's copy ({row['location']})")
        expect(row["version"] == version, f"it reports FFmpeg {version} ({row['version']})")
        expect(row["checks"].get("draws_text") is True, "it draws a title and a caption")
        expect(row["managed"]["current"] is True, "the copy is the pinned build")

        project = json.loads(
            engine.cli(
                "create",
                "A paper boat drifting down a rain gutter",
                "--duration",
                "10",
                "--json",
            )
        )
        say(f"rendering project {project['id']} on local,mock")
        engine.cli("render", project["id"], "--timeout", "1200", timeout_s=1500)
        out = work / "smoke.mp4"
        engine.cli("export", project["id"], "--out", str(out))
        exe = ".exe" if os.name == "nt" else ""
        copy = work / "data" / "programs" / "ffmpeg"
        probe = subprocess.run(
            [
                str(copy / f"ffprobe{exe}"),
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name:format=duration",
                "-of",
                "json",
                str(out),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        facts = json.loads(probe.stdout)
        kinds = {stream["codec_type"]: stream["codec_name"] for stream in facts["streams"]}
        duration = float(facts["format"]["duration"])
        say(f"the export: {kinds}, {duration:.2f} s, {out.stat().st_size} bytes")
        expect("video" in kinds and "audio" in kinds, "the MP4 has a video and an audio stream")
        expect(duration > 1, "the MP4 is longer than a second")
        decoded = subprocess.run(
            [str(copy / f"ffmpeg{exe}"), "-v", "error", "-i", str(out), "-f", "null", "-"],
            capture_output=True,
            text=True,
            check=False,
        )
        expect(
            decoded.returncode == 0 and not decoded.stderr.strip(),
            f"ffmpeg decodes it to the end with no error ({decoded.stderr.strip()[:200]})",
        )
    finally:
        engine.stop()


def smoke_ollama(work: Path) -> None:
    version = pinned("ollama")["version"]
    engine = Engine(work, "mock", {"LOCALCUT_LLM_MODEL": MODEL}, None)
    try:
        last = engine.setup("ollama", None, 3600)
        expect(last["outcome"] == "done", f"the setup is done ({last})")
        row = engine.row("ollama")
        expect(row["source"] == "managed", "LocalCut's copy answers at the address")
        expect(row["version"] == version, f"it reports Ollama {version} ({row['version']})")
        expect(row["checks"].get("model_present") is True, f"it has {MODEL}")
        expect(row["managed"]["server"]["state"] == "running", "the copy is running")
        response = httpx.post(
            f"{engine.llm_url}/chat/completions",
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": "Reply with one word: hello."}],
                "reasoning_effort": "none",
                "max_tokens": 64,
            },
            timeout=600,
        )
        response.raise_for_status()
        answer = response.json()["choices"][0]["message"].get("content") or ""
        say(f"the copy answered: {answer.strip()!r}")
        expect(bool(answer.strip()), "the copy answers /v1/chat/completions")
        log = engine.client.get("/programs/ollama/log").text
        said = [line for line in log.splitlines() if "inference compute" in line]
        say("Ollama's log: " + (said[-1] if said else "names no inference device"))
    finally:
        engine.stop()


def template_inputs() -> dict[str, set[str]]:
    """Every node class the workflow templates use, with the inputs each
    sends it."""
    used: dict[str, set[str]] = {}
    for path in sorted(TEMPLATES.glob("*.json")):
        for node in json.loads(path.read_text(encoding="utf-8")).values():
            used.setdefault(node["class_type"], set()).update(node.get("inputs", {}))
    return used


def smoke_comfyui_linux(work: Path) -> None:
    version = pinned("comfyui")["version"]
    engine = Engine(work, "mock", {}, None)
    try:
        last = engine.setup("comfyui", "cpu", 5400)
        expect(last["outcome"] == "done", f"the setup is done ({last})")
        expect(last.get("build") == "cpu", "it set up the processor's build")
        row = engine.row("comfyui")
        expect(row["source"] == "managed", "LocalCut's copy answers at the address")
        expect(row["version"] == version, f"it reports ComfyUI {version} ({row['version']})")
        expect(row["managed"]["server"]["state"] == "running", "the copy is running")
        response = httpx.get(f"{engine.comfyui_url}/object_info", timeout=120)
        response.raise_for_status()
        served = response.json()
        used = template_inputs()
        missing = []
        for class_type, inputs in sorted(used.items()):
            node = served.get(class_type)
            if node is None:
                missing.append(class_type)
                continue
            declared = set()
            for group in ("required", "optional", "hidden"):
                declared |= set((node.get("input") or {}).get(group) or {})
            missing += [f"{class_type}.{name}" for name in sorted(inputs - declared)]
        say(
            f"the templates use {len(used)} node classes and "
            f"{sum(len(i) for i in used.values())} inputs"
        )
        expect(not missing, f"/object_info serves all of them (missing: {missing})")
    finally:
        engine.stop()


def stand_in(work: Path, card: str) -> Path:
    """A folder holding a stand-in for `card`'s vendor tool, as a program
    the probe can run: a console script, which is an .exe on Windows."""
    tool, body = _STAND_INS[card]
    package = work / "gpu-stand-in"
    package.mkdir(parents=True, exist_ok=True)
    (package / "pyproject.toml").write_text(
        textwrap.dedent(
            f"""\
            [project]
            name = "gpu-stand-in"
            version = "1"
            requires-python = ">=3.10"

            [project.scripts]
            {tool} = "gpu_stand_in:main"

            [build-system]
            requires = ["hatchling"]
            build-backend = "hatchling.build"

            [tool.hatch.build.targets.wheel]
            only-include = ["gpu_stand_in.py"]
            """
        ),
        encoding="utf-8",
    )
    (package / "gpu_stand_in.py").write_text(
        f"def main():\n    {body}\n    return 0\n", encoding="utf-8"
    )
    venv = work / "gpu-stand-in-venv"
    subprocess.run(["uv", "venv", "--quiet", str(venv)], check=True)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        ["uv", "pip", "install", "--quiet", "--python", str(python), str(package)], check=True
    )
    found = shutil.which(tool, path=str(python.parent))
    if found is None:
        raise SmokeFailed(f"the stand-in {tool} was not made")
    # The tool alone on the engine's PATH, not the venv's python beside it,
    # where the copy runs. A launcher that only runs from its own folder is
    # left there.
    folder = work / "gpu-stand-in-bin"
    folder.mkdir(exist_ok=True)
    shutil.copy2(found, folder / Path(found).name)
    for where in (folder, python.parent):
        said = subprocess.run(
            [str(where / Path(found).name)], capture_output=True, text=True, check=False
        )
        if "stand-in" in said.stdout:
            say(f"stand-in {tool} in {where}: {said.stdout.strip()}")
            return where
    raise SmokeFailed(f"the stand-in {tool} does not run: {said.stderr.strip()}")


def smoke_comfyui_windows(work: Path, card: str, build: str | None) -> None:
    pin = pinned("comfyui")
    asset = next(
        a
        for a in pin["assets"]
        if (a["platform"], a.get("gpu"), a.get("build")) == ("windows-x64", card, build)
    )
    usual = next(
        a
        for a in pin["assets"]
        if (a["platform"], a.get("gpu"), a.get("build")) == ("windows-x64", card, None)
    )
    engine = Engine(work, "mock", {}, stand_in(work, card))
    try:
        system = engine.get("/system")
        say(f"the probe found: {(system.get('hardware') or {}).get('primary_gpu')}")
        setup = engine.row("comfyui")["setup"]
        expect(
            (setup.get("gpu"), setup.get("url")) == (card, usual["url"]),
            f"the engine offers the {card} card's usual build ({setup.get('url')})",
        )
        last = engine.setup("comfyui", build, 5400)
        say(f"the setup ended: {last}")
        # The device check is the one phase that can fail with gpu_not_usable,
        # so the reason below says it was reached. Polling once a second can
        # miss a short phase, so only the long ones are asked for here.
        expect(
            [p for p in ("downloading", "unpacking") if p in last["phases"]]
            == ["downloading", "unpacking"],
            f"it downloaded and unpacked the build (phases seen: {last['phases']})",
        )
        expect(last["build"] == build, f"it was the {build or 'usual'} build, {asset['url']}")
        expect(
            last["outcome"] == "failed" and last["reason"] == "gpu_not_usable",
            "it stopped at the device check and nowhere before it",
        )
        expect(
            "PyTorch" in (last.get("error") or "")
            and "cannot use the graphics card" in last["error"],
            "the build's own Python loaded its PyTorch, which found no card",
        )
        leftovers = [p.name for p in (work / "data" / "programs").iterdir()]
        expect("comfyui" not in leftovers, f"nothing was kept (programs folder holds {leftovers})")
    finally:
        engine.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("program", choices=("ffmpeg", "ollama", "comfyui"))
    parser.add_argument("--work", type=Path, required=True, help="an empty folder to work in")
    parser.add_argument(
        "--card",
        choices=tuple(_STAND_INS),
        help="ComfyUI on Windows: the vendor whose build to take, by a stand-in for its tool",
    )
    parser.add_argument("--build", help="ComfyUI: one of the vendor's other builds, by name")
    args = parser.parse_args(argv)
    args.work.mkdir(parents=True, exist_ok=True)
    work = args.work.resolve()
    say(f"work folder {work}: {disk(work)}")
    try:
        if args.program == "ffmpeg":
            smoke_ffmpeg(work)
        elif args.program == "ollama":
            smoke_ollama(work)
        elif os.name == "nt":
            if args.card is None:
                raise SmokeFailed("ComfyUI on Windows needs --card")
            smoke_comfyui_windows(work, args.card, args.build)
        else:
            smoke_comfyui_linux(work)
    except SmokeFailed as exc:
        print(f"::error::{args.program}: {exc}", flush=True)
        log = work / "engine.log"
        if log.is_file():
            print("--- the engine's last lines ---", flush=True)
            print("\n".join(log.read_text("utf-8", "replace").splitlines()[-80:]), flush=True)
        return 1
    finally:
        say(f"work folder {work}: {disk(work)}")
    say(f"{args.program}: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
