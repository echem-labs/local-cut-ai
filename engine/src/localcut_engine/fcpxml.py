"""EDL → FCPXML for Final Cut Pro handoff.

Serialized from the OTIO document rather than the raw EDL: `edl_to_otio`
already owns the hard timing work (crossfade tail-trimming across segment
boundaries, voided trims, synth gaps), so this stays a pure format
translation with a single timing authority — the FCPXML sequence is the
same length as the OTIO timeline is the same length as the rendered MP4.

Mapping: video-track clips become spine `asset-clip`s (sequential, source
in-points preserved), synth spans become `gap`s, dissolve transitions
become Cross Dissolve `transition` elements at the seam. Narration and
music ride as connected audio clips (lanes -1/-2) anchored to the first
spine element, offset in the parent's source time base per the FCPXML
spec. All times are frame-aligned rationals at the project rate — FCP
rejects mid-frame boundaries.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from xml.etree import ElementTree as ET

from .aspects import EXPORT_RESOLUTIONS, resolution_for
from .otio import FPS, edl_to_otio

_RATE = int(FPS)


def _xml_safe(text: str) -> str:
    """Keep only characters XML 1.0 permits as content: tab/newline/CR, and
    the ranges U+0020–U+D7FF, U+E000–U+FFFD, U+10000–U+10FFFF. This drops C0
    controls, lone surrogates (U+D800–U+DFFF), and the noncharacters
    U+FFFE/U+FFFF — any of which, in a title or clip name (e.g. a stray NUL
    from an LLM-authored title, or a surrogate from a surrogateescape decode),
    would make the whole FCPXML non-well-formed, or crash the UTF-8 encode of
    the HTTP response, so FCP (and any conformant parser) rejects the entire
    export rather than the one bad field."""
    return "".join(
        ch
        for ch in text
        if ch in "\t\n\r"
        or 0x20 <= ord(ch) <= 0xD7FF
        or 0xE000 <= ord(ch) <= 0xFFFD
        or 0x10000 <= ord(ch) <= 0x10FFFF
    )


def _frames(seconds: float) -> int:
    """Seconds to whole frames at the project rate."""
    return round(seconds * _RATE)


def _ft(frames: int) -> str:
    """Frame count as an FCPXML rational time ("41/24s")."""
    return "0s" if frames == 0 else f"{frames}/{_RATE}s"


def _rt(seconds: float) -> str:
    """Frame-aligned rational time; FCP rejects mid-frame cuts."""
    return _ft(_frames(seconds))


def _node_seconds(node: dict) -> float:
    d = node["source_range"]["duration"]
    return d["value"] / d["rate"]


def _node_start(node: dict) -> float:
    s = node["source_range"]["start_time"]
    return s["value"] / s["rate"]


def edl_to_fcpxml(edl: dict, resolve: Callable[[str], Path], name: str) -> str:
    """Convert a v5 EDL into an FCPXML 1.11 document (XML text). Raises
    ValueError for non-exportable EDLs, same contract as edl_to_otio."""
    doc = edl_to_otio(edl, resolve, name)
    name = _xml_safe(name)  # user/LLM-authored title — never emit a raw control char
    tracks = {t["name"]: t for t in doc["tracks"]["children"]}
    width, height = resolution_for(EXPORT_RESOLUTIONS, edl.get("aspect"))

    root = ET.Element("fcpxml", version="1.11")
    resources = ET.SubElement(root, "resources")
    ET.SubElement(
        resources,
        "format",
        id="r1",
        name=f"LocalCut {width}x{height}p{_RATE}",
        frameDuration=f"1/{_RATE}s",
        width=str(width),
        height=str(height),
    )

    # One asset resource per referenced media file, keyed by url so a file
    # used in more than one role (video + audio) is a single asset carrying
    # both flags — a video-only asset would import silent.
    assets: dict[str, ET.Element] = {}

    # url -> the asset's duration in whole frames. Clip windows are clamped
    # against this, so a clip can never claim a frame the asset doesn't have.
    asset_frames: dict[str, int] = {}

    def asset_ref(clip: dict, audio: bool) -> str:
        media = clip["media_reference"]
        url = media["target_url"]
        asset = assets.get(url)
        if asset is None:
            available = media["available_range"]["duration"]
            frames = _frames(available["value"] / available["rate"])
            asset = ET.SubElement(
                resources,
                "asset",
                id=f"r{len(assets) + 2}",
                name=_xml_safe(str(clip.get("name") or Path(url).name)),
                start="0s",
                duration=_ft(frames),
            )
            ET.SubElement(asset, "media-rep", kind="original-media", src=url)
            assets[url] = asset
            asset_frames[url] = frames
        asset.set("hasAudio" if audio else "hasVideo", "1")
        return asset.get("id")

    def clip_window(clip: dict) -> tuple[int, int]:
        """A clip's (start, duration) in frames, guaranteed to fit inside the
        asset it references.

        Rounding `start` and `duration` independently of the asset's own
        duration lets a trimmed clip ask for one frame past the end of its
        media — `<asset duration="89/24s">` with `<asset-clip start="30/24s"
        duration="60/24s">` — and Final Cut rejects the whole document. The
        clamp costs at most one frame of tail, always on a clip that was
        already at the very end of its source.
        """
        start = max(0, _frames(_node_start(clip)))
        duration = max(1, _frames(_node_seconds(clip)))
        available = asset_frames.get(clip["media_reference"]["target_url"])
        if available:
            start = min(start, max(0, available - 1))
            duration = min(duration, available - start)
        return start, max(1, duration)

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", name="LocalCut")
    project = ET.SubElement(event, "project", name=name)
    sequence = ET.SubElement(
        project, "sequence", format="r1", duration="0s", tcStart="0s", tcFormat="NDF"
    )
    spine = ET.SubElement(sequence, "spine")

    # Video: spine children lay out sequentially; transitions sit at seams.
    anchor: ET.Element | None = None  # first spine clip/gap — audio attaches here
    anchor_start = 0  # its source in-point, in frames (parent time base for lanes)
    spine_frames = 0  # what the spine ACTUALLY holds — see the duration note below
    for child in tracks["Video"]["children"]:
        match child["OTIO_SCHEMA"]:
            case "Clip.1":
                # asset_ref FIRST: it is what registers the asset's frame
                # count, and clip_window clamps against exactly that.
                ref = asset_ref(child, audio=False)
                start, duration = clip_window(child)
                element = ET.SubElement(
                    spine,
                    "asset-clip",
                    ref=ref,
                    name=_xml_safe(str(child.get("name") or "")),
                    start=_ft(start),
                    duration=_ft(duration),
                )
                spine_frames += duration
            case "Gap.1":
                # A zero-length gap is not a gap. Rounding a sub-frame span to
                # 0 frames emits `duration="0s"`, which FCP treats as invalid
                # rather than as "nothing to see here".
                duration = max(1, _frames(_node_seconds(child)))
                element = ET.SubElement(
                    spine, "gap", name="Synthesized", start="0s", duration=_ft(duration)
                )
                spine_frames += duration
            case _:  # Transition.1
                offsets = child["in_offset"], child["out_offset"]
                # A transition overlaps its neighbours; it adds no length of
                # its own, so it does not contribute to spine_frames.
                ET.SubElement(
                    spine,
                    "transition",
                    name="Cross Dissolve",
                    duration=_ft(max(1, _frames(sum(o["value"] / o["rate"] for o in offsets)))),
                )
                continue
        if anchor is None:
            anchor = element
            anchor_start = start if child["OTIO_SCHEMA"] == "Clip.1" else 0

    if anchor is None:
        raise ValueError("timeline EDL produced no spine elements")

    # The sequence is exactly as long as its spine.
    #
    # Rounding the whole timeline once while rounding each element
    # individually made the declared length drift from the content — 4 frames
    # over 40 scenes, ~28 (1.2s) at the 20-minute cap — which left phantom
    # black at the tail and pushed the connected narration and music past the
    # last clip. It also contradicted this module's own stated invariant that
    # the FCPXML, the OTIO timeline and the rendered MP4 are the same length.
    # Summing the emitted frame counts is the only value that cannot drift.
    sequence.set("duration", _ft(spine_frames))

    # Connected audio: offsets are in the parent's source time base, so a
    # clip at timeline t lands at anchor_start + t.
    def attach_audio(track_name: str, lane: str) -> None:
        # Frames, not seconds: accumulating float positions and rounding each
        # one independently lets the lane drift away from the spine it is
        # anchored to, exactly as the sequence duration used to.
        position = 0
        for child in tracks.get(track_name, {}).get("children", []):
            if child["OTIO_SCHEMA"] == "Clip.1":
                ref = asset_ref(child, audio=True)  # registers the frame count
                start, duration = clip_window(child)
                ET.SubElement(
                    anchor,
                    "asset-clip",
                    ref=ref,
                    name=_xml_safe(str(child.get("name") or "")),
                    lane=lane,
                    offset=_ft(anchor_start + position),
                    start=_ft(start),
                    duration=_ft(duration),
                )
                position += duration
            else:
                position += max(0, _frames(_node_seconds(child)))

    attach_audio("Narration", "-1")
    attach_audio("Music", "-2")

    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + ET.tostring(
        root, encoding="unicode"
    )
