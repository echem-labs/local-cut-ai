"""EDL → OpenTimelineIO for pro-NLE handoff.

Emits plain OTIO JSON (Timeline.1 schema) straight from the cached EDL —
no opentimelineio dependency for a serialize-only path. Resolve/DaVinci,
Premiere (via otio adapters) and FCP tooling read this; media references
point at the project's generated artifacts on disk.

The document mirrors what the EDL can state faithfully: video clips with
their real source ranges (a scene's sequential takes become consecutive
clips), the narration bed with true durations, and the music bed. Where
export-time synthesis (retime/loop) fills a span the media can't, a Gap
lands in the track instead of a lying source range.

Crossfades become OTIO dissolve transitions. OTIO's model: transitions are
neighbours that overlap adjacent clips, so a track's duration is the sum of
its *clip/gap* durations — transitions contribute zero. Our export instead
shortens the program by the overlap, so to keep the OTIO timeline the same
length as the rendered MP4 the overlap is trimmed off the tail of the
material already laid down before the incoming segment is appended, and a
`SMPTE_Dissolve` marks the seam. The trim walks back across segment
boundaries, because assembly can crossfade into a segment shorter than the
overlap (the seam then eats into the preceding scene's tail too). Dips don't
change length and have no portable OTIO primitive (a fade *through* colour
isn't a cross-dissolve), so they hand off as cuts — the editor re-applies
the fade on clean sources.

Two fidelity limits are inherent to a single-track, clean-source handoff and
are not length errors: at a crossfade seam the outgoing narration is trimmed
to keep the track length honest (the rendered mix overlaps both lines at full
level, which one track can't hold), and a dissolve whose outgoing tail is a
synthesized Gap reads as a fade-from-black rather than the looped/retimed
frames the MP4 dissolves.
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


def _node_seconds(node: dict) -> float:
    """Seconds a clip/gap occupies on its track (transitions have none)."""
    d = node["source_range"]["duration"]
    return d["value"] / d["rate"]


def _trim_track_tail(nodes: list[dict], amount: float) -> None:
    """Remove `amount` seconds of clip/gap from the end of a track, mutating
    `nodes` in place. Crosses segment boundaries when a crossfade overlap
    exceeds the outgoing segment; transitions carry no duration and are
    stepped over rather than trimmed."""
    amount = round(amount, 3)
    i = len(nodes) - 1
    while amount > 0.001 and i >= 0:
        node = nodes[i]
        if node["OTIO_SCHEMA"] == "Transition.1":
            i -= 1
            continue
        dur = _node_seconds(node)
        if dur <= amount + 0.001:
            amount = round(amount - dur, 3)
            nodes.pop(i)
        else:
            node["source_range"]["duration"] = _time(round(dur - amount, 3))
            amount = 0.0
        i -= 1
    # A transition can never be the track tail: if the trim consumed the clip
    # that followed it, drop the now-dangling transition — otherwise callers
    # (and _node_seconds) treat it as a clip and KeyError on source_range.
    while nodes and nodes[-1]["OTIO_SCHEMA"] == "Transition.1":
        nodes.pop()


def _segment_video(segment: dict, resolve: Callable[[str], Path]) -> list[dict]:
    """The clip/gap nodes that fill a segment's window — one clip per take,
    a trailing gap where export synthesizes frames media can't state."""
    window = float(segment["duration"])
    srcs = segment.get("srcs") or ([segment["src"]] if segment.get("src") else [])
    durations = segment.get("src_durations") or []
    if len(durations) != len(srcs):
        raise ValueError(f"segment {segment.get('scene')}: takes without durations")

    trim_in = float(segment.get("trim_in") or 0.0)
    # A trim past the end of the media is void — mirrors _render_segment
    # (ffmpeg.py), which renders from 0 rather than a black frame.
    if trim_in >= sum(durations):
        trim_in = 0.0

    nodes: list[dict] = []
    remaining, offset = window, trim_in
    for index, (src, available) in enumerate(zip(srcs, durations)):
        if remaining <= 0.001:
            break
        if offset >= available:
            offset -= available
            continue
        use = min(available - offset, remaining)
        take_name = str(segment["scene"]) + (f" take {index + 1}" if len(srcs) > 1 else "")
        nodes.append(_clip(take_name, resolve(src), offset, round(use, 3), available))
        remaining -= use
        offset = 0.0
    if remaining > 0.001:
        nodes.append(_gap(round(remaining, 3)))
    return nodes


def _segment_narration(segment: dict, resolve: Callable[[str], Path]) -> list[dict]:
    window = float(segment["duration"])
    narr = segment.get("narration")
    narr_duration = segment.get("narration_duration")
    if narr and narr_duration:
        spoken = min(float(narr_duration), window)
        nodes = [
            _clip(
                f"{segment['scene']} narration",
                resolve(narr),
                0.0,
                round(spoken, 3),
                float(narr_duration),
            )
        ]
        if window - spoken > 0.001:
            nodes.append(_gap(round(window - spoken, 3)))
        return nodes
    return [_gap(round(window, 3))]


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


def timeline_seconds(doc: dict) -> float:
    """The document's timeline length, by OTIO's own rule: a track's length
    is the sum of its clip/gap durations (transitions overlap neighbours and
    add nothing), and the timeline is its longest track. The single source of
    truth `edl_to_otio` builds against."""

    def track_seconds(track: dict) -> float:
        return sum(
            _node_seconds(c) for c in track["children"] if c["OTIO_SCHEMA"] != "Transition.1"
        )

    return max((track_seconds(t) for t in doc["tracks"]["children"]), default=0.0)


def edl_to_otio(edl: dict, resolve: Callable[[str], Path], name: str) -> dict:
    """Convert a v5 EDL into an OTIO timeline document. Raises ValueError
    when the EDL carries no usable segments (e.g. mock artifacts)."""
    segments = edl.get("video")
    if not isinstance(segments, list) or not segments:
        raise ValueError("timeline EDL has no video segments to export")

    overlaps = _overlaps(segments)
    video: list[dict] = []
    narration: list[dict] = []
    for i, segment in enumerate(segments):
        seg_video = _segment_video(segment, resolve)
        seg_narr = _segment_narration(segment, resolve)
        # A crossfade at the previous boundary pulled this segment's start
        # back over the material already laid down: trim that overlap off the
        # accumulated tail (crossing segment boundaries) and mark the seam.
        overlap = overlaps[i - 1] if i > 0 else 0.0
        if overlap:
            _trim_track_tail(video, overlap)
            _trim_track_tail(narration, overlap)
            if video and seg_video:
                # Symmetric dissolve, clamped so neither offset exceeds the
                # clip it reaches into (an OTIO validity constraint).
                half = round(
                    min(overlap / 2, _node_seconds(video[-1]), _node_seconds(seg_video[0])), 3
                )
                video.append(_transition(half, half))
        video.extend(seg_video)
        narration.extend(seg_narr)

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
