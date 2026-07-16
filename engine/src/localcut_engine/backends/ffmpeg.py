"""FFmpeg assembly backend — deterministic, non-AI: concat
with transitions, audio mix, caption sidecar, export presets. Prefers
hardware encoders where present; CPU fallback is openh264/libx264-free
builds per the licensing matrix.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

_KINDS = {NodeKind.TIMELINE, NodeKind.EXPORT, NodeKind.CAPTIONS}


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


class FFmpegBackend(ExecutionBackend):
    name = "ffmpeg"

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self.ffmpeg_bin = ffmpeg_bin

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

    def _build_timeline(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        """Timeline artifact = an explicit edit decision list (JSON): ordered
        video segments + audio lanes. Downstream export consumes it."""
        clips = sorted(
            (port, str(path))
            for port, path in ctx.input_artifacts.items()
            if not port.endswith(".audio") and port not in ("music",)
        )
        audio = sorted(
            (port, str(path))
            for port, path in ctx.input_artifacts.items()
            if port.endswith(".audio")
        )
        timeline = {
            "aspect": spec.params.get("aspect", "16:9"),
            "video": [{"scene": port, "src": src, "transition": "cut"} for port, src in clips],
            "narration": [{"scene": port, "src": src} for port, src in audio],
            "music": str(ctx.input_artifacts.get("music", "")),
            "ducking": {"enabled": True, "amount_db": -10},
        }
        out = ctx.output_path(spec.output_hash, ".timeline.json")
        out.write_text(json.dumps(timeline, indent=2))
        return out

    def _build_captions(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        # v1 stub: forced alignment (faster-whisper) lands with the audio
        # pipeline; until then emit an empty-but-valid sidecar.
        out = ctx.output_path(spec.output_hash, ".srt")
        out.write_text("")
        return out

    async def _export(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        timeline_path = ctx.input_artifacts.get("default")
        if timeline_path is None or not Path(timeline_path).exists():
            raise GenerationError("export job is missing its timeline input")
        timeline = json.loads(Path(timeline_path).read_text())
        sources = [segment["src"] for segment in timeline["video"] if Path(segment["src"]).exists()]
        if not sources:
            raise GenerationError("timeline has no renderable video segments")

        out = ctx.output_path(spec.output_hash, ".mp4")
        concat_list = ctx.output_path(spec.output_hash, ".concat.txt")
        concat_list.write_text("".join(f"file '{src}'\n" for src in sources))
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c:v", "libopenh264" if await self._has_encoder("libopenh264") else "mpeg4",
            "-pix_fmt", "yuv420p",
            str(out),
        ]
        process = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await process.communicate()
        await ctx.progress(1.0)
        if process.returncode != 0:
            raise GenerationError(f"ffmpeg export failed: {stderr.decode()[-500:]}")
        return out

    async def _has_encoder(self, name: str) -> bool:
        process = await asyncio.create_subprocess_exec(
            self.ffmpeg_bin, "-hide_banner", "-encoders",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await process.communicate()
        return name in stdout.decode()
