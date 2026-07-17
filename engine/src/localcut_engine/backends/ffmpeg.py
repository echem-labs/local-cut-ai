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
from ..graph.compiler import JobSpec
from ..graph.model import (
    DEFAULT_PORT,
    MUSIC_PORT,
    SCENE_AUDIO_SUFFIX,
    NodeKind,
    scene_sort_key,
)
from .base import ExecutionBackend, ExecutionContext, GenerationError

_KINDS = {NodeKind.TIMELINE, NodeKind.EXPORT, NodeKind.CAPTIONS}

NARRATION_PAD_S = 0.35  # breathing room after each narration line
MUSIC_BED_VOLUME = 0.22  # constant-level bed under narration


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
                return self._build_timeline(spec, ctx)
            case NodeKind.CAPTIONS:
                return self._build_captions(spec, ctx)
            case NodeKind.EXPORT:
                return await self._export(spec, ctx)
        raise GenerationError(f"ffmpeg backend cannot handle {spec.kind}")

    # -- timeline: an explicit edit decision list (JSON) -----------------------

    def _build_timeline(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        def rel(path: Path | None) -> str | None:
            # EDLs are cached artifacts inside the .lcut dir: paths must stay
            # relative to generated/ or relocating the project bricks export.
            if path is None:
                return None
            p = Path(path)
            return p.name if p.parent == ctx.output_dir else str(p)

        narration = {
            port.removesuffix(SCENE_AUDIO_SUFFIX): rel(path)
            for port, path in ctx.input_artifacts.items()
            if port.endswith(SCENE_AUDIO_SUFFIX)
        }
        scenes = sorted(
            (
                (port, rel(path))
                for port, path in ctx.input_artifacts.items()
                if not port.endswith(SCENE_AUDIO_SUFFIX) and port != MUSIC_PORT
            ),
            key=lambda item: scene_sort_key(item[0]),
        )
        timeline = {
            "aspect": spec.params.get("aspect", DEFAULT_ASPECT),
            "video": [
                {
                    "scene": port,
                    "src": src,
                    "narration": narration.get(port),
                    "transition": "cut",
                }
                for port, src in scenes
            ],
            "music": rel(ctx.input_artifacts.get(MUSIC_PORT)) or "",
            "music_volume": MUSIC_BED_VOLUME,
        }
        out = ctx.output_path(spec.output_hash, ".timeline.json")
        out.write_text(json.dumps(timeline, indent=2))
        return out

    def _build_captions(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        # v1 stub: forced alignment (faster-whisper) lands with the caption
        # styling pass; until then emit an empty-but-valid sidecar.
        out = ctx.output_path(spec.output_hash, ".srt")
        out.write_text("")
        return out

    # -- export: scenes → timed segments → concat → music bed ------------------

    async def _export(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        timeline_path = ctx.input_artifacts.get(DEFAULT_PORT)
        if timeline_path is None or not Path(timeline_path).exists():
            raise GenerationError("export job is missing its timeline input")
        timeline = json.loads(Path(timeline_path).read_text())

        def resolve(src: str | None) -> Path | None:
            # EDL v3 stores names relative to generated/; absolute paths are
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
        # Never under generated/ — everything there is treated as an artifact.
        work = Path(tempfile.mkdtemp(prefix="localcut-export-"))
        try:
            scene_files: list[Path] = []
            total = len(segments)
            for index, segment in enumerate(segments):
                scene_files.append(
                    await self._render_segment(segment, work / f"seg{index:03}.mp4",
                                               width, height, encoder)
                )
                await ctx.progress(0.8 * (index + 1) / total)

            # Concat *filter*, not the demuxer: stream-copy concat of AAC
            # segments accumulates timestamp gaps (apad's trailing frames),
            # drifting total duration ~0.4s per scene. The filter re-encode
            # is sample-exact; TS-intermediate copy concat is the future
            # optimization if export time ever matters.
            cut = work / "cut.mp4"
            inputs: list[str] = []
            for path in scene_files:
                inputs += ["-i", str(path)]
            chains = "".join(f"[{i}:v][{i}:a]" for i in range(len(scene_files)))
            await self._run(
                *inputs,
                "-filter_complex", f"{chains}concat=n={len(scene_files)}:v=1:a=1[v][a]",
                "-map", "[v]", "-map", "[a]",
                "-c:v", encoder, "-c:a", "aac", "-b:a", "160k",
                str(cut),
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

    async def _render_segment(
        self, segment: dict, out: Path, width: int, height: int, encoder: str
    ) -> Path:
        """One scene: video trimmed/looped to narration length + padding."""
        clip = str(segment["src"])
        clip_duration = await self._probe_duration(Path(clip))
        if clip_duration is None:
            raise GenerationError(f"scene {segment.get('scene')}: clip is not decodable media")

        narration = segment.get("narration")
        narration_duration = (
            await self._probe_duration(Path(narration)) if narration else None
        )
        if narration and narration_duration is None:
            # A narration the timeline references but ffprobe can't read is
            # corruption — fail loudly rather than shipping a silent scene.
            raise GenerationError(
                f"scene {segment.get('scene')}: narration is not decodable media"
            )
        target = (
            narration_duration + NARRATION_PAD_S
            if narration_duration is not None
            else clip_duration
        )

        args: list[str] = []
        if clip_duration < target:
            args += ["-stream_loop", "-1"]  # loop short clips up to target
        args += ["-i", clip]
        if narration_duration is not None:
            args += ["-i", str(narration)]
            audio = ["-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "160k"]
        else:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            audio = ["-map", "1:a", "-c:a", "aac", "-b:a", "160k"]
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps=24,format=yuv420p"
        )
        await self._run(
            *args, "-t", f"{target:.3f}", "-map", "0:v", *audio,
            "-vf", vf, "-c:v", encoder, str(out),
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
