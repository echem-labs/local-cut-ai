"""Voice-cloned narration via Chatterbox TTS (MIT).

Serves NARRATION nodes whose model is `local:chatterbox`, cloning the
speaker from the voice-sample asset wired to the node's `voice_ref` port.
Consent is enforced at two seams so no unconsented sample can reach this
backend: the asset upload API refuses audio without an explicit consent
affirmation (and stamps `voice_consent` on the asset node), and the
`connect` patch op refuses to wire anything but a consented voice-sample
asset into a `voice_ref` port (graph/patch.py). This backend therefore
only ever receives a path it can trust; it verifies the sample is present,
not that it was consented (the graph guarantees that upstream).

The chatterbox-tts package (PyTorch) is an optional runtime, resolved
lazily like ComfyUI or Ollama: the engine drives it when present and fails
loudly when it isn't. A cloned narration NEVER falls back to a stock
voice — the user asked for their speaker and must not silently get
someone else's.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import VOICE_REF_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

CLONE_MODEL = "local:chatterbox"

_INSTALL_HINT = (
    "voice cloning requires the chatterbox-tts package (PyTorch) in the engine "
    "environment — install it with `uv pip install chatterbox-tts`. If it fails to "
    "build on this Python version, cloning lights up automatically once upstream "
    "ships compatible wheels."
)


class ChatterboxBackend(ExecutionBackend):
    name = "chatterbox"

    def __init__(self, models_dir: Path, ffmpeg_bin: str = "ffmpeg") -> None:
        # Optional manifest-managed weights; absent → the package's own
        # from_pretrained cache (HF hub) is used.
        self.model_dir = models_dir / "tts" / "chatterbox"
        self.ffmpeg_bin = ffmpeg_bin
        self._engine = None

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.NARRATION

    def serves_model(self, model: str | None) -> bool:
        return model == CLONE_MODEL

    def _load(self):
        try:
            import torch
            from chatterbox.tts import ChatterboxTTS
        except ImportError as exc:
            raise GenerationError(_INSTALL_HINT) from exc
        if self._engine is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if (self.model_dir / "ve.safetensors").exists():
                self._engine = ChatterboxTTS.from_local(str(self.model_dir), device)
            else:
                self._engine = ChatterboxTTS.from_pretrained(device=device)
        return self._engine

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        text = str(spec.params.get("text", "")).strip()
        if not text:
            raise GenerationError("narration node has no text")
        sample = ctx.input_artifacts.get(VOICE_REF_PORT)
        if sample is None or not Path(sample).exists():
            raise GenerationError(
                "cloned narration needs a consented voice sample wired to its "
                f"{VOICE_REF_PORT!r} port"
            )

        # Per-line pacing: Chatterbox has no native rate control, so honor
        # `speed` by pitch-preserving time-stretch of its output (Kokoro does
        # this internally). speed>1 = faster/shorter, matching Kokoro's sense.
        speed = float(spec.params.get("speed", 1.0))

        def synth() -> Path:
            import numpy as np
            import soundfile as sf

            engine = self._load()
            wav = engine.generate(text, audio_prompt_path=str(sample))
            samples = wav.squeeze(0).cpu().numpy().astype(np.float32)
            out = ctx.output_path(spec.output_hash, ".wav")
            sf.write(out, samples, engine.sr)
            return out

        out = await asyncio.to_thread(synth)
        if abs(speed - 1.0) > 0.01:
            await self._retime(out, speed)
        await ctx.progress(1.0)
        return out

    async def _retime(self, path: Path, speed: float) -> None:
        """Pitch-preserving tempo change via ffmpeg atempo, in place."""
        tmp = path.with_suffix(".retimed.wav")
        proc = await asyncio.create_subprocess_exec(
            self.ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-v",
            "error",
            "-i",
            str(path),
            "-filter:a",
            f"atempo={max(0.5, min(2.0, speed)):.4f}",
            str(tmp),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode == 0:
            tmp.replace(path)
        else:
            tmp.unlink(missing_ok=True)
            raise GenerationError(f"chatterbox speed retime failed: {stderr.decode()[-300:]}")
