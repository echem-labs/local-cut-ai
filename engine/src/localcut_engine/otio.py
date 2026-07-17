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
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

FPS = 24.0


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


def _track(kind: str, name: str, children: list[dict]) -> dict:
    return {"OTIO_SCHEMA": "Track.1", "kind": kind, "name": name, "children": children}


def edl_to_otio(edl: dict, resolve: Callable[[str], Path], name: str) -> dict:
    """Convert a v5 EDL into an OTIO timeline document. Raises ValueError
    when the EDL carries no usable segments (e.g. mock artifacts)."""
    segments = edl.get("video")
    if not isinstance(segments, list) or not segments:
        raise ValueError("timeline EDL has no video segments to export")

    video: list[dict] = []
    narration: list[dict] = []
    for segment in segments:
        window = float(segment["duration"])
        srcs = segment.get("srcs") or ([segment["src"]] if segment.get("src") else [])
        durations = segment.get("src_durations") or []
        if len(durations) != len(srcs):
            raise ValueError(f"segment {segment.get('scene')}: takes without durations")

        remaining, offset = window, float(segment.get("trim_in") or 0.0)
        for index, (src, available) in enumerate(zip(srcs, durations)):
            if remaining <= 0.001:
                break
            if offset >= available:
                offset -= available
                continue
            use = min(available - offset, remaining)
            take_name = str(segment["scene"]) + (f" take {index + 1}" if len(srcs) > 1 else "")
            video.append(_clip(take_name, resolve(src), offset, use, available))
            remaining -= use
            offset = 0.0
        if remaining > 0.001:
            # Export synthesizes this span (bounded retime or crossfaded
            # loop); media can't state it, so the handoff shows a gap.
            video.append(_gap(remaining))

        narr = segment.get("narration")
        narr_duration = segment.get("narration_duration")
        if narr and narr_duration:
            spoken = min(float(narr_duration), window)
            narration.append(
                _clip(
                    f"{segment['scene']} narration",
                    resolve(narr),
                    0.0,
                    spoken,
                    float(narr_duration),
                )
            )
            if window - spoken > 0.001:
                narration.append(_gap(window - spoken))
        else:
            narration.append(_gap(window))

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
