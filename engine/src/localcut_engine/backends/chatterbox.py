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
import shutil
import tempfile
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import VOICE_REF_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

CLONE_MODEL = "local:chatterbox"
_SPEED_MIN, _SPEED_MAX = 0.5, 2.0  # atempo's single-pass range

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
        # Serialize load + GPU inference (like Kokoro/align): concurrent
        # narration jobs would otherwise double-load the weights into VRAM and
        # run simultaneous CUDA generate() calls → out-of-memory.
        self._lock = asyncio.Lock()

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.NARRATION

    def serves_model(self, model: str | None) -> bool:
        return model == CLONE_MODEL

    @staticmethod
    def package_installed() -> bool:
        """Whether the optional runtime is importable.

        The clone control is the one place a user commits to this before any
        job runs: ticking consent and picking a sample rewrites EVERY
        narration node to `local:chatterbox`, so an absent package fails all
        of them at once, and clearing it means editing each node by hand in
        the advanced inspector. A client that can ask this first can decline
        the trade instead of discovering it afterwards.

        `find_spec`, not an import: importing chatterbox pulls PyTorch into
        the engine process, which is seconds and hundreds of MB for a
        question asked on a route that just lists voices.
        """
        from importlib.util import find_spec

        try:
            return find_spec("chatterbox") is not None
        except (ImportError, ValueError):
            return False

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
        # A raw /patch can carry a null/garbage speed — coerce safely.
        try:
            speed = float(spec.params.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        # atempo covers only a single-pass [0.5, 2.0]; clamp here so the retime
        # decision, the atempo factor, and the produced file's duration all
        # agree — otherwise a speed>2 asks for a stretch we can't render and the
        # audio length no longer matches the window the timeline laid out.
        speed = max(_SPEED_MIN, min(_SPEED_MAX, speed))

        out = ctx.output_path(spec.output_hash, ".wav")  # also mkdirs output_dir
        # Build in a temp dir on the SAME filesystem as the artifact (so the
        # final move is an atomic rename) and publish `{hash}.wav` only once —
        # a retime failure must never leave a full-speed file that the
        # existence cache then serves as a valid render forever. A subdir
        # isn't matched by the flat `{hash}.*` artifact scan.
        tmp_dir = Path(tempfile.mkdtemp(prefix=".tts-", dir=ctx.output_dir))
        try:
            raw = tmp_dir / "raw.wav"

            def synth() -> None:
                import numpy as np
                import soundfile as sf

                engine = self._load()
                wav = engine.generate(text, audio_prompt_path=str(sample))
                samples = wav.squeeze(0).cpu().numpy().astype(np.float32)
                sf.write(raw, samples, engine.sr)

            async with self._lock:
                await asyncio.to_thread(synth)
            final = raw
            if abs(speed - 1.0) > 0.01:
                final = tmp_dir / "retimed.wav"
                await self._retime(raw, final, speed)
            final.replace(out)  # atomic rename within the project dir's fs
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        await ctx.progress(1.0)
        return out

    async def _retime(self, src: Path, dst: Path, speed: float) -> None:
        """Pitch-preserving tempo change via ffmpeg atempo (src → dst)."""
        proc = await asyncio.create_subprocess_exec(
            self.ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-v",
            "error",
            "-i",
            str(src),
            "-filter:a",
            f"atempo={speed:.4f}",  # speed is pre-clamped to atempo's range
            str(dst),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise GenerationError(f"chatterbox speed retime failed: {stderr.decode()[-300:]}")
