"""FFmpeg assembly backend — deterministic, non-AI: per-scene timing, audio
mix, concat, export.

Timing authority: narration duration *drives* scene duration — each clip is
trimmed (or looped) to its narration plus padding, never the other way
around. With `beat_align` on the timeline node, scene boundaries snap to the
music's beat grid by flexing only the breathing pad — speech is never cut.
The music bed loops under the program and, by default, sidechain-ducks
beneath the narration (`ducking: false` restores the constant-level bed).
Prefers hardware/openh264 encoders per the licensing policy; mpeg4 is the
everything-else fallback — never GPL x264.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import json
import math
import os
import shutil
import tempfile
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from .. import fonts
from ..aspects import (
    DEFAULT_ASPECT,
    EXPORT_AUDIO_KBPS_BOUNDS,
    EXPORT_FPS_CHOICES,
    EXPORT_RESOLUTIONS,
    EXPORT_SHORT_SIDE_CHOICES,
    EXPORT_VIDEO_KBPS_BOUNDS,
    VIDEO_RESOLUTIONS,
    resolution_for,
)
from ..audio import ANALYSIS_RATE, estimate_beats, nearest_beat, waveform_peaks
from ..captions import srt_to_ass
from ..graph.compiler import JobSpec
from ..graph.model import (
    CAPTIONS_PORT,
    DEFAULT_PORT,
    KEYFRAME_PORT,
    MUSIC_PORT,
    SCENE_AUDIO_SUFFIX,
    NodeKind,
    scene_sort_key,
)
from ..notices import EXPORT_MUSIC_BED_DROPPED
from .base import ExecutionBackend, ExecutionContext, GenerationError

_KINDS = {NodeKind.CLIP, NodeKind.TIMELINE, NodeKind.EXPORT}
_STILL_CLIP_FPS = 24
_STILL_CLIP_ZOOM = 0.06  # total push-in over the clip ("stills become clips")

NARRATION_PAD_S = 0.35  # breathing room after each narration line
MUSIC_BED_VOLUME = 0.22  # constant-level bed under narration
# Beat alignment flexes only the pad: a boundary may shrink it to this floor
# (speech is never cut) or stretch at most this far to reach the next beat.
BEAT_MIN_PAD_S = 0.15
BEAT_SNAP_MAX_S = 0.35
CROSSFADE_S = 0.4  # video+audio overlap for the crossfade transition
DIP_S = 0.25  # fade-to-black halves of the dip transition
# A clip may be slowed at most this much to fill its narration window —
# visible slow-mo never ships silently; past the bound the clip loops with
# a crossfaded seam instead.
RETIME_MAX = 1.15
_MAX_LOOPS = 30  # loop-with-crossfade input cap (degenerate short clips)
# How long a terminated child gets to exit before it is killed outright.
_KILL_GRACE_S = 2.0

# How far the exported audio may fall short of the program before the export
# is refused instead of published. Generous on purpose: a healthy render lands
# within an AAC frame of the EDL, and the failure this catches loses seconds.
AUDIO_SHORTFALL_S = 0.5

# Export bitrate by quality tier; draft favors speed, final favors fidelity.
_VIDEO_BITRATE = {"draft": "4M", "final": "10M"}

# What the text probe draws, and on how big a frame: tall enough that the
# title's height-derived font size is a legible 25px.
_PROBE_TEXT = "LocalCut"
_PROBE_FRAME = (640, 360)


@asynccontextmanager
async def _terminating(process: asyncio.subprocess.Process):
    """Guarantee a child encoder dies with the job that started it.

    Without this, cancelling a render (app quit, project delete) leaves
    ffmpeg/ffprobe running detached — still burning CPU, still writing into a
    workdir that has already been removed. `communicate()` propagates the
    CancelledError but never touches the child, and nothing else ever will.
    """
    try:
        yield process
    except BaseException:
        # Every signal call is guarded. The child can exit between the
        # returncode check and the signal, and an unguarded ProcessLookupError
        # here would REPLACE the exception we are unwinding — turning the
        # scheduler's CancelledError into an error it does not handle, so the
        # job records as failed instead of being requeued.
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=_KILL_GRACE_S)
            except (TimeoutError, asyncio.CancelledError):
                if process.returncode is None:
                    with suppress(ProcessLookupError):
                        process.kill()
        raise


#: How a backend is told which ffmpeg to run: a name or path fixed for the
#: backend's life, or a function asked at each use. The engine passes a
#: function that reads EngineConfig.resolved_ffmpeg_bin (api.app's
#: _ffmpeg_at_use), so a binary downloaded into <data_dir>/bin while the
#: engine runs is the one the next use finds.
FFmpegBin = str | Callable[[], str]


def resolve_ffmpeg(ffmpeg_bin: FFmpegBin) -> str:
    """The name or path to run now."""
    return ffmpeg_bin() if callable(ffmpeg_bin) else ffmpeg_bin


def _ffprobe_beside(ffmpeg_bin: str) -> str:
    """The ffprobe that comes with this ffmpeg.

    Keeps the extension: ffmpeg ships as ffmpeg.exe on Windows, and a bare
    with_name("ffprobe") would look for an extensionless sibling that isn't
    there. Every render would then die at the first probe, after the clips
    have already been generated. A bare name stays bare and is looked up on
    PATH.
    """
    bin_path = Path(ffmpeg_bin)
    if bin_path.parent == Path("."):
        return "ffprobe"
    return str(bin_path.with_name(f"ffprobe{bin_path.suffix}"))


def _binary_identity(ffmpeg_bin: str) -> tuple:
    """What a probe result is filed under: the file this name runs, and enough
    of its stat to tell it from a replacement.

    The path alone is not enough: an upgrade lands at the same path, and an
    answer measured on the old build would go on describing a binary that is
    gone. Size and mtime change when the file is rewritten in place or
    replaced by nearly any other build. The inode changes when a new file is
    renamed over the old one, which is how a finished download lands, so it
    also catches the rare replacement whose size and mtime match. A lookup
    is one stat, so an answer already on file costs no ffmpeg run.

    A name that resolves to no file is filed under the name. The probes keep
    nothing they could not measure, and a file that appears there later has
    an identity of its own.
    """
    located = ffmpeg_bin if os.path.dirname(ffmpeg_bin) else shutil.which(ffmpeg_bin)
    if located is not None:
        with suppress(OSError):
            stat = os.stat(located)
            return (located, stat.st_size, stat.st_mtime_ns, stat.st_ino)
    return (ffmpeg_bin,)


# The ffmpeg a backend call wrapped by _one_binary started with, held for that
# call alone. A context variable rather than an attribute: it belongs to the
# task that set it, so nothing else using the same backend at the same time
# sees it, and it cannot outlive the call.
_PINNED_FFMPEG: contextvars.ContextVar[tuple[FFmpegBackend, str] | None] = contextvars.ContextVar(
    "localcut_pinned_ffmpeg", default=None
)


def _one_binary(method):
    """Runs `method` start to finish against the ffmpeg resolved as it starts.

    What one ffmpeg run learns is handed to the next. An export picks its
    encoder once and feeds it to every run after, and the text probe files
    its two draws under the binary it looked up first. A binary that lands
    partway through therefore belongs to the next call: switching in the
    middle would mix two builds' answers.
    """

    @functools.wraps(method)
    async def run(self: FFmpegBackend, *args, **kwargs):
        pinned = _PINNED_FFMPEG.get()
        if pinned is not None and pinned[0] is self:
            return await method(self, *args, **kwargs)
        token = _PINNED_FFMPEG.set((self, self.ffmpeg_bin))
        try:
            return await method(self, *args, **kwargs)
        finally:
            _PINNED_FFMPEG.reset(token)

    return run


def ffmpeg_available(ffmpeg_bin: str) -> bool:
    """Whether this name resolves to an ffmpeg the engine can actually run.

    Both halves are needed: the managed download sits at an absolute path
    outside PATH, and the bare `ffmpeg` default has to be looked up. Shared
    rather than repeated because three answers have to agree — assembly's
    claim on its kinds, the aligner's claim on captions (it decodes narration
    through this binary), and the readiness row that explains a machine
    without one. Two of them disagreeing is a kind advertised as ready whose
    every job dies at the first decode.
    """
    return Path(ffmpeg_bin).exists() or shutil.which(ffmpeg_bin) is not None


def _filter_path(path: Path) -> str:
    """A filesystem path safe to embed in a single-quoted ffmpeg filtergraph
    option (ass=, drawtext textfile=). ffmpeg accepts forward slashes on
    Windows, and backslashes are escape characters inside a filtergraph, so a
    raw `C:\\Users\\…` path is mis-parsed; the drive colon is also special."""
    return str(path).replace("\\", "/").replace(":", r"\:")


def _as_float(value: object, default: float) -> float:
    """User-editable trim/param values can be null or non-numeric; coerce
    without letting a bad value crash the whole timeline build."""
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _int_choice(value: object, choices: tuple[int, ...]) -> int | None:
    """The value as an int when it names one of the closed choices, else
    None (absent, garbage, or off-menu all mean 'use the default')."""
    if isinstance(value, bool):
        return None
    try:
        parsed = int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed in choices else None


def _int_clamped(value: object, lo: int, hi: int) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return min(hi, max(lo, parsed))


def _scaled_canvas(width: int, height: int, short_side: object) -> tuple[int, int]:
    """The export canvas scaled so its short side hits the requested
    choice, keeping the aspect. Only ever downscales — a request at or
    above the aspect's own canvas is 'native', never an upscale."""
    target = _int_choice(short_side, EXPORT_SHORT_SIDE_CHOICES)
    if target is None or target >= min(width, height):
        return width, height
    scale = target / min(width, height)
    # Encoders want even dimensions.
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


class FFmpegBackend(ExecutionBackend):
    name = "ffmpeg"

    def __init__(self, ffmpeg_bin: FFmpegBin = "ffmpeg") -> None:
        self._ffmpeg_bin = ffmpeg_bin
        # The encoder that opened, per binary (_binary_identity); see
        # _pick_encoder.
        self._encoder: dict[tuple, str] = {}
        # Where titles and captions are drawn from. Never the system's fonts:
        # a machine without any must render the same video (fonts.py).
        self.fonts_dir = fonts.DIR
        # (titles, captions) per binary, once probed; see _draws_text.
        self._text: dict[tuple, tuple[bool, bool]] = {}

    @property
    def ffmpeg_bin(self) -> str:
        """The ffmpeg this backend runs: inside a call _one_binary wraps, the
        one that call started with; anywhere else, whatever its source names
        right now."""
        pinned = _PINNED_FFMPEG.get()
        if pinned is not None and pinned[0] is self:
            return pinned[1]
        return resolve_ffmpeg(self._ffmpeg_bin)

    @property
    def ffprobe_bin(self) -> str:
        """Derived from ffmpeg_bin on every read, so the pair moves together."""
        return _ffprobe_beside(self.ffmpeg_bin)

    def supports(self, kind: NodeKind) -> bool:
        # Binary-gated: without an ffmpeg on disk (managed download) or on
        # PATH, assembly falls through to the chain's fallback instead of
        # failing. The binary is looked up on every call, so a download that
        # lands in <data_dir>/bin claims these kinds from the next resolve
        # on. PATH is the one this process started with, though: an ffmpeg
        # whose installer adds a directory to PATH needs an engine restart.
        return kind in _KINDS and ffmpeg_available(self.ffmpeg_bin)

    @_one_binary
    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        match spec.kind:
            case NodeKind.CLIP:
                return await self._render_still_clip(spec, ctx)
            case NodeKind.TIMELINE:
                return await self._build_timeline(spec, ctx)
            case NodeKind.EXPORT:
                return await self._export(spec, ctx)
        raise GenerationError(f"ffmpeg backend cannot handle {spec.kind}")

    # -- clip: the no-video-model tier ("stills become clips") ----------------
    # Loops the scene's keyframe for the clip duration with a slow push-in.
    # Real i2v backends outrank this by claiming CLIP ahead of ffmpeg in the
    # backend chain; this keeps assembly working on hardware where no local
    # video model fits.
    async def _render_still_clip(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        keyframe = ctx.input_artifacts.get(KEYFRAME_PORT)
        if keyframe is None:
            raise GenerationError("still clip needs a keyframe input")
        duration = max(0.5, _as_float(spec.params.get("duration_s"), 5.0))
        aspect = str(spec.params.get("aspect", DEFAULT_ASPECT))
        width, height = resolution_for(VIDEO_RESOLUTIONS, aspect)
        frames = max(1, round(duration * _STILL_CLIP_FPS))
        # Upscale before zoompan so the zoom window always has source pixels
        # (sampling at 1:1 makes the push-in shimmer on fine detail).
        vf = (
            f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,"
            f"crop={width * 2}:{height * 2},"
            f"zoompan=z='min(1+{_STILL_CLIP_ZOOM}*on/{frames},{1 + _STILL_CLIP_ZOOM})'"
            f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":d={frames}:s={width}x{height}:fps={_STILL_CLIP_FPS},format=yuv420p"
        )
        # Published through the temp-and-rename helper: a killed or failed
        # encode must not leave a truncated {hash}.mp4 that the existence
        # cache then serves as a finished clip forever (the timeline job
        # would fail "clip is not decodable media" on it every run).
        with ctx.publishing(spec.output_hash, ".mp4") as partial:
            await self._run(
                "-loop",
                "1",
                "-i",
                str(keyframe),
                "-vf",
                vf,
                "-t",
                f"{duration:.3f}",
                "-an",
                "-c:v",
                await self._pick_encoder(),
                "-b:v",
                _VIDEO_BITRATE["draft"],
                str(partial),
            )
        return ctx.output_path(spec.output_hash, ".mp4")

    # -- timeline: an explicit edit decision list (JSON) -----------------------
    #
    # The EDL is the single timing authority: segment starts and durations are
    # computed here (narration drives scene duration) and consumed verbatim by
    # both export and caption alignment — they must never re-derive timing.

    async def _build_timeline(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        def rel(path: Path | None) -> str | None:
            # EDLs are cached artifacts inside the .lcut dir: paths must stay
            # relative to generated/ or relocating the project bricks export.
            if path is None:
                return None
            p = Path(path)
            return p.name if p.parent == ctx.output_dir else str(p)

        narration = {
            port.removesuffix(SCENE_AUDIO_SUFFIX): path
            for port, path in ctx.input_artifacts.items()
            if port.endswith(SCENE_AUDIO_SUFFIX)
        }
        # Scene ports are "s3" or "s3.p2" — the sequential takes of a scene
        # whose narration outruns one clip. Takes group under their scene:
        # the EDL treats them as one virtual clip.
        takes: dict[str, list[tuple[int, Path]]] = {}
        for port, path in ctx.input_artifacts.items():
            if port.endswith(SCENE_AUDIO_SUFFIX) or port == MUSIC_PORT:
                continue
            base, _, suffix = port.partition(".p")
            takes.setdefault(base, []).append((int(suffix) if suffix.isdigit() else 1, path))
        order: list[str] = spec.params.get("order") or []
        scenes = sorted(
            takes,
            key=lambda sid: (0, order.index(sid)) if sid in order else (1,) + scene_sort_key(sid),
        )
        trims: dict = spec.params.get("trims") or {}
        transitions: dict = spec.params.get("transitions") or {}
        overlays: dict = spec.params.get("overlays") or {}

        music_path = ctx.input_artifacts.get(MUSIC_PORT)
        music_duration = await self._probe_duration(Path(music_path)) if music_path else None
        beats: list[float] = []
        if spec.params.get("beat_align") and music_path and music_duration:
            # The bed starts at output 0 and loops, so its beat grid maps
            # straight onto output time (modulo the track length).
            pcm = await self._decode_pcm(Path(music_path))
            if pcm is not None:
                beats = estimate_beats(pcm)

        segments = []
        start = 0.0
        for port in scenes:
            srcs = [path for _, path in sorted(takes[port])]
            take_durations = []
            for src in srcs:
                take_duration = await self._probe_duration(Path(src))
                if take_duration is None:
                    raise GenerationError(f"scene {port}: clip is not decodable media")
                take_durations.append(round(take_duration, 3))
            clip_duration = sum(take_durations)
            trim = trims.get(port) or {}
            trim_in = max(0.0, _as_float(trim.get("in"), 0.0))
            # 0/None/garbage → no out-trim; a positive value is a real trim.
            trim_out = _as_float(trim.get("out"), 0.0) or None
            narr = narration.get(port)
            narration_duration = (
                await self._probe_duration(Path(narr)) if narr is not None else None
            )
            if narr is not None and narration_duration is None:
                raise GenerationError(f"scene {port}: narration is not decodable media")
            # The window the user's trim leaves of the source clip. Both
            # branches below need it: the narrated one to know how much real
            # material a trim actually left.
            trimmed_window = max(
                0.0,
                (min(clip_duration, float(trim_out)) if trim_out else clip_duration) - trim_in,
            )
            transition = str(transitions.get(port, "cut"))
            # A crossfade out of this scene overlaps the NEXT one by
            # CROSSFADE_S. The overlap has to land in this scene's breathing
            # pad, not in its speech — otherwise the two scenes talk over
            # each other and both captions sit on screen together. So a scene
            # that crossfades out reserves at least a fade's worth of pad.
            pad = (
                max(NARRATION_PAD_S, CROSSFADE_S)
                if transition == "crossfade"
                else (NARRATION_PAD_S)
            )
            if narration_duration is not None:
                # Narration drives scene duration; trims pick which part of
                # the clip fills that window, they never cut speech. But a
                # trim-out is not nothing here: it bounds the material the
                # segment may show, so the renderer loops or retimes within
                # the trimmed window instead of running past trim.out and
                # revealing footage the user explicitly cut.
                duration = narration_duration + pad
            else:
                duration = max(0.1, trimmed_window)
            # A crossfade boundary overlaps this segment with the running
            # chain by CROSSFADE_S — the stored start must say where the scene
            # actually lands in the output, or caption alignment and every
            # other consumer drifts late by 0.4s per crossfade. Decide (and
            # apply) this BEFORE beat-snap so the snap targets the real
            # post-overlap start and the cut lands on the beat; the decision
            # uses the raw duration and the clamp below keeps it stable.
            prev_crossfade = bool(
                segments and segments[-1]["transition"] == "crossfade" and start > 2 * CROSSFADE_S
            )
            crossfaded = prev_crossfade and duration > 2 * CROSSFADE_S
            if crossfaded:
                start -= CROSSFADE_S
            if beats:
                # Flex only the pad: never below the speech floor, and never
                # past real clip material or a user trim-out (which would
                # reveal footage they cut or loop the clip just to hit a beat).
                # Beat-snapping shrinks the pad, so it must not shrink past
                # the fade reserve either — same overlap-into-speech rule.
                min_pad = (
                    max(BEAT_MIN_PAD_S, CROSSFADE_S)
                    if transition == "crossfade"
                    else (BEAT_MIN_PAD_S)
                )
                floor = narration_duration + min_pad if narration_duration is not None else 0.1
                if narration_duration is not None:
                    # trimmed_window, not clip_duration: stretching to a beat
                    # must not reach past the user's trim-out either.
                    material = trimmed_window
                    ceiling = min(duration + BEAT_SNAP_MAX_S, max(duration, material))
                else:
                    ceiling = duration  # exact trimmed window — shrink-to-beat only
                lo, hi = start + floor, start + ceiling
                # Keep the snapped duration on the same side of 2*CROSSFADE_S
                # as the raw value, so the crossfade decision _join_segments
                # re-derives from the stored duration matches the one made
                # here (else a sub-second segment could flip it and drift).
                if prev_crossfade and crossfaded:
                    lo = max(lo, start + 2 * CROSSFADE_S + 0.001)
                elif prev_crossfade:
                    hi = min(hi, start + 2 * CROSSFADE_S)
                snapped = nearest_beat(start + duration, beats, music_duration, lo=lo, hi=hi)
                if snapped is not None:
                    duration = round(snapped - start, 3)
            segments.append(
                {
                    "scene": port,
                    "srcs": [rel(src) for src in srcs],
                    "src_durations": take_durations,
                    "narration": rel(narration.get(port)),
                    "narration_duration": (
                        round(narration_duration, 3) if narration_duration is not None else None
                    ),
                    "start": round(start, 3),
                    "duration": round(duration, 3),
                    "clip_duration": round(clip_duration, 3),
                    "trim_in": trim_in,
                    # The material this segment may draw on, after the user's
                    # trim. Narration-driven segments can be longer than it
                    # (they loop or retime); they must never read past it.
                    "trim_window": round(trimmed_window, 3),
                    "transition": transition,
                    "onscreen_text": overlays.get(port),
                }
            )
            start += duration
        timeline = {
            "aspect": spec.params.get("aspect", DEFAULT_ASPECT),
            "video": segments,
            "duration": round(start, 3),
            "music": rel(Path(music_path)) if music_path else "",
            "music_duration": round(music_duration, 3) if music_duration else None,
            "music_volume": MUSIC_BED_VOLUME,
            "ducking": bool(spec.params.get("ducking", True)),
        }
        # The EDL is the single timing authority for export AND captions; a
        # half-written one silently reverts every duration the UI shows
        # (_assembled_edl swallows the parse error), so publish atomically.
        return ctx.publish_text(spec.output_hash, ".timeline.json", json.dumps(timeline, indent=2))

    # -- export: timed segments → transition chain → captions → music bed -----

    async def _export(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        timeline_path = ctx.input_artifacts.get(DEFAULT_PORT)
        if timeline_path is None or not Path(timeline_path).exists():
            raise GenerationError("export job is missing its timeline input")
        timeline = json.loads(Path(timeline_path).read_text())

        def resolve(src: str | None) -> Path | None:
            # EDLs store names relative to generated/; absolute paths are
            # tolerated for EDLs cached by older builds.
            if not src:
                return None
            p = Path(src)
            return p if p.is_absolute() else ctx.output_dir / p

        # A placeholder timeline (the mock backend renders one whenever the
        # managed ffmpeg is still downloading) has no "video" key at all —
        # classify it like the OTIO converter does instead of letting a bare
        # KeyError escape as an unhandled traceback.
        segments = timeline.get("video")
        if not isinstance(segments, list) or not segments:
            raise GenerationError(
                "timeline artifact is not a rendered EDL — regenerate the timeline"
            )
        for segment in segments:
            sources = segment.get("srcs") or [segment.get("src")]
            segment["srcs"] = [resolve(src) for src in sources if src]
            segment["narration"] = resolve(segment.get("narration"))
        lost = [
            s["scene"]
            for s in segments
            if not s["srcs"] or any(not src.exists() for src in s["srcs"])
        ]
        if lost:
            # Never silently ship a shorter video: a referenced clip that
            # vanished is corruption, and regenerating it is the fix.
            raise GenerationError(f"clip artifacts missing for scenes: {lost}")

        width, height = resolution_for(EXPORT_RESOLUTIONS, timeline.get("aspect"))
        # Per-platform encode params off the export node. Every read
        # tolerates garbage: the raw /patch path can write anything into
        # params, and a bad value must fall back to defaults, not 500 an
        # export that is minutes into its segments.
        width, height = _scaled_canvas(width, height, spec.params.get("resolution"))
        fps = _int_choice(spec.params.get("fps"), EXPORT_FPS_CHOICES)
        audio_kbps = _int_clamped(spec.params.get("audio_kbps"), *EXPORT_AUDIO_KBPS_BOUNDS)
        encoder = await self._pick_encoder()
        bitrate = _VIDEO_BITRATE.get(spec.quality, _VIDEO_BITRATE["draft"])
        video_kbps = _int_clamped(spec.params.get("video_kbps"), *EXPORT_VIDEO_KBPS_BOUNDS)
        if video_kbps is not None:
            bitrate = f"{video_kbps}k"
        # Never under generated/ — everything there is treated as an artifact.
        work = Path(tempfile.mkdtemp(prefix="localcut-export-"))
        partial: Path | None = None  # set once the final artifact path is known
        try:
            scene_files: list[Path] = []
            total = len(segments)
            for index, segment in enumerate(segments):
                srcs = segment["srcs"]
                if len(srcs) > 1:
                    # A split scene's takes become one normalized source
                    # before the timing policy applies.
                    segment["src"] = await self._merge_takes(
                        srcs, work / f"seg{index:03}-takes.mp4", width, height, encoder
                    )
                else:
                    segment["src"] = srcs[0]
                fade_in = index > 0 and segments[index - 1].get("transition") == "dip"
                scene_files.append(
                    await self._render_segment(
                        segment,
                        work / f"seg{index:03}.mp4",
                        width,
                        height,
                        encoder,
                        workdir=work,
                        fade_in=fade_in,
                    )
                )
                await ctx.progress(0.8 * (index + 1) / total)

            burn = self._burnable_captions(spec, ctx, work, width, height)
            cut = await self._join_segments(
                segments,
                scene_files,
                work,
                encoder,
                bitrate,
                burn,
                fps=fps,
                audio_kbps=audio_kbps,
            )

            out = ctx.output_path(spec.output_hash, ".mp4")
            # Build into a dot-prefixed sibling (skipped by the artifact scan)
            # and atomically rename into place: a crash mid-encode must never
            # leave a truncated {hash}.mp4 that the existence cache then serves
            # as a finished export forever.
            partial = out.with_name(f".partial-{out.name}")
            music = resolve(timeline.get("music", ""))
            music_duration = await self._probe_duration(music) if music is not None else None
            if music is not None and music_duration is None:
                # An undecodable bed is a placeholder from a machine with no
                # music model. The cut ships without it — but the missing
                # music is not self-explanatory, so the skip says so.
                ctx.notify(EXPORT_MUSIC_BED_DROPPED)
            if music_duration is not None:
                volume = float(timeline.get("music_volume", MUSIC_BED_VOLUME))
                if timeline.get("ducking", True):
                    # Sidechain ducking: the program audio (narration) keys a
                    # compressor on the bed, so music dives under speech and
                    # swells back in the gaps instead of sitting at one level.
                    mix = (
                        f"[1:a]volume={volume}[m];"
                        "[0:a]asplit=2[voice][key];"
                        "[m][key]sidechaincompress="
                        "threshold=0.02:ratio=8:attack=150:release=500[duck];"
                        "[voice][duck]amix=inputs=2:duration=first"
                        ":dropout_transition=3:normalize=0[a]"
                    )
                else:
                    mix = (
                        f"[1:a]volume={volume}[m];"
                        "[0:a][m]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[a]"
                    )
                await self._run(
                    "-i",
                    str(cut),
                    "-stream_loop",
                    "-1",
                    "-i",
                    str(music),
                    "-filter_complex",
                    mix,
                    "-map",
                    "0:v",
                    "-map",
                    "[a]",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-b:a",
                    f"{audio_kbps}k" if audio_kbps is not None else "192k",
                    str(partial),
                )
            else:
                # Same container either side — the no-music path is a rename,
                # not a remux.
                shutil.move(str(cut), str(partial))
            # Nothing else in the pipeline can see a mix that lost its
            # timestamps: ffmpeg exits 0, and `format=duration` reports the
            # picture's length whichever way the audio went. Publishing it
            # is what makes the loss permanent — store.py serves any file
            # present in generated/ as a finished render, so the node is
            # never re-enqueued. Refuse instead, and the next attempt renders.
            program = _as_float(timeline.get("duration"), 0.0)
            heard = await self._probe_audio_duration(partial)
            if program > 0 and (heard is None or heard < program - AUDIO_SHORTFALL_S):
                raise GenerationError(
                    f"export audio ran {heard}s against a {program}s program - "
                    "discarded rather than cached; run the export again"
                )
            os.replace(partial, out)  # atomic publish within generated/
        finally:
            if partial is not None:
                partial.unlink(missing_ok=True)  # no-op after a successful replace
            shutil.rmtree(work, ignore_errors=True)
        await ctx.progress(1.0)
        return out

    def _burnable_captions(
        self, spec: JobSpec, ctx: ExecutionContext, work: Path, width: int, height: int
    ) -> Path | None:
        """The caption artifact as a styled ASS file, when burn-in applies.
        Takes the export's frame size: libass scales the ASS canvas onto the
        frame, so a style built for any other canvas burns in rescaled."""
        if spec.params.get("captions", "burn") != "burn":
            return None
        srt = ctx.input_artifacts.get(CAPTIONS_PORT)
        # encoding="utf-8" on both hops: the aligner writes the SRT as UTF-8
        # (align.py says so explicitly), and libass reads the ASS as UTF-8.
        # Falling back to the platform codepage makes any accented or CJK
        # caption either kill the export outright on Windows or burn in as
        # mojibake.
        if srt is None or not srt.exists() or not srt.read_text(encoding="utf-8").strip():
            return None
        ass = work / "captions.ass"
        ass.write_text(srt_to_ass(srt.read_text(encoding="utf-8"), width, height), encoding="utf-8")
        return ass

    async def _join_segments(
        self,
        segments: list[dict],
        scene_files: list[Path],
        work: Path,
        encoder: str,
        bitrate: str,
        burn: Path | None,
        fps: int | None = None,
        audio_kbps: int | None = None,
    ) -> Path:
        """Pairwise transition chain: cut/dip boundaries concat, crossfade
        boundaries xfade for the picture and a delayed amix for the audio.
        The concat *filter* (not the demuxer) is deliberate — stream-copy
        concat of AAC segments accumulates timestamp gaps and drifts total
        duration, where the re-encoded filter path holds its length."""
        cut = work / "cut.mp4"
        inputs: list[str] = []
        for path in scene_files:
            inputs += ["-i", str(path)]
        # Segments render at the internal cadence; the export's fps applies
        # at this final encode, so a 30/60 fps request never touches the
        # cached per-scene intermediates.
        rate = ["-r", str(fps)] if fps is not None else []
        audio_rate = f"{audio_kbps}k" if audio_kbps is not None else "160k"

        steps: list[str] = []
        cur_v, cur_a = "[0:v]", "[0:a]"
        cur_duration = float(segments[0]["duration"])
        for i in range(1, len(scene_files)):
            duration_i = float(segments[i]["duration"])
            boundary = segments[i - 1].get("transition", "cut")
            if (
                boundary == "crossfade"
                and cur_duration > CROSSFADE_S * 2
                and duration_i > CROSSFADE_S * 2
            ):
                offset = cur_duration - CROSSFADE_S
                # settb on both sides because xfade refuses a pair of inputs
                # whose timebases disagree, and these two reach it from
                # different places: the concat filter emits AVTB (1/1000000)
                # while a raw segment carries whatever its encoder chose
                # (1/12288 for 24fps). Without this a crossfade that follows
                # a cut or a dip fails the entire export at filter-configure
                # time — a shape the board offers on any seam.
                steps.append(f"{cur_v}settb=AVTB[xa{i}]")
                steps.append(f"[{i}:v]settb=AVTB[xb{i}]")
                steps.append(
                    f"[xa{i}][xb{i}]xfade=transition=fade:"
                    f"duration={CROSSFADE_S}:offset={offset:.3f}[v{i}]"
                )
                # Audio overlaps at full level (delay + mix), NOT acrossfade:
                # a fade-in would swallow the first words of the next scene's
                # narration, which starts flush with its segment.
                delay_ms = round(offset * 1000)
                steps.append(f"[{i}:a]adelay={delay_ms}:all=1[ad{i}]")
                # Stamped on the mix, not on the graph's last audio label.
                # Past the point where its first input ends, amix can stop
                # stamping altogether: `ashowinfo` reads pts:NOPTS for every
                # frame from there on, and it is a race - same inputs, same
                # command, a quarter of runs. Whichever consumer reads those
                # frames inherits the damage. A concat compiled by a later
                # cut folds the last of them into the offset it applies to
                # the rest of the program, and ffmpeg abandons the export;
                # the encoder instead advances the DTS a tick at a time
                # until the muxer's non-monotonic fixup ends the AAC stream
                # seconds into a complete picture. Deriving each pts from
                # the running sample count leaves neither one anything to
                # inherit.
                steps.append(
                    f"{cur_a}[ad{i}]amix=inputs=2:duration=longest:"
                    f"dropout_transition=0:normalize=0,asetpts=N/SR/TB[a{i}]"
                )
                cur_duration += duration_i - CROSSFADE_S
            else:
                steps.append(f"{cur_v}{cur_a}[{i}:v][{i}:a]concat=n=2:v=1:a=1[v{i}][a{i}]")
                cur_duration += duration_i
            cur_v, cur_a = f"[v{i}]", f"[a{i}]"

        if burn is not None:
            steps.append(f"{cur_v}{self._captions_filter(burn)}[vout]")
            cur_v = "[vout]"
        if not steps:
            # Single segment, nothing to burn: re-encode to the target rate.
            await self._run(
                "-i",
                str(scene_files[0]),
                *rate,
                "-c:v",
                encoder,
                "-b:v",
                bitrate,
                "-c:a",
                "aac",
                "-b:a",
                audio_rate,
                str(cut),
            )
            return cut

        def map_arg(label: str) -> str:
            # Raw input streams ("[0:a]") are mapped without brackets; only
            # filtergraph outputs keep the label form.
            return label[1:-1] if ":" in label else label

        await self._run(
            *inputs,
            "-filter_complex",
            ";".join(steps),
            "-map",
            map_arg(cur_v),
            "-map",
            map_arg(cur_a),
            *rate,
            "-c:v",
            encoder,
            "-b:v",
            bitrate,
            "-c:a",
            "aac",
            "-b:a",
            audio_rate,
            str(cut),
        )
        return cut

    async def _render_segment(
        self,
        segment: dict,
        out: Path,
        width: int,
        height: int,
        encoder: str,
        *,
        workdir: Path,
        fade_in: bool = False,
    ) -> Path:
        """One scene, cut to the EDL's stored duration (narration-driven),
        with trims, dip fades and on-screen text applied at the source."""
        clip = str(segment["src"])
        target = float(segment["duration"])
        clip_duration = float(segment.get("clip_duration") or 0.0)
        if not clip_duration:
            probed = await self._probe_duration(Path(clip))
            if probed is None:
                raise GenerationError(f"scene {segment.get('scene')}: clip is not decodable media")
            clip_duration = probed
        trim_in = float(segment.get("trim_in") or 0.0)
        if trim_in >= clip_duration:
            trim_in = 0.0  # a trim that consumed the whole clip is void

        narration = segment.get("narration")
        if narration is not None and not Path(narration).exists():
            # A narration the timeline references but that vanished is
            # corruption — fail loudly rather than shipping a silent scene.
            raise GenerationError(f"scene {segment.get('scene')}: narration artifact is missing")

        # Timing policy (in order): clip long enough → trim; short by ≤ the
        # retime bound → slow it slightly; shorter → loop with a crossfaded
        # seam; degenerate (clip shorter than a crossfade) → hard loop.
        #
        # The window is what the user's trim LEFT, not the whole clip: a
        # narration-driven segment that overran trim.out would silently show
        # the footage they cut. EDLs from older builds carry no trim_window,
        # so fall back to the untrimmed tail.
        stored_window = segment.get("trim_window")
        window = max(0.01, clip_duration - trim_in)
        if isinstance(stored_window, (int, float)) and stored_window > 0:
            window = max(0.01, min(window, float(stored_window)))
        retime = None
        loop_hard = False
        if window < target:
            stretch = target / window
            if stretch <= RETIME_MAX:
                retime = stretch
            elif window > 2 * CROSSFADE_S:
                clip = str(
                    await self._loop_source(
                        clip,
                        trim_in,
                        window,
                        target,
                        workdir / f"{out.stem}-loop.mp4",
                        encoder,
                    )
                )
                trim_in = 0.0
                # A pathologically short clip can hit the loop cap below
                # target; repeat the crossfaded block rather than freezing
                # the video track short of the narration.
                step = window - CROSSFADE_S
                if window + (_MAX_LOOPS - 1) * step < target:
                    loop_hard = True
            else:
                if window < clip_duration - trim_in - 1e-3:
                    # A hard loop reads its input to EOF — `-ss`/`-t` on the
                    # input would cap the whole looped stream, not each
                    # repetition — so a trim-out has to be baked into the
                    # source first. Without this, every repeat past the first
                    # plays exactly the footage the user cut, which is the
                    # failure trim_window exists to prevent.
                    clip = str(
                        await self._trimmed_source(
                            clip,
                            trim_in,
                            window,
                            workdir / f"{out.stem}-win.mp4",
                            encoder,
                        )
                    )
                    trim_in = 0.0
                loop_hard = True

        args: list[str] = []
        if trim_in:
            args += ["-ss", f"{trim_in:.3f}"]
        if loop_hard:
            args += ["-stream_loop", "-1"]
        args += ["-i", clip]
        if narration is not None:
            args += ["-i", str(narration)]
            audio = ["-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "160k"]
        else:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            audio = ["-map", "1:a", "-c:a", "aac", "-b:a", "160k"]

        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps=24,format=yuv420p"
        )
        if retime is not None:
            # Zero-base the PTS before scaling: input seeking (-ss) can leave
            # a non-zero start PTS, which a bare N*PTS would amplify into a
            # startup offset / A-V drift.
            vf = f"setpts={retime:.4f}*(PTS-STARTPTS),{vf}"
        text = segment.get("onscreen_text")
        if text:
            # Probe before building the graph: a harfbuzz-less static build
            # would otherwise die mid-export on "No such filter: 'drawtext'".
            await self._require_drawtext()
            # textfile= sidesteps drawtext's escaping rules for user text.
            # encoding="utf-8": drawtext reads the file as UTF-8; the Windows
            # platform default (cp1252) would mangle or reject CJK titles.
            textfile = workdir / f"{out.stem}.txt"
            textfile.write_text(str(text), encoding="utf-8")
            vf += "," + self._title_filter(textfile, height)
        if fade_in:
            vf += f",fade=t=in:st=0:d={DIP_S}"
        if segment.get("transition") == "dip":
            vf += f",fade=t=out:st={max(0.0, target - DIP_S):.3f}:d={DIP_S}"

        await self._run(
            *args,
            "-t",
            f"{target:.3f}",
            "-map",
            "0:v",
            *audio,
            "-vf",
            vf,
            "-c:v",
            encoder,
            "-b:v",
            "12M",
            str(out),
        )
        return out

    async def _merge_takes(
        self, srcs: list[Path], out: Path, width: int, height: int, encoder: str
    ) -> Path:
        """Concat a split scene's sequential takes into one source. Each take
        is normalized first — the concat filter needs uniform geometry, and
        takes can differ (e.g. one re-rendered down the OOM ladder)."""
        args: list[str] = []
        filters: list[str] = []
        for index, src in enumerate(srcs):
            args += ["-i", str(src)]
            filters.append(
                f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},fps=24,format=yuv420p[v{index}]"
            )
        chain = "".join(f"[v{i}]" for i in range(len(srcs)))
        filters.append(f"{chain}concat=n={len(srcs)}:v=1:a=0[v]")
        await self._run(
            *args,
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[v]",
            "-an",
            "-c:v",
            encoder,
            "-b:v",
            "12M",
            str(out),
        )
        return out

    async def _trimmed_source(
        self, clip: str, trim_in: float, window: float, out: Path, encoder: str
    ) -> Path:
        """Bake a user trim into its own file: exactly `window` seconds from
        `trim_in`. Needed before `-stream_loop`, which reads to EOF and would
        otherwise reveal the footage past the trim-out on every repeat."""
        await self._run(
            "-ss",
            f"{trim_in:.3f}",
            "-t",
            f"{window:.3f}",
            "-i",
            clip,
            "-an",
            "-c:v",
            encoder,
            "-b:v",
            "12M",
            str(out),
        )
        return out

    async def _loop_source(
        self,
        clip: str,
        trim_in: float,
        window: float,
        target: float,
        out: Path,
        encoder: str,
    ) -> Path:
        """Extend a clip past the retime bound by repeating it with
        crossfaded seams — never a hard loop cut, never silent slow-mo."""
        step = window - CROSSFADE_S
        loops = min(_MAX_LOOPS, 1 + math.ceil((target - window) / step))
        args: list[str] = []
        for _ in range(loops):
            if trim_in:
                args += ["-ss", f"{trim_in:.3f}"]
            # -t before -i bounds each repetition to the trimmed window, so a
            # loop can never reveal footage past the user's trim-out.
            args += ["-t", f"{window:.3f}", "-i", clip]
        steps: list[str] = []
        cur, cur_len = "[0:v]", window
        for i in range(1, loops):
            steps.append(
                f"{cur}[{i}:v]xfade=transition=fade:"
                f"duration={CROSSFADE_S}:offset={cur_len - CROSSFADE_S:.3f}[x{i}]"
            )
            cur = f"[x{i}]"
            cur_len += step
        await self._run(
            *args,
            "-filter_complex",
            ";".join(steps),
            "-map",
            cur,
            "-t",
            f"{target:.3f}",
            "-an",
            "-c:v",
            encoder,
            "-b:v",
            "12M",
            str(out),
        )
        return out

    # -- helpers ------------------------------------------------------------------

    # Text reaches a frame through these two builders and nothing else, so the
    # probe below draws exactly what an export draws.

    def _title_filter(self, textfile: Path, height: int) -> str:
        """drawtext for an on-screen title read from `textfile`, sized for a
        frame `height` pixels tall."""
        return (
            # Single-quote AND filtergraph-escape the paths: an unquoted
            # ':'/',' in the temp dir path (legal on Linux) or a Windows
            # backslash/drive-colon would otherwise be parsed as a drawtext
            # option/filter separator and break -vf.
            # expansion=none: titles are user/LLM text, and drawtext's
            # default expansion evaluates %{...} — "SAVE 100%{TODAY}"
            # fails the whole export, and "%{pts}" silently burns a
            # running timestamp in place of the words the user typed.
            # fontfile=: the bundled face, opened directly. A family name
            # would go through fontconfig, which on a machine with no fonts
            # finds nothing and stops the filter from starting.
            f"drawtext=expansion=none:textfile='{_filter_path(textfile)}'"
            f":fontfile='{_filter_path(self.fonts_dir / fonts.REGULAR)}'"
            f":fontsize={height // 14}"
            f":fontcolor=white:borderw={max(2, height // 270)}"
            ":bordercolor=black@0.85:x=(w-text_w)/2:y=h*0.14"
        )

    def _captions_filter(self, ass: Path) -> str:
        """libass burn-in of the styled captions in `ass`. fontsdir= is where
        the family the style names (captions.py) is found. Without it libass
        asks the system, and on a machine with no fonts the captions burn in
        blank while ffmpeg reports success."""
        return f"ass='{_filter_path(ass)}':fontsdir='{_filter_path(self.fonts_dir)}'"

    async def _lit_pixels(self, vf: str) -> int | None:
        """How many pixels `vf` lights on one black probe frame. 0 when ffmpeg
        could not draw it at all, None when the binary cannot be run."""
        width, height = _PROBE_FRAME
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffmpeg_bin,
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                f"color=black:size={width}x{height}:duration=1",
                "-vf",
                vf,
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "pipe:1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            return None
        async with _terminating(process):
            stdout, _ = await process.communicate()
        if process.returncode != 0:
            return 0
        return sum(1 for value in stdout if value > 127)

    async def _draws_text(self) -> tuple[bool | None, bool | None]:
        """(titles, captions): whether each one draws. One black frame apiece,
        through the filters an export uses, counts only if something on it
        lit up.

        Drawn rather than looked up, because a listed filter says nothing
        about fonts. On a machine without any, drawtext and ass are both
        listed; then drawtext refuses to start, and libass draws nothing while
        ffmpeg exits 0. A static FFmpeg 7+ build without libharfbuzz has no
        drawtext at all, and fails here the same way.

        (None, None) when the binary could not be run, which fails louder on
        its own at use. That answer is never kept, because the download that
        fixes it can land at any moment. A drawn answer is kept for the binary
        it was drawn with (_binary_identity), so a binary that appears or is
        replaced is drawn with again, and an unchanged one never is."""
        key = _binary_identity(self.ffmpeg_bin)
        if key in self._text:
            return self._text[key]
        width, height = _PROBE_FRAME
        with tempfile.TemporaryDirectory(prefix="localcut-text-probe-") as tmp:
            textfile = Path(tmp) / "title.txt"
            textfile.write_text(_PROBE_TEXT, encoding="utf-8")
            ass = Path(tmp) / "captions.ass"
            cue = f"1\n00:00:00,000 --> 00:00:05,000\n{_PROBE_TEXT}\n"
            ass.write_text(srt_to_ass(cue, width, height), encoding="utf-8")
            titles = await self._lit_pixels(self._title_filter(textfile, height))
            captions = await self._lit_pixels(self._captions_filter(ass))
        if titles is None or captions is None:
            return None, None
        self._text[key] = (titles > 0, captions > 0)
        return self._text[key]

    @_one_binary
    async def supports_drawtext(self) -> bool | None:
        """Whether this ffmpeg puts text on the video: on-screen titles and
        burned-in captions both. /system reports it as `ffmpeg_drawtext`, so
        the setup surface can say so before an export dies or ships blank
        captions. None = the binary is missing or could not be run."""
        titles, captions = await self._draws_text()
        if titles is None or captions is None:
            return None
        return titles and captions

    async def _require_drawtext(self) -> None:
        # The title half only. A build that cannot burn captions may still
        # draw titles, and refusing them for it would fail an export that
        # works.
        titles, _ = await self._draws_text()
        if titles is False:
            raise GenerationError(
                "on-screen titles need ffmpeg's drawtext filter, and this build drew "
                "nothing with it (FFmpeg 7+ needs libfreetype and libharfbuzz compiled "
                "in; some static builds omit them) - point LOCALCUT_FFMPEG_BIN at a "
                "full build, or clear the scene's on-screen text"
            )

    async def _run(self, *args: str) -> None:
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffmpeg_bin,
                "-y",
                "-hide_banner",
                *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise GenerationError(f"ffmpeg binary not found: {self.ffmpeg_bin}") from exc
        async with _terminating(process):
            _, stderr = await process.communicate()
        if process.returncode != 0:
            raise GenerationError(f"ffmpeg failed: {stderr.decode()[-600:]}")

    async def audio_peaks(self, path: Path, bins: int) -> dict | None:
        """Waveform peaks for an audio lane, or None for undecodable media.
        Raises GenerationError when the ffmpeg binary itself is missing —
        the caller must tell those two apart (422 vs 503)."""
        pcm = await self._decode_pcm(path)
        if pcm is None or pcm.size == 0:
            return None
        return {
            "duration_s": round(pcm.size / ANALYSIS_RATE, 3),
            "peaks": waveform_peaks(pcm, bins),
        }

    async def _decode_pcm(self, path: Path):
        """Mono float32 PCM at the analysis rate, or None for undecodable
        media (mock placeholders) — beat alignment then just skips."""
        import numpy as np

        try:
            process = await asyncio.create_subprocess_exec(
                self.ffmpeg_bin,
                "-hide_banner",
                "-v",
                "error",
                "-i",
                str(path),
                "-f",
                "f32le",
                "-ac",
                "1",
                "-ar",
                str(ANALYSIS_RATE),
                "pipe:1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise GenerationError(f"ffmpeg binary not found: {self.ffmpeg_bin}") from exc
        async with _terminating(process):
            stdout, _ = await process.communicate()
        if process.returncode != 0 or not stdout:
            return None
        return np.frombuffer(stdout, dtype=np.float32)

    async def _probe_duration(self, path: Path) -> float | None:
        return await self._probe_seconds(path, "format=duration")

    async def _probe_audio_duration(self, path: Path) -> float | None:
        """The decoded length of the audio stream alone, or None where there
        is no readable one. `format=duration` is the container's longest
        stream — the picture — so a file whose audio stopped early reads as
        healthy there; only the stream itself says how much of the program
        a viewer would actually hear."""
        return await self._probe_seconds(path, "stream=duration", select="a:0")

    async def _probe_seconds(
        self, path: Path, entries: str, select: str | None = None
    ) -> float | None:
        if not path.exists():
            return None
        selection = ["-select_streams", select] if select is not None else []
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffprobe_bin,
                "-v",
                "error",
                *selection,
                "-show_entries",
                entries,
                "-of",
                "csv=p=0",
                str(path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError as exc:
            raise GenerationError(
                f"ffprobe binary not found next to ffmpeg: {self.ffprobe_bin} — "
                "assembly requires both"
            ) from exc
        async with _terminating(process):
            stdout, _ = await process.communicate()
        try:
            return float(stdout.decode().strip())
        except ValueError:
            return None  # not decodable media (e.g. a mock placeholder)

    async def _pick_encoder(self) -> str:
        """First candidate that actually encodes a frame wins — being listed
        in -encoders doesn't mean it can open (NVENC needs driver/GPU access,
        which headless or containerized environments may lack). Kept per
        binary, like the text probe: which encoders open is a property of the
        build."""
        key = _binary_identity(self.ffmpeg_bin)
        if key not in self._encoder:
            # No libx264: GPL encoders are excluded by the licensing policy.
            for candidate in ("h264_nvenc", "libopenh264", "mpeg4"):
                try:
                    process = await asyncio.create_subprocess_exec(
                        self.ffmpeg_bin,
                        "-y",
                        "-hide_banner",
                        "-f",
                        "lavfi",
                        "-i",
                        "color=black:size=256x256:duration=0.1",
                        "-frames:v",
                        "1",
                        "-c:v",
                        candidate,
                        "-f",
                        "null",
                        "-",
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                except FileNotFoundError as exc:
                    raise GenerationError(f"ffmpeg binary not found: {self.ffmpeg_bin}") from exc
                async with _terminating(process):
                    await process.communicate()
                if process.returncode == 0:
                    self._encoder[key] = candidate
                    break
            else:
                raise GenerationError("no working H.264/MPEG-4 encoder in this ffmpeg build")
        return self._encoder[key]
