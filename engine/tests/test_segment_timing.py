"""Segment timing policy, asserted on the ffmpeg command line — no real
ffmpeg required.

Everything else covering this layer lives in test_assembly.py, which skips
wholesale when ffmpeg is absent. That is how a trim leak survived on the
hard-loop path: the branch is only reached by a clip shorter than a
crossfade, and on a machine without ffmpeg nothing in the suite executed it
at all. Stubbing `_run` and reading the argv costs nothing and runs
everywhere, so the timing decisions stay covered even where the encoder is
not installed.
"""

from pathlib import Path

import pytest

from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.ffmpeg import CROSSFADE_S, RETIME_MAX, FFmpegBackend


def _recording_backend(monkeypatch) -> tuple[FFmpegBackend, list[list[str]]]:
    backend = FFmpegBackend(ffmpeg_bin="ffmpeg")
    calls: list[list[str]] = []

    async def record(*args: str) -> None:
        calls.append(list(args))

    monkeypatch.setattr(backend, "_run", record)
    return backend, calls


async def _render(backend: FFmpegBackend, tmp_path: Path, **segment) -> None:
    await backend._render_segment(
        {"src": str(tmp_path / "clip.mp4"), **segment},
        tmp_path / "seg.mp4",
        1080,
        1920,
        "libx264",
        workdir=tmp_path,
    )


def _input_after(args: list[str], flag: str) -> str:
    """The `-i` that follows `flag` — i.e. the stream `flag` applies to."""
    start = args.index(flag)
    return args[args.index("-i", start) + 1]


def _value(args: list[str], flag: str, start: int = 0) -> str:
    return args[args.index(flag, start) + 1]


async def _join(backend: FFmpegBackend, tmp_path: Path, boundaries: list[str]) -> None:
    """Join `len(boundaries) + 1` two-second segments with those boundary
    transitions. The argv lands in the recorder's `calls`."""
    segments = [{"duration": 2.0, "transition": t} for t in [*boundaries, "cut"]]
    files = [tmp_path / f"seg{i}.mp4" for i in range(len(segments))]
    await backend._join_segments(segments, files, tmp_path, "libx264", "4M", None)


def _maps(args: list[str]) -> list[str]:
    return [args[i + 1] for i, flag in enumerate(args) if flag == "-map"]


async def test_a_hard_looped_scene_never_shows_footage_past_the_trim(tmp_path, monkeypatch):
    """The defect: `-stream_loop -1` reads its input to EOF, so an input `-ss`
    /`-t` bounds the whole looped stream rather than each repetition. A 30s
    source trimmed to 0.8s and looped under 8s of narration therefore played
    8 seconds of the untrimmed clip — every frame the user explicitly cut, on
    the one path the trim window exists to protect."""
    backend, calls = _recording_backend(monkeypatch)

    # window 0.8 == 2 * CROSSFADE_S, so the crossfaded loop is unavailable and
    # the degenerate hard-loop branch is taken.
    await _render(
        backend,
        tmp_path,
        duration=8.0,
        clip_duration=30.0,
        trim_in=0.0,
        trim_window=2 * CROSSFADE_S,
    )

    assert len(calls) == 2, "expected the window to be baked, then the segment rendered"
    bake, render = calls

    # The bake takes exactly the window, from the trim-in.
    assert _value(bake, "-t") == f"{2 * CROSSFADE_S:.3f}"
    windowed = bake[-1]
    assert windowed.endswith("-win.mp4")

    # And the loop reads THAT, not the 30-second original.
    assert _input_after(render, "-stream_loop") == windowed
    assert _value(render, "-stream_loop") == "-1"
    assert _value(render, "-t") == "8.000"


async def test_a_hard_loop_with_no_trim_out_is_not_re_encoded_first(tmp_path, monkeypatch):
    """The bake is a full re-encode of the source; it must happen only when a
    trim actually shortens the window, never as a blanket cost on every short
    clip."""
    backend, calls = _recording_backend(monkeypatch)

    # No trim_window, and the clip itself is already shorter than a crossfade.
    await _render(backend, tmp_path, duration=8.0, clip_duration=0.5, trim_in=0.0)

    assert len(calls) == 1
    assert _input_after(calls[0], "-stream_loop") == str(tmp_path / "clip.mp4")


async def test_a_trim_in_alone_still_seeks_rather_than_re_encoding(tmp_path, monkeypatch):
    """A trim-in with no trim-out leaves the window equal to the tail, so
    there is nothing past it to hide and `-ss` on the input is enough."""
    backend, calls = _recording_backend(monkeypatch)

    await _render(backend, tmp_path, duration=8.0, clip_duration=1.0, trim_in=0.6)

    assert len(calls) == 1
    assert _value(calls[0], "-ss") == "0.600"
    assert _input_after(calls[0], "-stream_loop") == str(tmp_path / "clip.mp4")


async def test_a_clip_short_by_a_little_is_retimed_not_looped(tmp_path, monkeypatch):
    """Timing policy, in order: long enough → trim; short by ≤ the retime
    bound → slow slightly; shorter → loop. This is the first rung."""
    backend, calls = _recording_backend(monkeypatch)

    # 2.0s window under a 2.1s target: stretch 1.05, inside RETIME_MAX.
    await _render(backend, tmp_path, duration=2.1, clip_duration=2.0, trim_in=0.0)

    assert len(calls) == 1
    assert "-stream_loop" not in calls[0]
    video_filters = _value(calls[0], "-vf")
    assert "setpts=1.0500*(PTS-STARTPTS)" in video_filters
    assert 2.1 / 2.0 <= RETIME_MAX


async def test_a_clip_long_enough_is_simply_cut_to_its_window(tmp_path, monkeypatch):
    backend, calls = _recording_backend(monkeypatch)

    await _render(backend, tmp_path, duration=3.0, clip_duration=30.0, trim_in=1.5)

    assert len(calls) == 1
    assert "-stream_loop" not in calls[0]
    assert "setpts" not in _value(calls[0], "-vf")
    assert _value(calls[0], "-ss") == "1.500"
    assert _value(calls[0], "-t") == "3.000"


async def test_a_trim_that_consumed_the_whole_clip_is_void(tmp_path, monkeypatch):
    """A trim-in at or past the end would leave nothing to render; it is
    dropped rather than producing an empty segment."""
    backend, calls = _recording_backend(monkeypatch)

    await _render(backend, tmp_path, duration=1.0, clip_duration=2.0, trim_in=5.0)

    assert "-ss" not in calls[0]


async def test_a_stored_window_never_extends_past_the_clip(tmp_path, monkeypatch):
    """`trim_window` comes off a stored EDL and is advisory: it may only
    narrow what is left after the trim-in, never claim footage that is not
    there."""
    backend, calls = _recording_backend(monkeypatch)

    # 10s claimed, but only 1.0s follows the trim-in.
    await _render(backend, tmp_path, duration=0.5, clip_duration=3.0, trim_in=2.0, trim_window=10.0)

    assert len(calls) == 1
    assert _value(calls[0], "-t") == "0.500"
    assert "-stream_loop" not in calls[0], "a 1.0s tail covers a 0.5s target without looping"


async def test_a_referenced_narration_that_vanished_fails_loudly(tmp_path, monkeypatch):
    """Corruption, not a silent scene: the timeline says there is speech here."""
    backend, _ = _recording_backend(monkeypatch)

    with pytest.raises(GenerationError, match="narration artifact is missing"):
        await _render(
            backend,
            tmp_path,
            duration=1.0,
            clip_duration=2.0,
            scene="s1",
            narration=str(tmp_path / "gone.wav"),
        )


async def test_a_chained_crossfade_mix_is_restamped_before_the_encoder(tmp_path, monkeypatch):
    """The defect: every crossfade boundary chains another `amix`, and a mix
    that reaches the AAC encoder unrestamped can carry timestamps the muxer
    then "corrects" by ending the stream — a complete picture whose narration
    stops seconds in, with the job reporting success and the file cached.

    The rendering half of this lives in test_assembly.py and asks the shipped
    file what a viewer hears. It cannot be the only half: the corruption is
    nondeterministic, and roughly half of runs on the unrestamped graph still
    produce a full-length stream. The graph is the same every time."""
    backend, calls = _recording_backend(monkeypatch)

    await _join(backend, tmp_path, ["crossfade"] * 3)
    args = calls[-1]
    graph = _value(args, "-filter_complex")

    assert graph.count("amix") == 3  # one per crossfade boundary
    assert graph.endswith("aresample=async=1:first_pts=0[aout]")
    assert _maps(args)[-1] == "[aout]", "the encoder must read the restamped mix, not the raw one"


async def test_an_all_cut_join_leaves_the_audio_chain_untouched(tmp_path, monkeypatch):
    """The restamp answers a defect in the mix, so a timeline that never
    mixes keeps the graph it had."""
    backend, calls = _recording_backend(monkeypatch)

    await _join(backend, tmp_path, ["cut", "cut"])
    graph = _value(calls[-1], "-filter_complex")

    assert "amix" not in graph
    assert "aresample" not in graph


async def test_a_crossfade_after_a_cut_agrees_on_a_timebase(tmp_path, monkeypatch):
    """The defect: xfade refuses a pair of inputs whose timebases disagree,
    and these two reach it from different places — the concat filter emits
    AVTB where a raw segment carries whatever its encoder chose. A board with
    a cut on one seam and a crossfade on the next therefore failed the whole
    export at filter-configure time, which is two clicks from the timeline
    strip. Stamping both sides makes the pair agree whichever fed them."""
    backend, calls = _recording_backend(monkeypatch)

    await _join(backend, tmp_path, ["cut", "crossfade"])
    graph = _value(calls[-1], "-filter_complex")

    assert "concat=n=2" in graph  # the boundary whose output carries AVTB
    assert graph.count("settb=AVTB") == 2  # both xfade inputs, not just the raw one
    assert "[xa2][xb2]xfade=" in graph
