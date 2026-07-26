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
from localcut_engine.otio import edl_to_otio, timeline_seconds

FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def _tracks_by_name(doc: dict) -> dict:
    return {t["name"]: t for t in doc["tracks"]["children"]}


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
        "clip1": synth(
            tmp_path, "clip1.mp4", ["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=24:duration=2"]
        ),
        "clip2": synth(
            tmp_path, "clip2.mp4", ["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=24:duration=2"]
        ),
        # narrations: 3s (longer than clip → loop) and 1s (shorter → trim)
        "narr1": synth(
            tmp_path, "narr1.wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"]
        ),
        "narr2": synth(
            tmp_path, "narr2.wav", ["-f", "lavfi", "-i", "sine=frequency=330:duration=1"]
        ),
        # 1.8s: overruns the 2s clip by less than the retime bound
        "narr18": synth(
            tmp_path, "narr18.wav", ["-f", "lavfi", "-i", "sine=frequency=550:duration=1.8"]
        ),
        "music": synth(
            tmp_path, "music.wav", ["-f", "lavfi", "-i", "sine=frequency=220:duration=2"]
        ),
    }


async def test_timeline_and_export_narration_drives_timing(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"

    timeline_ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={
            "s1": media["clip1"],
            "s1.audio": media["narr1"],
            "s2": media["clip2"],
            "s2.audio": media["narr2"],
            "music": media["music"],
        },
    )
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}), timeline_ctx
    )
    timeline = json.loads(timeline_path.read_text())
    assert [seg["scene"] for seg in timeline["video"]] == ["s1", "s2"]
    assert timeline["video"][0]["narration"].endswith("narr1.wav")
    # The EDL is the timing authority: stored starts/durations are what
    # export and caption alignment consume.
    assert timeline["video"][0]["duration"] == pytest.approx(3 + 0.35, abs=0.05)
    assert timeline["video"][1]["start"] == pytest.approx(3.35, abs=0.05)
    assert timeline["duration"] == pytest.approx(4.7, abs=0.1)

    export_ctx = ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path})
    export_spec = JobSpec(
        node_id="export",
        kind=NodeKind.EXPORT,
        output_hash="d" * 64,
        params={},
        model=None,
        seed=0,
        input_hashes={"default": "e" * 64},
    )
    out = await backend.execute(export_spec, export_ctx)

    duration = await backend._probe_duration(out)
    # s1 = 3s narration + pad (clip looped), s2 = 1s narration + pad (trimmed)
    expected = (3 + 1) + 2 * 0.35
    assert duration == pytest.approx(expected, abs=0.15)  # concat must not drift

    probe = subprocess.run(
        [
            backend.ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height",
            "-of",
            "json",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=True,
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
    fake_music.write_text('{"mock": true}')

    timeline_ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={"s1": media["clip1"], "s1.audio": media["narr2"], "music": fake_music},
    )
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "1:1"}), timeline_ctx
    )
    export_ctx = ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path})
    out = await backend.execute(
        JobSpec(
            node_id="export",
            kind=NodeKind.EXPORT,
            output_hash="c" * 64,
            params={},
            model=None,
            seed=0,
            input_hashes={},
        ),
        export_ctx,
    )
    assert (await backend._probe_duration(out)) is not None  # still a valid video


async def test_reorder_trim_and_transitions(tmp_path, media):
    """Timeline v1 ops: order overrides scene sort, trims pick the clip
    window, crossfades shorten the program by their overlap."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"

    timeline_path = await backend.execute(
        make_spec(
            NodeKind.TIMELINE,
            {
                "aspect": "9:16",
                "order": ["s2", "s1"],
                "trims": {"s2": {"in": 0.5, "out": 1.5}},
                "transitions": {"s2": "crossfade"},
                "overlays": {"s1": "THREE HEARTS?!"},
            },
        ),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={
                "s1": media["clip1"],
                "s1.audio": media["narr1"],
                "s2": media["clip2"],  # no narration → trim window drives duration
            },
        ),
    )
    edl = json.loads(timeline_path.read_text())
    assert [seg["scene"] for seg in edl["video"]] == ["s2", "s1"]
    assert edl["video"][0]["duration"] == pytest.approx(1.0, abs=0.05)  # out-in
    assert edl["video"][0]["transition"] == "crossfade"
    assert edl["video"][1]["onscreen_text"] == "THREE HEARTS?!"
    # The EDL is the timing authority: starts reflect the crossfade overlap
    # exactly as the export renders it, so caption offsets can't drift.
    assert edl["video"][1]["start"] == pytest.approx(0.6, abs=0.05)
    assert edl["duration"] == pytest.approx(1.0 + 3.35 - 0.4, abs=0.1)

    out = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="b" * 64),
        ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
    )
    duration = await backend._probe_duration(out)
    # s2 (1.0s) + s1 (3.35s) - crossfade overlap (0.4s)
    assert duration == pytest.approx(1.0 + 3.35 - 0.4, abs=0.2)


async def test_captions_burn_in(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={"s1": media["clip1"], "s1.audio": media["narr2"]},
        ),
    )
    srt = tmp_path / "caps.srt"
    srt.write_text("1\n00:00:00,100 --> 00:00:01,000\nhello captions\n")

    burned = await backend.execute(
        make_spec(NodeKind.EXPORT, {"captions": "burn"}, output_hash="b" * 64),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={"default": timeline_path, "captions": srt},
        ),
    )
    sidecar = await backend.execute(
        make_spec(NodeKind.EXPORT, {"captions": "sidecar"}, output_hash="c" * 64),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={"default": timeline_path, "captions": srt},
        ),
    )
    d1, d2 = await backend._probe_duration(burned), await backend._probe_duration(sidecar)
    assert d1 is not None and d2 is not None
    assert d1 == pytest.approx(d2, abs=0.1)  # burn-in must not change timing


async def test_final_quality_uses_higher_bitrate(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={"s1": media["clip1"], "s1.audio": media["narr1"]},
        ),
    )
    draft = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="b" * 64, quality="draft"),
        ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
    )
    final = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="c" * 64, quality="final"),
        ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
    )
    assert final.stat().st_size > draft.stat().st_size * 1.5


async def test_retime_inside_bound_loops_beyond_it(tmp_path, media, monkeypatch):
    """A clip short of its narration window by ≤15% is slowed to fit; past
    the bound it loops with a crossfaded seam — never unbounded slow-mo."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    loop_calls: list = []
    original = backend._loop_source

    async def spy(*args, **kwargs):
        loop_calls.append(args)
        return await original(*args, **kwargs)

    monkeypatch.setattr(backend, "_loop_source", spy)

    async def export_with(narr, tag):
        timeline_path = await backend.execute(
            make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}, output_hash=tag * 64),
            ExecutionContext(
                output_dir=out_dir,
                input_artifacts={"s1": media["clip1"], "s1.audio": narr},
            ),
        )
        out = await backend.execute(
            make_spec(NodeKind.EXPORT, {}, output_hash=tag * 32 + "f" * 32),
            ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
        )
        return await backend._probe_duration(out)

    # 2s clip, 1.8s narration → 2.15s window: stretch 1.075, retimed in place.
    duration = await export_with(media["narr18"], "a")
    assert duration == pytest.approx(1.8 + 0.35, abs=0.15)
    assert not loop_calls

    # 2s clip, 3s narration → 3.35s window: stretch 1.675 → crossfaded loop.
    duration = await export_with(media["narr1"], "b")
    assert duration == pytest.approx(3 + 0.35, abs=0.15)
    assert loop_calls


async def test_split_scene_takes_join_into_one_segment(tmp_path, media):
    """Sequential takes ('s1', 's1.p2') group into one EDL segment whose
    virtual clip is their concatenation."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"

    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={
                "s1": media["clip1"],
                "s1.p2": media["clip2"],
                "s1.audio": media["narr1"],  # 3s < 4s of combined takes
                "s2": media["clip2"],
                "s2.audio": media["narr2"],
            },
        ),
    )
    edl = json.loads(timeline_path.read_text())
    assert [seg["scene"] for seg in edl["video"]] == ["s1", "s2"]
    first = edl["video"][0]
    assert len(first["srcs"]) == 2
    assert first["clip_duration"] == pytest.approx(4.0, abs=0.1)
    assert first["duration"] == pytest.approx(3.35, abs=0.05)  # narration rules

    out = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="b" * 64),
        ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
    )
    duration = await backend._probe_duration(out)
    assert duration == pytest.approx(3.35 + 1.35, abs=0.15)


async def test_edl_converts_to_otio_for_nle_handoff(tmp_path, media):
    """The OTIO document mirrors the EDL: real source ranges per take,
    narration with true durations, gaps where export synthesizes frames."""
    from localcut_engine.otio import edl_to_otio

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={
                "s1": media["clip1"],
                "s1.p2": media["clip2"],  # split scene: two takes
                "s1.audio": media["narr1"],  # 3 s
                "s2": media["clip2"],
                "s2.audio": media["narr2"],  # 1 s → clip trimmed, no gap
                "music": media["music"],
            },
        ),
    )
    edl = json.loads(timeline_path.read_text())
    doc = edl_to_otio(edl, resolve=lambda src: tmp_path / src, name="handoff test")

    assert doc["OTIO_SCHEMA"] == "Timeline.1"
    tracks = _tracks_by_name(doc)
    assert set(tracks) == {"Video", "Narration", "Music"}

    video = tracks["Video"]["children"]
    clips = [c for c in video if c["OTIO_SCHEMA"] == "Clip.1"]
    # s1 spans both takes (3.35 s across 2+2 s of media), s2 uses one.
    assert [c["name"] for c in clips] == ["s1 take 1", "s1 take 2", "s2"]
    assert clips[0]["media_reference"]["target_url"].endswith("clip1.mp4")
    # OTIO's own length rule (transition-safe) equals the EDL program.
    assert timeline_seconds(doc) == pytest.approx(edl["duration"], abs=0.05)

    narration = tracks["Narration"]["children"]
    spoken = [c for c in narration if c["OTIO_SCHEMA"] == "Clip.1"]
    gaps = [c for c in narration if c["OTIO_SCHEMA"] == "Gap.1"]
    assert len(spoken) == 2 and len(gaps) == 2  # a pad gap after each line
    assert spoken[0]["source_range"]["duration"]["value"] == pytest.approx(3 * 24, abs=2)

    with pytest.raises(ValueError, match="no video segments"):
        edl_to_otio({"node": "mock"}, resolve=lambda s: tmp_path / s, name="x")


async def test_otio_crossfade_matches_rendered_length(tmp_path, media):
    """With a crossfade, the OTIO timeline must be exactly as long as the
    rendered MP4 (an editor's reference cut lines up frame-for-frame), and
    the seam is a dissolve transition, not a silent cut."""
    from localcut_engine.otio import edl_to_otio

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    timeline_path = await backend.execute(
        make_spec(
            NodeKind.TIMELINE,
            {"aspect": "9:16", "transitions": {"s1": "crossfade"}},
        ),
        ExecutionContext(
            output_dir=out_dir,
            input_artifacts={
                "s1": media["clip1"],
                "s1.audio": media["narr1"],  # 3 s → 3.35 s
                "s2": media["clip2"],
                "s2.audio": media["narr2"],  # 1 s → 1.35 s
                "music": media["music"],
            },
        ),
    )
    edl = json.loads(timeline_path.read_text())
    # The crossfade pulled s2's start back by 0.4 s, shortening the program.
    assert edl["duration"] == pytest.approx(3.35 + 1.35 - 0.4, abs=0.1)

    out = await backend.execute(
        make_spec(NodeKind.EXPORT, {}, output_hash="a" * 64),
        ExecutionContext(output_dir=out_dir, input_artifacts={"default": timeline_path}),
    )
    rendered = await backend._probe_duration(out)

    doc = edl_to_otio(edl, resolve=lambda src: tmp_path / src, name="xfade")
    # OTIO total == EDL total == rendered MP4 — the whole point of the fix.
    assert timeline_seconds(doc) == pytest.approx(edl["duration"], abs=0.05)
    assert timeline_seconds(doc) == pytest.approx(rendered, abs=0.15)

    video = _tracks_by_name(doc)["Video"]["children"]
    transitions = [c for c in video if c["OTIO_SCHEMA"] == "Transition.1"]
    assert len(transitions) == 1  # one dissolve at the s1→s2 seam
    t = transitions[0]
    assert t["transition_type"] == "SMPTE_Dissolve"
    assert t["in_offset"]["value"] > 0 and t["out_offset"]["value"] > 0
    # A transition may never be the first or last item on a track.
    assert video[0]["OTIO_SCHEMA"] != "Transition.1"
    assert video[-1]["OTIO_SCHEMA"] != "Transition.1"
    # Cuts, by contrast, add no transition.
    narration = _tracks_by_name(doc)["Narration"]["children"]
    assert not [c for c in narration if c["OTIO_SCHEMA"] == "Transition.1"]


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
        ExecutionContext(output_dir=out_dir, input_artifacts={"s1": clip, "s1.audio": narr}),
    )
    edl = json.loads(timeline_path.read_text())
    assert edl["video"][0]["srcs"] == ["aa.mp4"]  # relative, not absolute

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


async def test_beat_align_snaps_boundaries_without_cutting_speech(tmp_path, media):
    """A click-track bed with beat_align pulls the scene boundary onto the
    beat grid by flexing only the pad after narration."""
    import numpy as np
    import soundfile as sf

    from localcut_engine.audio import ANALYSIS_RATE, estimate_beats

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    # Clicks exactly every 0.5s from t=0 — a grid the 0.55s snap window
    # (pad flex + stretch) can never miss.
    rng = np.random.default_rng(3)
    pcm = np.zeros(ANALYSIS_RATE * 4, dtype=np.float32)
    for k in range(8):
        i = int(k * 0.5 * ANALYSIS_RATE)
        pcm[i : i + 256] = rng.uniform(-0.9, 0.9, 256).astype(np.float32)
    click = tmp_path / "click.wav"
    sf.write(click, pcm, ANALYSIS_RATE)

    ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={"s1": media["clip1"], "s1.audio": media["narr18"], "music": click},
    )
    plain = json.loads(
        (await backend.execute(make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}), ctx)).read_text()
    )
    aligned = json.loads(
        (
            await backend.execute(
                make_spec(
                    NodeKind.TIMELINE,
                    {"aspect": "9:16", "beat_align": True},
                    output_hash="b" * 64,
                ),
                ctx,
            )
        ).read_text()
    )
    base, seg = plain["video"][0], aligned["video"][0]
    assert base["duration"] == pytest.approx(1.8 + 0.35, abs=0.05)  # unaligned window
    # Snapped onto a beat: never below the speech floor, never far past.
    assert seg["duration"] >= 1.8 + 0.15 - 0.001
    assert seg["duration"] <= base["duration"] + 0.35 + 0.001
    beats = estimate_beats(pcm)
    assert beats, "click track must yield a beat grid"
    end = seg["start"] + seg["duration"]
    assert min(abs(end - b) for b in beats) < 0.06
    assert aligned["duration"] == pytest.approx(end, abs=0.001)


async def test_ducking_flag_flows_into_the_edl_and_both_mixes_export(tmp_path, media):
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={"s1": media["clip1"], "s1.audio": media["narr2"], "music": media["music"]},
    )
    ducked_edl = await backend.execute(make_spec(NodeKind.TIMELINE, {"aspect": "9:16"}), ctx)
    assert json.loads(ducked_edl.read_text())["ducking"] is True  # the default
    flat_edl = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16", "ducking": False}, output_hash="b" * 64),
        ctx,
    )
    assert json.loads(flat_edl.read_text())["ducking"] is False

    for tag, edl in (("d", ducked_edl), ("f", flat_edl)):
        out = await backend.execute(
            make_spec(NodeKind.EXPORT, {}, output_hash=tag * 64),
            ExecutionContext(output_dir=out_dir, input_artifacts={"default": edl}),
        )
        probe = subprocess.run(
            [
                backend.ffprobe_bin,
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
                str(out),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "audio" in probe.stdout  # both mix graphs are valid end to end


async def test_beat_align_with_crossfade_stays_consistent_and_on_beat(tmp_path):
    """Regression: beat-snap + a crossfade boundary must keep the EDL length
    equal to the OTIO length (no 0.4s drift) AND land the boundary on a beat.
    The two pull in opposite directions — this pins both. Uses clips longer
    than the narration so a beat sits inside the snap window."""
    import numpy as np
    import soundfile as sf

    from localcut_engine.audio import ANALYSIS_RATE, estimate_beats

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    clip = synth(
        tmp_path, "long.mp4", ["-f", "lavfi", "-i", "testsrc2=size=320x568:rate=24:duration=6"]
    )
    narr = synth(tmp_path, "n25.wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2.5"])
    rng = np.random.default_rng(5)
    pcm = np.zeros(ANALYSIS_RATE * 12, dtype=np.float32)
    for k in range(24):  # a click every 0.5s
        i = int(k * 0.5 * ANALYSIS_RATE)
        pcm[i : i + 256] = rng.uniform(-0.9, 0.9, 256).astype(np.float32)
    click = tmp_path / "click.wav"
    sf.write(click, pcm, ANALYSIS_RATE)
    beats = estimate_beats(pcm)

    ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={
            "s1": clip,
            "s1.audio": narr,  # 2.5s narration on a 6s clip → snap can flex
            "s2": clip,
            "s2.audio": narr,
            "music": click,
        },
    )
    edl = json.loads(
        (
            await backend.execute(
                make_spec(
                    NodeKind.TIMELINE,
                    {"aspect": "9:16", "beat_align": True, "transitions": {"s1": "crossfade"}},
                ),
                ctx,
            )
        ).read_text()
    )
    resolve = lambda src: p if (p := Path(src)).is_absolute() else out_dir / p  # noqa: E731
    doc = edl_to_otio(edl, resolve, "x")
    # 1. No drift: the OTIO length equals the EDL program length.
    assert timeline_seconds(doc) == pytest.approx(edl["duration"], abs=0.05)
    # 2. On-beat: every boundary (stored start+duration) lands on a beat,
    #    including the one whose start the crossfade pulled back.
    for seg in edl["video"]:
        end = seg["start"] + seg["duration"]
        assert min(abs(end - b) for b in beats) < 0.06, f"{seg['scene']} end {end} off-beat"
    # 3. The crossfade survived (both sides long enough after snapping).
    assert edl["video"][0]["transition"] == "crossfade"
    assert edl["video"][0]["duration"] > 2 * 0.4 and edl["video"][1]["duration"] > 2 * 0.4


async def test_beat_align_narrationless_never_snaps_past_trim(tmp_path, media):
    """A trimmed, narrationless segment snaps only backward (shrink-to-beat),
    never past its window into footage the user cut."""
    import numpy as np
    import soundfile as sf

    from localcut_engine.audio import ANALYSIS_RATE

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    out_dir = tmp_path / "generated"
    rng = np.random.default_rng(9)
    pcm = np.zeros(ANALYSIS_RATE * 4, dtype=np.float32)
    for k in range(8):
        i = int(k * 0.5 * ANALYSIS_RATE)
        pcm[i : i + 256] = rng.uniform(-0.9, 0.9, 256).astype(np.float32)
    click = tmp_path / "click.wav"
    sf.write(click, pcm, ANALYSIS_RATE)

    # No narration for s1; trim_out caps its window at 1.5s of the 2s clip.
    ctx = ExecutionContext(
        output_dir=out_dir,
        input_artifacts={"s1": media["clip1"], "music": click},
    )
    edl = json.loads(
        (
            await backend.execute(
                make_spec(
                    NodeKind.TIMELINE,
                    {"aspect": "9:16", "beat_align": True, "trims": {"s1": {"out": 1.5}}},
                ),
                ctx,
            )
        ).read_text()
    )
    seg = edl["video"][0]
    assert seg["duration"] <= 1.5 + 0.001  # never past the trimmed window


async def test_real_ffmpeg_supports_drawtext():
    """The build assembly runs against must render on-screen titles — a
    static build without libharfbuzz would fail every titled export."""
    assert await FFmpegBackend(ffmpeg_bin=FFMPEG).supports_drawtext() is True


async def test_still_clip_from_keyframe(tmp_path):
    """The no-video-model tier: CLIP jobs render a real, probe-able mp4 from
    the scene keyframe (loop + push-in), so assembly can consume them."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    keyframe = synth(
        tmp_path, "kf.png", ["-f", "lavfi", "-i", "testsrc2=size=448x768", "-frames:v", "1"]
    )
    out_dir = tmp_path / "generated"
    ctx = ExecutionContext(output_dir=out_dir, input_artifacts={"keyframe": keyframe})
    spec = make_spec(
        NodeKind.CLIP,
        {"duration_s": 1.5, "aspect": "9:16"},
        node_id="s1.clip",
    )
    clip = await backend.execute(spec, ctx)
    assert clip.suffix == ".mp4"
    duration = await backend._probe_duration(clip)
    assert duration is not None and abs(duration - 1.5) < 0.2


async def test_a_crossfade_never_overlaps_the_two_scenes_speech(tmp_path, media):
    """A crossfade pulls the incoming scene back by CROSSFADE_S. That overlap
    has to land in the outgoing scene's breathing pad, not in its narration —
    otherwise the two scenes talk over each other and both captions sit on
    screen together. A scene that crossfades out therefore reserves at least
    a fade's worth of pad."""
    from localcut_engine.backends.ffmpeg import CROSSFADE_S

    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    ctx = ExecutionContext(
        output_dir=tmp_path / "generated",
        input_artifacts={
            "s1": media["clip1"],
            "s1.audio": media["narr1"],
            "s2": media["clip2"],
            "s2.audio": media["narr2"],
        },
    )
    timeline_path = await backend.execute(
        make_spec(NodeKind.TIMELINE, {"aspect": "9:16", "transitions": {"s1": "crossfade"}}),
        ctx,
    )
    segments = json.loads(timeline_path.read_text())["video"]
    first, second = segments[0], segments[1]

    # The outgoing scene reserves a full fade of pad beyond its speech...
    pad = first["duration"] - first["narration_duration"]
    assert pad >= CROSSFADE_S - 0.001, f"only {pad:.3f}s of pad for a {CROSSFADE_S}s fade"
    # ...so the incoming scene starts no earlier than the outgoing one stops
    # speaking. This is the property that matters; the pad is how it is met.
    speech_ends = first["start"] + first["narration_duration"]
    assert second["start"] >= speech_ends - 0.001, (
        f"scene 2 starts {speech_ends - second['start']:.3f}s before scene 1 stops speaking"
    )


async def test_trim_out_bounds_a_narrated_scene(tmp_path, media):
    """Narration drives scene duration, so a trim-out cannot shorten a
    narrated scene — but it must still bound which part of the clip is shown.
    Ignoring it entirely meant setting the tail trim on a narrated scene did
    nothing at all, silently."""
    backend = FFmpegBackend(ffmpeg_bin=FFMPEG)
    ctx = ExecutionContext(
        output_dir=tmp_path / "generated",
        input_artifacts={"s1": media["clip1"], "s1.audio": media["narr1"]},
    )
    timeline_path = await backend.execute(
        make_spec(
            NodeKind.TIMELINE,
            {"aspect": "9:16", "trims": {"s1": {"in": 0.5, "out": 1.5}}},
        ),
        ctx,
    )
    segment = json.loads(timeline_path.read_text())["video"][0]
    # Narration still sets the length...
    assert segment["duration"] == pytest.approx(3 + 0.35, abs=0.05)
    # ...but the material the renderer may draw on is the trimmed window,
    # which is what stops it revealing footage the user cut.
    assert segment["trim_window"] == pytest.approx(1.0, abs=0.01)
    assert segment["trim_in"] == pytest.approx(0.5, abs=0.01)
