"""FCPXML serialization over the OTIO timing authority — pure Python,
runs everywhere. Length fidelity is otio.py's job (tested there); these
pin the FCPXML shape: frame-aligned times, spine layout, lanes."""

from xml.etree import ElementTree as ET

import pytest
from test_otio import RESOLVE, edl, seg

from localcut_engine.fcpxml import edl_to_fcpxml


def parse(text: str) -> ET.Element:
    assert text.startswith('<?xml version="1.0"')
    return ET.fromstring(text.split("<!DOCTYPE fcpxml>\n", 1)[1])


def frames(rational: str) -> float:
    if rational == "0s":
        return 0.0
    value, _, _ = rational.removesuffix("s").partition("/")
    return int(value) / 24


def test_cuts_produce_a_sequential_spine_with_frame_aligned_times():
    root = parse(edl_to_fcpxml(edl([seg("s1", 3.0, 0.0), seg("s2", 2.0, 3.0)]), RESOLVE, "cuts"))
    sequence = root.find(".//sequence")
    assert sequence.get("format") == "r1"
    assert frames(sequence.get("duration")) == pytest.approx(5.0, abs=0.05)
    spine = sequence.find("spine")
    clips = spine.findall("asset-clip")
    assert len(clips) == 2
    assert sum(frames(c.get("duration")) for c in clips) == pytest.approx(5.0, abs=0.05)
    for clip in clips:  # every time is a whole-frame rational at 24fps
        for attribute in ("start", "duration"):
            assert clip.get(attribute) == "0s" or clip.get(attribute).endswith("/24s")
    # Media references resolve to real file URLs in resources.
    asset = root.find(".//resources/asset")
    assert asset.find("media-rep").get("src").startswith("file://")


def test_crossfade_emits_a_dissolve_and_keeps_program_length():
    root = parse(
        edl_to_fcpxml(
            edl([seg("s1", 3.0, 0.0, transition="crossfade"), seg("s2", 2.0, 2.6)]),
            RESOLVE,
            "xfade",
        )
    )
    spine = root.find(".//spine")
    transition = spine.find("transition")
    assert transition is not None and transition.get("name") == "Cross Dissolve"
    laid = sum(frames(c.get("duration")) for c in spine if c.tag in ("asset-clip", "gap"))
    assert laid == pytest.approx(4.6, abs=0.05)  # 3 + 2 − 0.4, same as the MP4
    assert frames(root.find(".//sequence").get("duration")) == pytest.approx(4.6, abs=0.05)


def test_narration_and_music_ride_connected_lanes():
    root = parse(
        edl_to_fcpxml(
            edl(
                [seg("s1", 3.0, 0.0), seg("s2", 2.0, 3.0)],
                music="m.wav",
                music_duration=99.0,
            ),
            RESOLVE,
            "lanes",
        )
    )
    spine = root.find(".//spine")
    first = spine.find("asset-clip")
    narration = [c for c in first.findall("asset-clip") if c.get("lane") == "-1"]
    music = [c for c in first.findall("asset-clip") if c.get("lane") == "-2"]
    assert len(narration) == 2
    # Second narration line starts where scene 2 starts.
    assert frames(narration[1].get("offset")) == pytest.approx(3.0, abs=0.05)
    assert len(music) == 1
    assert frames(music[0].get("duration")) == pytest.approx(5.0, abs=0.05)  # clamped
    # Audio assets are marked as such in resources.
    ids = {c.get("ref") for c in narration + music}
    for asset in root.findall(".//resources/asset"):
        if asset.get("id") in ids:
            assert asset.get("hasAudio") == "1"


def test_empty_edl_raises():
    with pytest.raises(ValueError):
        edl_to_fcpxml({"node": "mock"}, RESOLVE, "x")
