"""Kokoro TTS backend — the fast narration tier. Runs on CPU via ONNX
(kokoro-onnx), so it never competes with the GPU pipeline; the quality
tier (Chatterbox, with cloning + consent gate) arrives as a second
SpeechGen backend later.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

# Style-brief keywords → Kokoro voice ids (proper voice picker UI is Phase 1).
# Explicit gender words outrank tone words so "deep female voice" never
# resolves to a male voice.
_VOICE_MAP = [
    ("female", "af_sarah"),
    ("woman", "af_sarah"),
    ("male", "am_michael"),
    ("man", "am_michael"),
    ("british", "bf_emma"),
    ("deep", "am_onyx"),
    ("energetic", "af_bella"),
]
_DEFAULT_VOICE = "af_sarah"


def pick_voice(brief: str) -> str:
    words = set(re.findall(r"[a-z]+", brief.lower()))
    for keyword, voice in _VOICE_MAP:
        if keyword in words:  # whole words only: "female" must not match "male"
            return voice
    return _DEFAULT_VOICE


# Fallbacks when no manifest is available; normally the dests come from the
# kokoro-82m manifest entry so a manifest update moves the probe with it.
_DEFAULT_DESTS = ("tts/kokoro-v1.0.onnx", "tts/voices-v1.0.bin")


class KokoroBackend(ExecutionBackend):
    name = "kokoro"

    def __init__(self, models_dir: Path, file_dests: list[str] | None = None) -> None:
        dests = file_dests or list(_DEFAULT_DESTS)
        self.model_path = models_dir / next(
            (d for d in dests if d.endswith(".onnx")), _DEFAULT_DESTS[0]
        )
        self.voices_path = models_dir / next(
            (d for d in dests if d.endswith(".bin")), _DEFAULT_DESTS[1]
        )
        self._engine = None
        self._lock = asyncio.Lock()

    def supports(self, kind: NodeKind) -> bool:
        # Claim narration only while the voice weights are on disk, live —
        # a finished download flips this without a restart, and a fresh
        # machine falls through to mock instead of failing jobs.
        return kind is NodeKind.NARRATION and self.model_path.exists() and self.voices_path.exists()

    def serves_model(self, model: str | None) -> bool:
        # A voice-clone request must never silently land on stock voices —
        # if the chain has no cloning backend, the job fails with the reason.
        from .chatterbox import CLONE_MODEL

        return model != CLONE_MODEL

    def _load(self):
        if self._engine is None:
            if not self.model_path.exists() or not self.voices_path.exists():
                raise GenerationError(
                    "Kokoro model files missing - run: localcut download kokoro-82m"
                )
            from kokoro_onnx import Kokoro

            self._engine = Kokoro(str(self.model_path), str(self.voices_path))
        return self._engine

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        text = str(spec.params.get("text", "")).strip()
        if not text:
            raise GenerationError("narration node has no text")
        voice = str(spec.params.get("voice_id") or pick_voice(str(spec.params.get("voice", ""))))
        # A raw /patch can carry a null/garbage speed; coerce safely.
        try:
            speed = float(spec.params.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0

        def synth(target: Path) -> None:
            import soundfile as sf

            engine = self._load()
            samples, sample_rate = engine.create(text, voice=voice, speed=speed, lang="en-us")
            sf.write(str(target), samples, sample_rate)

        # ONNX inference is blocking; one at a time keeps memory bounded.
        # Synthesize into the temp name and publish on success: an inference
        # that dies partway must not leave a clipped {hash}.wav that the
        # existence cache serves as finished narration forever.
        async with self._lock:
            with ctx.publishing(spec.output_hash, ".wav") as partial:
                await asyncio.to_thread(synth, partial)
        await ctx.progress(1.0)
        return ctx.output_path(spec.output_hash, ".wav")
