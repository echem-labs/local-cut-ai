"""EDL → OpenTimelineIO for pro-NLE handoff.

Emits plain OTIO JSON (Timeline.1 schema) straight from the cached EDL —
no opentimelineio dependency for a serialize-only path. Resolve/DaVinci,
Premiere (via otio adapters) and FCP tooling read this; media references
point at the project's generated artifacts on disk.

The document mirrors what the EDL can state faithfully: video clips with
their real source ranges (a scene's sequential takes become consecutive
clips), the narration bed with true durations, and the music bed. Where
export-time synthesis (retime/loop) fills a gap the media can't, a Gap
lands in the track instead of a lying source range.

Crossfades become OTIO dissolve transitions. OTIO's model: transitions are
neighbours that overlap adjacent clips, so a track's duration is the sum of
its *clip/gap* durations — transitions contribute zero. Our export instead
shortens the program by the overlap, so to keep the OTIO timeline the same
length as the rendered MP4 the outgoing clip is trimmed by the overlap and a
`SMPTE_Dissolve` marks the seam. Dips don't change length and have no
portable OTIO primitive (a fade *through* colour isn't a cross-dissolve), so
they hand off as cuts — the editor re-applies the fade on clean sources.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

FPS = 24.0
# Consecutive segment starts that overlap by more than this are a crossfade;
# the threshold clears EDL rounding noise (≤ a few ms) while sitting far
# below a real crossfade overlap (~0.4 s).
_OVERLAP_EPS_S = 0.05


def _time(seconds: float) -> dict:
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": FPS, "value": round(seconds * FPS, 3)}


def _range(start_s: float, duration_s: float) -> dict:
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": _time(start_s),
        "duration": _time(duration_s),
    }


def _clip(name: str, src: Path, start_s: float, duration_s: float, available_s: float) -> dict:
    return {
        "OTIO_SCHEMA": "Clip.1",
        "name": name,
        "source_range": _range(start_s, duration_s),
        "media_reference": {
            "OTIO_SCHEMA": "ExternalReference.1",
            "target_url": src.as_uri(),
            "available_range": _range(0.0, available_s),
        },
    }


def _gap(duration_s: float) -> dict:
    return {"OTIO_SCHEMA": "Gap.1", "source_range": _range(0.0, duration_s)}


def _transition(in_offset_s: float, out_offset_s: float) -> dict:
    return {
        "OTIO_SCHEMA": "Transition.1",
        "name": "crossfade",
        "transition_type": "SMPTE_Dissolve",
        "in_offset": _time(in_offset_s),
        "out_offset": _time(out_offset_s),
        "metadata": {},
    }


def _track(kind: str, name: str, children: list[dict]) -> dict:
    return {"OTIO_SCHEMA": "Track.1", "kind": kind, "name": name, "children": children}


def _to_otio(item: dict) -> dict:
    """Internal mutable item → OTIO node."""
    if item["kind"] == "clip":
        return _clip(item["name"], item["src"], item["src_start"], item["dur"], item["available"])
    return _gap(item["dur"])


def _trim_tail(items: list[dict], amount: float) -> None:
    """Remove `amount` seconds from the end of a segment's item list —
    shrinking or dropping trailing items so its total shortens by the
    crossfade overlap (a clip loses source-range from its tail; a gap
    shrinks). Mutates `items` in place."""
    amount = round(amount, 3)
    while amount > 0.001 and items:
        last = items[-1]
        if last["dur"] <= amount + 0.001:
            amount = round(amount - last["dur"], 3)
            items.pop()
        else:
            last["dur"] = round(last["dur"] - amount, 3)
            amount = 0.0


def _segment_video(segment: dict, resolve: Callable[[str], Path]) -> list[dict]:
    """The clip/gap items that fill a segment's window — one clip per take,
    a trailing gap where export synthesizes frames media can't state."""
    window = float(segment["duration"])
    srcs = segment.get("srcs") or ([segment["src"]] if segment.get("src") else [])
    durations = segment.get("src_durations") or []
    if len(durations) != len(srcs):
        raise ValueError(f"segment {segment.get('scene')}: takes without durations")

    items: list[dict] = []
    remaining, offset = window, float(segment.get("trim_in") or 0.0)
    for index, (src, available) in enumerate(zip(srcs, durations)):
        if remaining <= 0.001:
            break
        if offset >= available:
            offset -= available
            continue
        use = min(available - offset, remaining)
        take_name = str(segment["scene"]) + (f" take {index + 1}" if len(srcs) > 1 else "")
        items.append(
            {
                "kind": "clip",
                "name": take_name,
                "src": resolve(src),
                "src_start": offset,
                "dur": round(use, 3),
                "available": available,
            }
        )
        remaining -= use
        offset = 0.0
    if remaining > 0.001:
        items.append({"kind": "gap", "dur": round(remaining, 3)})
    return items


def _segment_narration(segment: dict, resolve: Callable[[str], Path]) -> list[dict]:
    window = float(segment["duration"])
    narr = segment.get("narration")
    narr_duration = segment.get("narration_duration")
    if narr and narr_duration:
        spoken = min(float(narr_duration), window)
        items = [
            {
                "kind": "clip",
                "name": f"{segment['scene']} narration",
                "src": resolve(narr),
                "src_start": 0.0,
                "dur": round(spoken, 3),
                "available": float(narr_duration),
            }
        ]
        if window - spoken > 0.001:
            items.append({"kind": "gap", "dur": round(window - spoken, 3)})
        return items
    return [{"kind": "gap", "dur": round(window, 3)}]


def _overlaps(segments: list[dict]) -> list[float]:
    """Overlap (seconds) each segment shares with the next, read straight
    from the EDL's applied start positions — a crossfade pulls the next
    start back, a cut/dip does not. Zero for the last segment."""
    overlaps: list[float] = []
    for i in range(len(segments) - 1):
        end = float(segments[i]["start"]) + float(segments[i]["duration"])
        overlap = round(end - float(segments[i + 1]["start"]), 3)
        overlaps.append(overlap if overlap > _OVERLAP_EPS_S else 0.0)
    overlaps.append(0.0)
    return overlaps


def edl_to_otio(edl: dict, resolve: Callable[[str], Path], name: str) -> dict:
    """Convert a v5 EDL into an OTIO timeline document. Raises ValueError
    when the EDL carries no usable segments (e.g. mock artifacts)."""
    segments = edl.get("video")
    if not isinstance(segments, list) or not segments:
        raise ValueError("timeline EDL has no video segments to export")

    seg_video = [_segment_video(s, resolve) for s in segments]
    seg_narr = [_segment_narration(s, resolve) for s in segments]
    overlaps = _overlaps(segments)

    # Trim the outgoing side of each crossfade so track totals equal the
    # rendered (overlap-shortened) program, not the sum of full windows.
    for items, overlap in zip(seg_video, overlaps):
        if overlap:
            _trim_tail(items, overlap)
    for items, overlap in zip(seg_narr, overlaps):
        if overlap:
            _trim_tail(items, overlap)

    video: list[dict] = []
    narration: list[dict] = []
    for i, overlap in enumerate(overlaps):
        video.extend(_to_otio(item) for item in seg_video[i])
        narration.extend(_to_otio(item) for item in seg_narr[i])
        if overlap and seg_video[i] and seg_video[i + 1]:
            # Symmetric dissolve, clamped so neither offset exceeds the clip
            # it reaches into (an OTIO validity constraint).
            half = round(min(overlap / 2, seg_video[i][-1]["dur"], seg_video[i + 1][0]["dur"]), 3)
            video.append(_transition(half, half))

    tracks = [_track("Video", "Video", video), _track("Audio", "Narration", narration)]
    music = edl.get("music")
    music_duration = edl.get("music_duration")
    if music and music_duration:
        total = float(edl.get("duration") or 0.0)
        tracks.append(
            _track(
                "Audio",
                "Music",
                [
                    _clip(
                        "music bed",
                        resolve(music),
                        0.0,
                        min(float(music_duration), total) if total else float(music_duration),
                        float(music_duration),
                    )
                ],
            )
        )

    return {
        "OTIO_SCHEMA": "Timeline.1",
        "name": name,
        "global_start_time": _time(0.0),
        "tracks": {"OTIO_SCHEMA": "Stack.1", "name": "tracks", "children": tracks},
    }
