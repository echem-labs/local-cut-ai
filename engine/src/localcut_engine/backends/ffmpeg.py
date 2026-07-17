"""FFmpeg assembly backend — deterministic, non-AI: per-scene timing, audio
mix, concat, export.

Timing authority: narration duration *drives* scene duration — each clip is
trimmed (or looped) to its narration plus padding, never the other way
around. Music is a constant-level bed under the narration, looped/trimmed to
the final cut (ducking and fades land with the audio-v2 pass). Prefers
hardware/openh264 encoders per the licensing policy; mpeg4 is the
everything-else fallback — never GPL x264.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from ..aspects import DEFAULT_ASPECT, EXPORT_RESOLUTIONS, resolution_for
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
CROSSFADE_S = 0.4  # video+audio overlap for the crossfade transition
DIP_S = 0.25  # fade-to-black halves of the dip transition

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
        scenes = [
            (port, path)
            for port, path in ctx.input_artifacts.items()
            if not port.endswith(SCENE_AUDIO_SUFFIX) and port != MUSIC_PORT
        ]
        order: list[str] = spec.params.get("order") or []
        scenes.sort(
            key=lambda item: (
                (0, order.index(item[0])) if item[0] in order else (1,) + scene_sort_key(item[0])
            )
        )
        trims: dict = spec.params.get("trims") or {}
        transitions: dict = spec.params.get("transitions") or {}
        overlays: dict = spec.params.get("overlays") or {}

        segments = []
        start = 0.0
        for port, path in scenes:
            clip_duration = await self._probe_duration(Path(path))
            if clip_duration is None:
                raise GenerationError(f"scene {port}: clip is not decodable media")
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
                window = (
                    min(clip_duration, float(trim_out)) if trim_out else clip_duration
                )
                duration = max(0.1, window - trim_in)
            segments.append(
                {
                    "scene": port,
                    "src": rel(path),
                    "narration": rel(narration.get(port)),
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
            "music": rel(ctx.input_artifacts.get(MUSIC_PORT)) or "",
            "music_volume": MUSIC_BED_VOLUME,
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
            segment["src"] = resolve(segment["src"])
            segment["narration"] = resolve(segment.get("narration"))
        lost = [s["scene"] for s in segments if not s["src"].exists()]
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
                fade_in = index > 0 and segments[index - 1].get("transition") == "dip"
                scene_files.append(
                    await self._render_segment(
                        segment, work / f"seg{index:03}.mp4", width, height,
                        encoder, workdir=work, fade_in=fade_in,
                    )
                )
                await ctx.progress(0.8 * (index + 1) / total)

            burn = self._burnable_captions(spec, ctx, work)
            cut = await self._join_segments(
                segments, scene_files, work, encoder, bitrate, burn
            )

            out = ctx.output_path(spec.output_hash, ".mp4")
            music = resolve(timeline.get("music", ""))
            if music is not None and await self._probe_duration(music) is not None:
                volume = float(timeline.get("music_volume", MUSIC_BED_VOLUME))
                await self._run(
                    "-i", str(cut), "-stream_loop", "-1", "-i", str(music),
                    "-filter_complex",
                    f"[1:a]volume={volume}[m];"
                    "[0:a][m]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
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

    def _burnable_captions(
        self, spec: JobSpec, ctx: ExecutionContext, work: Path
    ) -> Path | None:
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
                steps.append(f"{cur_a}[{i}:a]acrossfade=d={CROSSFADE_S}[a{i}]")
                cur_duration += duration_i - CROSSFADE_S
            else:
                steps.append(
                    f"{cur_v}{cur_a}[{i}:v][{i}:a]concat=n=2:v=1:a=1[v{i}][a{i}]"
                )
                cur_duration += duration_i
            cur_v, cur_a = f"[v{i}]", f"[a{i}]"

        if burn is not None:
            steps.append(f"{cur_v}ass='{burn}'[vout]")
            cur_v = "[vout]"
        if not steps:
            # Single segment, nothing to burn: re-encode to the target rate.
            await self._run(
                "-i", str(scene_files[0]),
                "-c:v", encoder, "-b:v", bitrate, "-c:a", "aac", "-b:a", "160k",
                str(cut),
            )
            return cut

        def map_arg(label: str) -> str:
            # Raw input streams ("[0:a]") are mapped without brackets; only
            # filtergraph outputs keep the label form.
            return label[1:-1] if ":" in label else label

        await self._run(
            *inputs,
            "-filter_complex", ";".join(steps),
            "-map", map_arg(cur_v), "-map", map_arg(cur_a),
            "-c:v", encoder, "-b:v", bitrate, "-c:a", "aac", "-b:a", "160k",
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
                raise GenerationError(
                    f"scene {segment.get('scene')}: clip is not decodable media"
                )
            clip_duration = probed
        trim_in = float(segment.get("trim_in") or 0.0)
        if trim_in >= clip_duration:
            trim_in = 0.0  # a trim that consumed the whole clip is void

        narration = segment.get("narration")
        if narration is not None and not Path(narration).exists():
            # A narration the timeline references but that vanished is
            # corruption — fail loudly rather than shipping a silent scene.
            raise GenerationError(
                f"scene {segment.get('scene')}: narration artifact is missing"
            )

        args: list[str] = []
        if trim_in:
            args += ["-ss", f"{trim_in:.3f}"]
        if clip_duration - trim_in < target:
            args += ["-stream_loop", "-1"]  # loop short clips up to target
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
            *args, "-t", f"{target:.3f}", "-map", "0:v", *audio,
            "-vf", vf, "-c:v", encoder, "-b:v", "12M", str(out),
        )
        return out

    # -- helpers ------------------------------------------------------------------

    async def _run(self, *args: str) -> None:
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffmpeg_bin, "-y", "-hide_banner", *args,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise GenerationError(f"ffmpeg binary not found: {self.ffmpeg_bin}") from exc
        _, stderr = await process.communicate()
        if process.returncode != 0:
            raise GenerationError(f"ffmpeg failed: {stderr.decode()[-600:]}")

    async def _probe_duration(self, path: Path) -> float | None:
        if not path.exists():
            return None
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffprobe_bin, "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", str(path),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
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
                        self.ffmpeg_bin, "-y", "-hide_banner",
                        "-f", "lavfi", "-i", "color=black:size=256x256:duration=0.1",
                        "-frames:v", "1", "-c:v", candidate, "-f", "null", "-",
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    )
                except FileNotFoundError as exc:
                    raise GenerationError(
                        f"ffmpeg binary not found: {self.ffmpeg_bin}"
                    ) from exc
                await process.communicate()
                if process.returncode == 0:
                    self._encoder = candidate
                    break
            else:
                raise GenerationError("no working H.264/MPEG-4 encoder in this ffmpeg build")
        return self._encoder
