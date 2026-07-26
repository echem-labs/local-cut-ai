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


def _frames_of(rational: str) -> int:
    return 0 if rational == "0s" else int(rational.removesuffix("s").partition("/")[0])


def _sweep_documents(trials: int = 400):
    """Randomised EDLs across the shapes that made rounding disagree: short
    sources, trims, over- and under-length segments, every transition."""
    import random

    random.seed(20260725)
    for _ in range(trials):
        segments, start = [], 0.0
        for index in range(random.randint(1, 6)):
            source = round(random.uniform(1.0, 8.0), 3)
            duration = round(random.uniform(0.4, source + 2.0), 3)
            segments.append(
                seg(
                    f"s{index + 1}",
                    duration,
                    round(start, 3),
                    transition=random.choice(["cut", "cut", "crossfade", "dip"]),
                    src_durations=(source,),
                    trim_in=round(random.uniform(0.0, max(0.0, source - 0.2)), 3),
                )
            )
            start += duration
        yield parse(edl_to_fcpxml(edl(segments), RESOLVE, "sweep"))


def test_no_clip_ever_requests_a_frame_past_its_own_asset():
    """start and duration were rounded to frames independently of the
    asset's duration, so a trimmed clip could ask for one frame past the end
    of the media it references — e.g. <asset duration="89/24s"> with
    <asset-clip start="30/24s" duration="60/24s">. Final Cut rejects the
    whole document."""
    for root in _sweep_documents():
        assets = {
            asset.get("id"): _frames_of(asset.get("duration"))
            for asset in root.findall(".//resources/asset")
        }
        # .iter(): connected narration/music lanes are asset-clips too.
        for clip in root.find(".//sequence/spine").iter("asset-clip"):
            start = _frames_of(clip.get("start"))
            duration = _frames_of(clip.get("duration"))
            assert duration >= 1, "a zero-length clip is not a clip"
            assert start + duration <= assets[clip.get("ref")], (
                f"clip runs {start + duration - assets[clip.get('ref')]} frame(s) past its asset"
            )


def test_the_sequence_is_exactly_as_long_as_its_spine():
    """The sequence duration was rounded from the whole timeline while each
    element was rounded individually, so the declared length exceeded the
    content it held — leaving phantom black at the tail and pushing the
    connected narration and music past the last clip."""
    for root in _sweep_documents():
        spine = root.find(".//sequence/spine")
        held = sum(
            _frames_of(child.get("duration"))
            for child in spine
            if child.tag in ("asset-clip", "gap")
        )
        assert _frames_of(root.find(".//sequence").get("duration")) == held


def test_no_element_is_emitted_with_a_zero_duration():
    """A sub-frame span rounds to 0 frames and emits duration="0s", which FCP
    treats as invalid rather than as "nothing to see here"."""
    for root in _sweep_documents():
        for child in root.find(".//sequence/spine"):
            assert _frames_of(child.get("duration")) >= 1, f"{child.tag} has zero duration"
