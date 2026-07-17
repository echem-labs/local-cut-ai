"""Pure-Python tests for the EDL → OTIO converter — no ffmpeg needed, so
these run everywhere (the real-render OTIO tests in test_assembly.py are
ffmpeg-gated). They pin the length invariant (OTIO timeline == EDL program)
and the crossfade-transition behaviour against hand-crafted EDLs."""

from pathlib import Path

import pytest

from localcut_engine.otio import edl_to_otio, timeline_seconds

RESOLVE = lambda src: Path("/tmp/generated") / src  # noqa: E731


def seg(
    scene,
    duration,
    start,
    *,
    transition="cut",
    srcs=("clip.mp4",),
    src_durations=(4.0,),
    narration="n.wav",
    narration_duration=None,
    trim_in=0.0,
):
    return {
        "scene": scene,
        "srcs": list(srcs),
        "src_durations": list(src_durations),
        "narration": narration,
        "narration_duration": narration_duration if narration_duration is not None else duration,
        "start": start,
        "duration": duration,
        "clip_duration": sum(src_durations),
        "trim_in": trim_in,
        "transition": transition,
        "onscreen_text": None,
    }


def edl(segments, **top):
    duration = round(segments[-1]["start"] + segments[-1]["duration"], 3)
    return {"duration": duration, "video": segments, **top}


def video_children(doc):
    return doc["tracks"]["children"][0]["children"]


def transitions(doc):
    return [c for c in video_children(doc) if c["OTIO_SCHEMA"] == "Transition.1"]


def test_cuts_only_length_and_no_transitions():
    doc = edl_to_otio(edl([seg("s1", 3.0, 0.0), seg("s2", 2.0, 3.0)]), RESOLVE, "cuts")
    assert timeline_seconds(doc) == pytest.approx(5.0, abs=0.02)
    assert transitions(doc) == []


def test_crossfade_shortens_timeline_and_marks_the_seam():
    # s1 crossfades into s2: s2's start is pulled back 0.4s → program 4.6s.
    doc = edl_to_otio(
        edl([seg("s1", 3.0, 0.0, transition="crossfade"), seg("s2", 2.0, 2.6)]),
        RESOLVE,
        "xfade",
    )
    assert timeline_seconds(doc) == pytest.approx(4.6, abs=0.02)  # 3 + 2 - 0.4
    t = transitions(doc)
    assert len(t) == 1
    assert t[0]["transition_type"] == "SMPTE_Dissolve"
    assert t[0]["in_offset"]["value"] > 0 and t[0]["out_offset"]["value"] > 0
    # A transition may never be the first or last item on a track.
    kids = video_children(doc)
    assert kids[0]["OTIO_SCHEMA"] != "Transition.1"
    assert kids[-1]["OTIO_SCHEMA"] != "Transition.1"
    # Narration track carries no transition (single track can't hold the mix).
    narr = doc["tracks"]["children"][1]["children"]
    assert not [c for c in narr if c["OTIO_SCHEMA"] == "Transition.1"]


def test_crossfade_into_short_segment_trims_across_the_boundary():
    """Regression: a crossfade whose outgoing segment is shorter than the
    overlap must trim the remainder from the preceding scene — the OTIO
    timeline stays equal to the rendered program and the dissolve survives."""
    doc = edl_to_otio(
        edl(
            [
                seg("s1", 2.0, 0.0),
                # 0.3s beat that crossfades into s3; assembly pulled s3 back to 1.9.
                seg("s2", 0.3, 2.0, transition="crossfade", narration=None),
                seg("s3", 2.0, 1.9),
            ]
        ),
        RESOLVE,
        "short-xfade",
    )
    assert timeline_seconds(doc) == pytest.approx(3.9, abs=0.02)  # not 4.0
    assert len(transitions(doc)) == 1  # the dissolve is not dropped


def test_trim_in_past_the_clip_is_voided_like_export():
    """Regression: a trim_in beyond the media length must render from 0 (a
    real clip), not collapse to a black gap — matching _render_segment."""
    doc = edl_to_otio(
        edl([seg("s1", 1.35, 0.0, src_durations=(2.0,), narration_duration=1.0, trim_in=3.0)]),
        RESOLVE,
        "over-trim",
    )
    kinds = [c["OTIO_SCHEMA"] for c in video_children(doc)]
    assert "Clip.1" in kinds  # picture, not a full black gap


def test_two_crossfades_in_a_row():
    doc = edl_to_otio(
        edl(
            [
                seg("s1", 3.0, 0.0, transition="crossfade"),
                seg("s2", 3.0, 2.6, transition="crossfade"),
                seg("s3", 2.0, 5.2),
            ]
        ),
        RESOLVE,
        "double",
    )
    assert timeline_seconds(doc) == pytest.approx(8.0 - 0.8, abs=0.03)  # sum − 2×0.4
    assert len(transitions(doc)) == 2


def test_dip_hands_off_as_a_cut():
    # A dip doesn't overlap starts, so no transition and no trim.
    doc = edl_to_otio(
        edl([seg("s1", 3.0, 0.0, transition="dip"), seg("s2", 2.0, 3.0)]), RESOLVE, "dip"
    )
    assert timeline_seconds(doc) == pytest.approx(5.0, abs=0.02)
    assert transitions(doc) == []


def test_empty_edl_raises():
    with pytest.raises(ValueError, match="no video segments"):
        edl_to_otio({"node": "mock"}, RESOLVE, "x")


def test_music_never_dominates_timeline_length():
    doc = edl_to_otio(
        edl([seg("s1", 3.0, 0.0)], music="m.wav", music_duration=99.0), RESOLVE, "music"
    )
    # Music clip is clamped to the program length, so it can't inflate the max.
    assert timeline_seconds(doc) == pytest.approx(3.0, abs=0.02)
