"""Real-assembly tests: synthesize tiny media with ffmpeg and check the
narration-drives-timing rule end to end. Skipped where ffmpeg is absent."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import make_spec

from localcut_engine.backends.base import ExecutionContext
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind

FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def synth(tmp_path, name: str, args: list[str]):
    out = tmp_path / name
    subprocess.run(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args, str(out)],
        check=True,
    )
    return out


@pytest.fixture
def media(tmp_path):
    return {
        # 2s of test pattern video, 24fps
        "clip1": synth(tmp_path, "clip1.mp4",
                       ["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=24:duration=2"]),
        "clip2": synth(tmp_path, "clip2.mp4",
                       ["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=24:duration=2"]),
        # narrations: 3s (longer than clip → loop) and 1s (shorter → trim)
        "narr1": synth(tmp_path, "narr1.wav",
                       ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"]),
        "narr2": synth(tmp_path, "narr2.wav",
                       ["-f", "lavfi", "-i", "sine=frequency=330:duration=1"]),
        "music": synth(tmp_path, "music.wav",
                       ["-f", "lavfi", "-i", "sine=frequency=220:duration=2"]),
    }


async def test_timeline_and_export_narration_drives_timing(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"

    timeline_ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={
            "s1": media["clip1"], "s1.audio": media["narr1"],
            "s2": media["clip2"], "s2.audio": media["narr2"],
            "music": media["music"],
        },
    )
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}), timeline_ctx
    )
    timeline = json.loads(timeline_path.read_text())
    assert [seg["scene"] for seg in timeline["video"]] == ["s1", "s2"]
    assert timeline["video"][0]["narration"].endswith("narr1.wav")

    export_ctx = ExecutionContext(
        output_dir=out_dir, input_artifacts={"default": timeline_path}
    )
    export_spec = JobSpec(
        node_id="export", kind=NodeKind.EXPORT, output_hash="d" * 64,
        params={}, model=None, seed=0, input_hashes={"default": "e" * 64},
    )
    out = await backend.execute(export_spec, export_ctx)

    duration = await backend._probe_duration(out)
    # s1 = 3s narration + pad (clip looped), s2 = 1s narration + pad (trimmed)
    expected = (3 + 1) + 2 * 0.35
    assert duration == pytest.approx(expected, abs=0.15)  # concat must not drift

    probe = subprocess.run(
        [backend.ffprobe_bin, "-v", "error", "-show_entries", "stream=codec_type,width,height",
         "-of", "json", str(out)],
        capture_output=True, text=True, check=True,
    )
    streams = json.loads(probe.stdout)["streams"]
    kinds = {s["codec_type"] for s in streams}
    assert kinds == {"video", "audio"}
    video = next(s for s in streams if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)


async def test_export_skips_placeholder_music(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    fake_music = tmp_path / "music.json"
    fake_music.write_text("{\"mock\": true}")

    timeline_ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={"s1": media["clip1"], "s1.audio": media["narr2"],
                         "music": fake_music},
    )
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "1:1"}), timeline_ctx
    )
    export_ctx = ExecutionContext(
        output_dir=out_dir, input_artifacts={"default": timeline_path}
    )
    out = await backend.execute(
        JobSpec(node_id="export", kind=NodeKind.EXPORT, output_hash="c" * 64,
                params={}, model=None, seed=0, input_hashes={}),
        export_ctx,
    )
    assert (await backend._probe_duration(out)) is not None  # still a valid video


async def test_edl_paths_survive_project_relocation(tmp_path, media):
    """Artifacts referenced by a cached EDL live in generated/ — the EDL must
    store them relative to it, or moving/restoring a project bricks export."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    out_dir.mkdir()
    clip = Path(shutil.copy(media["clip1"], out_dir / "aa.mp4"))
    narr = Path(shutil.copy(media["narr2"], out_dir / "bb.wav"))

    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}, output_hash="e" * 64),
        ExecutionContext(
            output_dir=out_dir, input_artifacts={"s1": clip, "s1.audio": narr}
        ),
    )
    edl = json.loads(timeline_path.read_text())
    assert edl["video"][0]["src"] == "aa.mp4"  # relative, not absolute

    relocated = tmp_path / "restored-elsewhere"
    shutil.move(str(out_dir), str(relocated))
    out = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="d" * 64),
        ExecutionContext(
            output_dir=relocated,
            input_artifacts={"default": relocated / timeline_path.name},
        ),
    )
    assert (await backend._probe_duration(out)) is not None
