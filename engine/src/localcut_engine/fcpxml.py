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
from .otio import FPS, edl_to_otio, timeline_seconds

_RATE = int(FPS)


def _rt(seconds: float) -> str:
    """Frame-aligned rational time ("41/24s"); FCP rejects mid-frame cuts."""
    frames = round(seconds * _RATE)
    return "0s" if frames == 0 else f"{frames}/{_RATE}s"


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

    def asset_ref(clip: dict, audio: bool) -> str:
        media = clip["media_reference"]
        url = media["target_url"]
        asset = assets.get(url)
        if asset is None:
            available = media["available_range"]["duration"]
            asset = ET.SubElement(
                resources,
                "asset",
                id=f"r{len(assets) + 2}",
                name=str(clip.get("name") or Path(url).name),
                start="0s",
                duration=_rt(available["value"] / available["rate"]),
            )
            ET.SubElement(asset, "media-rep", kind="original-media", src=url)
            assets[url] = asset
        asset.set("hasAudio" if audio else "hasVideo", "1")
        return asset.get("id")

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", name="LocalCut")
    project = ET.SubElement(event, "project", name=name)
    sequence = ET.SubElement(
        project,
        "sequence",
        format="r1",
        duration=_rt(timeline_seconds(doc)),
        tcStart="0s",
        tcFormat="NDF",
    )
    spine = ET.SubElement(sequence, "spine")

    # Video: spine children lay out sequentially; transitions sit at seams.
    anchor: ET.Element | None = None  # first spine clip/gap — audio attaches here
    anchor_start = 0.0  # its source in-point (parent time base for lanes)
    for child in tracks["Video"]["children"]:
        match child["OTIO_SCHEMA"]:
            case "Clip.1":
                element = ET.SubElement(
                    spine,
                    "asset-clip",
                    ref=asset_ref(child, audio=False),
                    name=str(child.get("name") or ""),
                    start=_rt(_node_start(child)),
                    duration=_rt(_node_seconds(child)),
                )
            case "Gap.1":
                element = ET.SubElement(
                    spine, "gap", name="Synthesized", start="0s", duration=_rt(_node_seconds(child))
                )
            case _:  # Transition.1
                offsets = child["in_offset"], child["out_offset"]
                ET.SubElement(
                    spine,
                    "transition",
                    name="Cross Dissolve",
                    duration=_rt(sum(o["value"] / o["rate"] for o in offsets)),
                )
                continue
        if anchor is None:
            anchor = element
            anchor_start = _node_start(child) if child["OTIO_SCHEMA"] == "Clip.1" else 0.0

    if anchor is None:
        raise ValueError("timeline EDL produced no spine elements")

    # Connected audio: offsets are in the parent's source time base, so a
    # clip at timeline t lands at anchor_start + t.
    def attach_audio(track_name: str, lane: str) -> None:
        position = 0.0
        for child in tracks.get(track_name, {}).get("children", []):
            if child["OTIO_SCHEMA"] == "Clip.1":
                ET.SubElement(
                    anchor,
                    "asset-clip",
                    ref=asset_ref(child, audio=True),
                    name=str(child.get("name") or ""),
                    lane=lane,
                    offset=_rt(anchor_start + position),
                    start=_rt(_node_start(child)),
                    duration=_rt(_node_seconds(child)),
                )
            position += _node_seconds(child)

    attach_audio("Narration", "-1")
    attach_audio("Music", "-2")

    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + ET.tostring(
        root, encoding="unicode"
    )
