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
import json
import math
import shutil
import tempfile
from pathlib import Path

from ..aspects import DEFAULT_ASPECT, EXPORT_RESOLUTIONS, resolution_for
from ..audio import ANALYSIS_RATE, estimate_beats, nearest_beat
from ..captions import srt_to_ass
from ..graph.compiler import JobSpec
from ..graph.model import (
    CAPTIONS_PORT,
    DEFAULT_PORT,
    MUSIC_PORT,
    SCENE_AUDIO_SUFFIX,
    NodeKind,
    scene_sort_key,
)
from .base import ExecutionBackend, ExecutionContext, GenerationError

_KINDS = {NodeKind.TIMELINE, NodeKind.EXPORT}

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

# Export bitrate by quality tier; draft favors speed, final favors fidelity.
_VIDEO_BITRATE = {"draft": "4M", "final": "10M"}


class FFmpegBackend(ExecutionBackend):
    name = "ffmpeg"

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self.ffmpeg_bin = ffmpeg_bin
        bin_path = Path(ffmpeg_bin)
        self.ffprobe_bin = (
            str(bin_path.with_name("ffprobe")) if bin_path.parent != Path(".") else "ffprobe"
        )
        self._encoder: str | None = None

    def supports(self, kind: NodeKind) -> bool:
        return kind in _KINDS

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        match spec.kind:
            case NodeKind.TIMELINE:
                return await self._build_timeline(spec, ctx)
            case NodeKind.EXPORT:
                return await self._export(spec, ctx)
        raise GenerationError(f"ffmpeg backend cannot handle {spec.kind}")

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
            trim_in = max(0.0, float(trim.get("in", 0.0)))
            trim_out = trim.get("out")
            narr = narration.get(port)
            narration_duration = (
                await self._probe_duration(Path(narr)) if narr is not None else None
            )
            if narr is not None and narration_duration is None:
                raise GenerationError(f"scene {port}: narration is not decodable media")
            if narration_duration is not None:
                # Narration drives scene duration; trims pick which part of
                # the clip fills that window, they never cut speech.
                duration = narration_duration + NARRATION_PAD_S
            else:
                window = min(clip_duration, float(trim_out)) if trim_out else clip_duration
                duration = max(0.1, window - trim_in)
            # A crossfade boundary overlaps this segment with the running
            # chain by CROSSFADE_S — the stored start must say where the
            # scene actually lands in the output, or caption alignment and
            # every other consumer drifts late by 0.4s per crossfade. Guard
            # mirrors _join_segments exactly (both sides long enough).
            if (
                segments
                and segments[-1]["transition"] == "crossfade"
                and start > 2 * CROSSFADE_S
                and duration > 2 * CROSSFADE_S
            ):
                start -= CROSSFADE_S
            if beats:
                # Snap this boundary to the nearest beat by flexing the pad:
                # never below the speech floor, never far past the window.
                floor = (
                    narration_duration + BEAT_MIN_PAD_S if narration_duration is not None else 0.1
                )
                snapped = nearest_beat(
                    start + duration,
                    beats,
                    music_duration,
                    lo=start + floor,
                    hi=start + duration + BEAT_SNAP_MAX_S,
                )
                if snapped is not None:
                    duration = round(snapped - start, 3)
            segments.append(
                {
                    "scene": port,
                    "srcs": [rel(src) for src in srcs],
                    "src_durations": take_durations,
                    "narration": rel(narration.get(port)),
                    "narration_duration": (
                        round(narration_duration, 3) if narration_duration else None
                    ),
                    "start": round(start, 3),
                    "duration": round(duration, 3),
                    "clip_duration": round(clip_duration, 3),
                    "trim_in": trim_in,
                    "transition": str(transitions.get(port, "cut")),
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
        out = ctx.output_path(spec.output_hash, ".timeline.json")
        out.write_text(json.dumps(timeline, indent=2))
        return out

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

        segments = timeline["video"]
        if not segments:
            raise GenerationError("timeline has no video segments")
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
        encoder = await self._pick_encoder()
        bitrate = _VIDEO_BITRATE.get(spec.quality, _VIDEO_BITRATE["draft"])
        # Never under generated/ — everything there is treated as an artifact.
        work = Path(tempfile.mkdtemp(prefix="localcut-export-"))
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

            burn = self._burnable_captions(spec, ctx, work)
            cut = await self._join_segments(segments, scene_files, work, encoder, bitrate, burn)

            out = ctx.output_path(spec.output_hash, ".mp4")
            music = resolve(timeline.get("music", ""))
            if music is not None and await self._probe_duration(music) is not None:
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
                    "192k",
                    str(out),
                )
            else:
                # Same container either side — the no-music path is a rename,
                # not a remux.
                shutil.move(str(cut), str(out))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        await ctx.progress(1.0)
        return out

    def _burnable_captions(self, spec: JobSpec, ctx: ExecutionContext, work: Path) -> Path | None:
        """The caption artifact as a styled ASS file, when burn-in applies."""
        if spec.params.get("captions", "burn") != "burn":
            return None
        srt = ctx.input_artifacts.get(CAPTIONS_PORT)
        if srt is None or not srt.exists() or not srt.read_text().strip():
            return None
        ass = work / "captions.ass"
        ass.write_text(srt_to_ass(srt.read_text()))
        return ass

    async def _join_segments(
        self,
        segments: list[dict],
        scene_files: list[Path],
        work: Path,
        encoder: str,
        bitrate: str,
        burn: Path | None,
    ) -> Path:
        """Pairwise transition chain: cut/dip boundaries concat, crossfade
        boundaries xfade+acrossfade. The concat *filter* (not the demuxer) is
        deliberate — stream-copy concat of AAC segments accumulates timestamp
        gaps and drifts total duration; the re-encode is sample-exact."""
        cut = work / "cut.mp4"
        inputs: list[str] = []
        for path in scene_files:
            inputs += ["-i", str(path)]

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
                steps.append(
                    f"{cur_v}[{i}:v]xfade=transition=fade:"
                    f"duration={CROSSFADE_S}:offset={offset:.3f}[v{i}]"
                )
                # Audio overlaps at full level (delay + mix), NOT acrossfade:
                # a fade-in would swallow the first words of the next scene's
                # narration, which starts flush with its segment.
                delay_ms = round(offset * 1000)
                steps.append(f"[{i}:a]adelay={delay_ms}:all=1[ad{i}]")
                steps.append(
                    f"{cur_a}[ad{i}]amix=inputs=2:duration=longest:"
                    f"dropout_transition=0:normalize=0[a{i}]"
                )
                cur_duration += duration_i - CROSSFADE_S
            else:
                steps.append(f"{cur_v}{cur_a}[{i}:v][{i}:a]concat=n=2:v=1:a=1[v{i}][a{i}]")
                cur_duration += duration_i
            cur_v, cur_a = f"[v{i}]", f"[a{i}]"

        if burn is not None:
            steps.append(f"{cur_v}ass='{burn}'[vout]")
            cur_v = "[vout]"
        if not steps:
            # Single segment, nothing to burn: re-encode to the target rate.
            await self._run(
                "-i",
                str(scene_files[0]),
                "-c:v",
                encoder,
                "-b:v",
                bitrate,
                "-c:a",
                "aac",
                "-b:a",
                "160k",
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
            "-c:v",
            encoder,
            "-b:v",
            bitrate,
            "-c:a",
            "aac",
            "-b:a",
            "160k",
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
        window = max(0.01, clip_duration - trim_in)
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
            # textfile= sidesteps drawtext's escaping rules for user text.
            textfile = workdir / f"{out.stem}.txt"
            textfile.write_text(str(text))
            vf += (
                f",drawtext=textfile={textfile}:font=Sans:fontsize={height // 14}"
                f":fontcolor=white:borderw={max(2, height // 270)}"
                ":bordercolor=black@0.85:x=(w-text_w)/2:y=h*0.14"
            )
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
            args += ["-i", clip]
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
        _, stderr = await process.communicate()
        if process.returncode != 0:
            raise GenerationError(f"ffmpeg failed: {stderr.decode()[-600:]}")

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
        stdout, _ = await process.communicate()
        if process.returncode != 0 or not stdout:
            return None
        return np.frombuffer(stdout, dtype=np.float32)

    async def _probe_duration(self, path: Path) -> float | None:
        if not path.exists():
            return None
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffprobe_bin,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
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
        stdout, _ = await process.communicate()
        try:
            return float(stdout.decode().strip())
        except ValueError:
            return None  # not decodable media (e.g. a mock placeholder)

    async def _pick_encoder(self) -> str:
        """First candidate that actually encodes a frame wins — being listed
        in -encoders doesn't mean it can open (NVENC needs driver/GPU access,
        which headless or containerized environments may lack)."""
        if self._encoder is None:
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
                await process.communicate()
                if process.returncode == 0:
                    self._encoder = candidate
                    break
            else:
                raise GenerationError("no working H.264/MPEG-4 encoder in this ffmpeg build")
        return self._encoder
