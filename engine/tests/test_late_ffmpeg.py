"""An ffmpeg that arrives, or changes, while the engine is running.

LocalCut's own copy is set up into <data_dir>/programs/ffmpeg, and a binary
can be put in <data_dir>/bin by hand, both with the engine already up, and
`EngineConfig.resolved_ffmpeg_bin` prefers either to PATH. So every consumer
has to look for the binary when it uses it: the backends that claim assembly
and captions, the voice-clone retime, the readiness report, /system's text
probe and the waveform decoder. None of these tests restarts the engine.
These land the binary in <data_dir>/bin; test_programs.py lands it through
the setup itself.

The tests that look the binary up by name set PATH themselves, to one empty
directory, so a machine with ffmpeg installed system-wide runs them exactly
as one without.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from conftest import make_spec

from localcut_engine.api.app import _build_backends, create_app
from localcut_engine.automation import outstanding_jobs
from localcut_engine.backends.base import ExecutionContext
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import NodeKind
from localcut_engine.readiness import readiness_rows

TOKEN = "late-ffmpeg-token"
_EXE = ".exe" if os.name == "nt" else ""
# Looked up at import, before any test narrows PATH.
_REAL_FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")
_REAL_PAIR = (
    _REAL_FFMPEG is not None
    and Path(_REAL_FFMPEG).with_name(f"ffprobe{Path(_REAL_FFMPEG).suffix}").is_file()
)


def _without_ffmpeg_on_path(tmp_path: Path, monkeypatch) -> None:
    """PATH is one empty directory, so a bare `ffmpeg` finds nothing. Unset
    would not do: `shutil.which` then falls back to the system's default
    path, which is where a distribution's ffmpeg lives."""
    empty = tmp_path / "empty-path"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))


def _plant(path: Path, content: bytes) -> Path:
    """A file at `path`, landed by rename the way a finished download is, so
    a second call is a replacement over the same name."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f".partial-{path.name}")
    partial.write_bytes(content)
    os.replace(partial, path)
    return path


def _land_real_ffmpeg(data_dir: Path) -> Path:
    """The real pair, put in <data_dir>/bin the way a binary placed by hand
    gets there: ffprobe first, so there is never an ffmpeg there without its
    ffprobe. Copied rather than linked, because Windows needs a privilege to
    make a symlink."""
    source = Path(_REAL_FFMPEG)
    bin_dir = data_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source.with_name(f"ffprobe{source.suffix}"), bin_dir / f"ffprobe{_EXE}")
    shutil.copy2(source, bin_dir / f"ffmpeg{_EXE}")
    return bin_dir / f"ffmpeg{_EXE}"


@contextlib.asynccontextmanager
async def _engine(config: EngineConfig):
    app = create_app(config)
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://engine",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as http,
    ):
        async with app.router.lifespan_context(app):
            yield http


async def _settled(http: httpx.AsyncClient, project_id: str, done) -> list[dict]:
    """The project's jobs once `done(jobs)` holds and nothing is queued or
    rendering."""
    async with asyncio.timeout(300):
        while True:
            jobs = (await http.get("/jobs", params={"project_id": project_id})).json()
            if done(jobs) and not outstanding_jobs(jobs):
                return jobs
            await asyncio.sleep(0.1)


def _jobs(jobs: list[dict], kind: str, status: str | None = None) -> list[dict]:
    return [
        job
        for job in jobs
        if job["spec"]["kind"] == kind and (status is None or job["status"] == status)
    ]


@pytest.mark.skipif(not _REAL_PAIR, reason="ffmpeg not installed")
async def test_an_ffmpeg_that_lands_while_the_engine_runs_is_used_without_a_restart(
    tmp_path, monkeypatch
):
    """An ffmpeg landing mid-run, end to end, on the chain a machine without
    models runs. Before it lands the render fails at assembly rather than
    faking a cut, and every surface says ffmpeg is missing. After it, with the
    same engine still up, every surface says it is there and the same project
    renders a cut that plays."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    data_dir = tmp_path / "engine"
    async with _engine(EngineConfig(data_dir=data_dir, token=TOKEN, backend="ffmpeg,mock")) as http:
        created = await http.post("/projects", json={"prompt": "tides", "target_duration_s": 5})
        project_id = created.json()["id"]
        jobs = await _settled(http, project_id, lambda jobs: _jobs(jobs, "export"))
        (timeline,) = _jobs(jobs, "timeline")
        assert timeline["status"] == "failed"
        assert "no working ffmpeg" in timeline["error"]
        narration = _jobs(jobs, "narration", "done")[0]
        peaks = f"/projects/{project_id}/artifacts/{narration['spec']['output_hash']}/peaks"

        async def surfaces() -> dict:
            system = (await http.get("/system")).json()
            routes = {task["kind"]: task["backend"] for task in system["backends"]["tasks"]}
            readiness = await http.get("/readiness", params={"kinds": "clip,timeline,export"})
            return {
                "ffmpeg_drawtext": system["ffmpeg_drawtext"],
                "routes": {kind: routes[kind] for kind in ("clip", "timeline", "export")},
                "readiness": {row["kind"]: row["verdict"] for row in readiness.json()["rows"]},
                "peaks": (await http.get(peaks)).status_code,
            }

        assert await surfaces() == {
            "ffmpeg_drawtext": None,
            "routes": {"clip": "mock", "timeline": None, "export": None},
            "readiness": {"clip": "placeholder", "timeline": "will_fail", "export": "will_fail"},
            "peaks": 503,
        }

        managed = _land_real_ffmpeg(data_dir)

        assert await surfaces() == {
            "ffmpeg_drawtext": True,
            "routes": {"clip": "ffmpeg", "timeline": "ffmpeg", "export": "ffmpeg"},
            "readiness": {"clip": "degraded", "timeline": "ready", "export": "ready"},
            "peaks": 200,
        }

        earlier = {job["id"] for job in jobs}
        assert (await http.post(f"/projects/{project_id}/render")).status_code == 200
        jobs = await _settled(http, project_id, lambda jobs: len(_jobs(jobs, "export")) == 2)
        rerun = [job for job in jobs if job["id"] not in earlier]
        failed = {
            job["spec"]["node_id"]: job["error"] for job in rerun if job["status"] == "failed"
        }
        assert failed == {}
        # The clips mock stood in for are made again, by ffmpeg's still tier.
        assert {
            (job["spec"]["kind"], job["backend"])
            for job in rerun
            if job["spec"]["kind"] in ("clip", "timeline", "export")
        } == {("clip", "ffmpeg"), ("timeline", "ffmpeg"), ("export", "ffmpeg")}
        (export,) = _jobs(rerun, "export")
        assert export["status"] == "done"
        served = await http.get(f"/projects/{project_id}/artifacts/{export['spec']['output_hash']}")
        assert served.status_code == 200

    cut = tmp_path / "cut.mp4"
    cut.write_bytes(served.content)
    probe = subprocess.run(
        [
            str(managed.with_name(f"ffprobe{_EXE}")),
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            str(cut),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert sorted(stream["codec_type"] for stream in json.loads(probe.stdout)["streams"]) == [
        "audio",
        "video",
    ]
    # Every frame decodes, not only the header ffprobe reads.
    decode = subprocess.run(
        [str(managed), "-v", "error", "-i", str(cut), "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    assert (decode.returncode, decode.stderr) == (0, "")


async def test_every_backend_that_runs_ffmpeg_finds_one_that_lands_later(tmp_path, monkeypatch):
    """Assembly, the aligner and the voice-clone retime each run the binary,
    and each has to look for it when it runs. One that kept the name it was
    built with declines its kinds for good (assembly, captions) or spawns a
    name PATH cannot find (the retime). The readiness rows come from the same
    gates. A planted file is enough here: every gate checks that the binary
    is there, not that it works."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    weights = tmp_path / "models" / "asr" / "faster-whisper-base.en"
    weights.mkdir(parents=True)
    for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt"):
        (weights / name).touch()
    config = EngineConfig(
        data_dir=tmp_path,
        backend="local,mock",
        llm_url="http://127.0.0.1:9/v1",
        comfyui_url="http://127.0.0.1:9",
    )
    registry = _build_backends(config)
    holders = ("ffmpeg", "align", "chatterbox")
    pairs = [(kind, None) for kind in (NodeKind.CLIP, NodeKind.CAPTIONS, NodeKind.EXPORT)]

    async def served() -> dict:
        rows = await readiness_rows(config, registry, pairs)
        return {row["kind"]: (row["verdict"], row["reason"], row["backend"]) for row in rows}

    before = await served()
    assert before["captions"] == ("placeholder", "no_ffmpeg", "mock")
    assert before["export"] == ("will_fail", "no_ffmpeg", None)

    managed = _plant(tmp_path / "bin" / f"ffmpeg{_EXE}", b"")

    assert await served() == {
        "clip": ("degraded", "still_clip_tier", "ffmpeg"),
        "captions": ("ready", "ok", "align"),
        "export": ("ready", "ok", "ffmpeg"),
    }
    assert {name: registry.find(name).ffmpeg_bin for name in holders} == dict.fromkeys(
        holders, str(managed)
    )


async def test_system_probes_each_binary_once_and_never_keeps_a_missing_one(tmp_path, monkeypatch):
    """/system answers from a probe filed under the binary it drew with. The
    desktop asks again whenever it reconnects, and an unchanged binary must
    not cost another ffmpeg run. "No binary at all" is not an answer worth
    keeping, because the download may be about to land. A replacement over
    the same path, which is how an upgrade lands, is a different binary and
    is probed again."""
    _without_ffmpeg_on_path(tmp_path, monkeypatch)
    drawn: list[str] = []

    async def lit_pixels(self, vf: str) -> int | None:
        # The real probe answers None when it cannot start the binary.
        binary = Path(self.ffmpeg_bin)
        if not binary.is_file():
            return None
        drawn.append(vf)
        return 500 if binary.read_bytes() == b"draws" else 0

    monkeypatch.setattr(FFmpegBackend, "_lit_pixels", lit_pixels)
    managed = tmp_path / "bin" / f"ffmpeg{_EXE}"
    async with _engine(EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")) as http:

        async def drawtext() -> bool | None:
            return (await http.get("/system")).json()["ffmpeg_drawtext"]

        assert await drawtext() is None
        _plant(managed, b"draws")
        assert [await drawtext() for _ in range(3)] == [True, True, True]
        assert len(drawn) == 2, "one title and one caption, drawn once for the one binary"
        _plant(managed, b"draws nothing")
        assert [await drawtext() for _ in range(2)] == [False, False]
        assert len(drawn) == 4


class _Exited:
    """A child process that has already exited with `returncode`."""

    def __init__(self, returncode: int) -> None:
        self.returncode = returncode

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"", b""


async def test_the_encoder_is_chosen_again_for_a_replaced_binary(tmp_path, monkeypatch):
    """Which encoder opens is a property of the build, so the choice is filed
    under the binary the way the text probe is. A build without NVENC
    replaced by one with it must not keep encoding with the fallback."""
    binary = _plant(tmp_path / "bin" / f"ffmpeg{_EXE}", b"no nvenc")
    backend = FFmpegBackend(ffmpeg_bin=str(binary))
    tried: list[str] = []

    async def spawn(program, *args, **kwargs):
        encoder = args[args.index("-c:v") + 1]
        tried.append(encoder)
        opens = encoder != "h264_nvenc" or Path(program).read_bytes() == b"nvenc"
        return _Exited(0 if opens else 1)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    assert await backend._pick_encoder() == "libopenh264"
    assert await backend._pick_encoder() == "libopenh264"
    assert tried == ["h264_nvenc", "libopenh264"], "chosen once for one binary"
    _plant(binary, b"nvenc")
    assert await backend._pick_encoder() == "h264_nvenc"
    assert tried == ["h264_nvenc", "libopenh264", "h264_nvenc"]


async def test_a_job_finishes_on_the_binary_it_started_with(tmp_path, monkeypatch):
    """An export is many ffmpeg runs, and the encoder it picks first is fed to
    every one after. A binary that lands partway through must wait for the
    next job, or the rest of this one runs a build that never agreed to that
    encoder."""
    first = _plant(tmp_path / "first" / f"ffmpeg{_EXE}", b"first")
    second = _plant(tmp_path / "second" / f"ffmpeg{_EXE}", b"second")
    current = {"bin": str(first)}
    backend = FFmpegBackend(ffmpeg_bin=lambda: current["bin"])
    ran: list[str] = []

    async def pick_encoder() -> str:
        ran.append(backend.ffmpeg_bin)
        current["bin"] = str(second)  # the download lands mid-job
        return "mpeg4"

    async def run(*args: str) -> None:
        ran.append(backend.ffmpeg_bin)
        Path(args[-1]).write_bytes(b"clip")

    monkeypatch.setattr(backend, "_pick_encoder", pick_encoder)
    monkeypatch.setattr(backend, "_run", run)
    keyframe = _plant(tmp_path / "keyframe.png", b"png")
    ctx = ExecutionContext(
        output_dir=tmp_path / "generated", input_artifacts={"keyframe": keyframe}
    )
    await backend.execute(make_spec(NodeKind.CLIP, {"duration_s": 1}), ctx)
    assert ran == [str(first), str(first)]
    assert backend.ffmpeg_bin == str(second), "the next job's binary"
