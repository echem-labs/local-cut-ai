"""Voice-cloned narration via Chatterbox TTS (MIT).

Serves NARRATION nodes whose model is `local:chatterbox`, cloning the
speaker from the voice-sample asset wired to the node's `voice_ref` port.
Consent is enforced at the seam where it matters — the asset upload API
refuses audio without an explicit consent affirmation — so by construction
no unconsented sample can reach this backend; the check here is
belt-and-braces.

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

    def __init__(self, models_dir: Path) -> None:
        # Optional manifest-managed weights; absent → the package's own
        # from_pretrained cache (HF hub) is used.
        self.model_dir = models_dir / "tts" / "chatterbox"
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

        def synth() -> Path:
            import soundfile as sf

            engine = self._load()
            wav = engine.generate(text, audio_prompt_path=str(sample))
            out = ctx.output_path(spec.output_hash, ".wav")
            sf.write(out, wav.squeeze(0).cpu().numpy(), engine.sr)
            return out

        out = await asyncio.to_thread(synth)
        await ctx.progress(1.0)
        return out
