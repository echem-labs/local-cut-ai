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

#: Kokoro voice ids encode their language and gender in the first two
#: characters — `bf_emma` is British female, `am_onyx` American male. The
#: language half decides which phoneme set espeak produces, so it is not
#: cosmetic: synthesising a British voice with American phonemes is what this
#: engine did while the language was hardcoded.
_VOICE_LANGUAGES = {
    "a": ("en-us", "American English"),
    "b": ("en-gb", "British English"),
    "e": ("es", "Spanish"),
    "f": ("fr-fr", "French"),
    "h": ("hi", "Hindi"),
    "i": ("it", "Italian"),
    "j": ("ja", "Japanese"),
    "p": ("pt-br", "Portuguese"),
    "z": ("cmn", "Mandarin"),
}
_GENDERS = {"f": "female", "m": "male"}

#: Where a voice id does not follow the convention, rather than guessing.
_UNKNOWN_LANGUAGE = ("en-us", "unknown")


def language_of(voice_id: str) -> str:
    """The espeak language code to phonemize this voice's text with."""
    return _VOICE_LANGUAGES.get(voice_id[:1], _UNKNOWN_LANGUAGE)[0]


def describe_voice(voice_id: str) -> dict[str, str]:
    """One voice, as the API and a picker need it.

    Derived from the id rather than a table of 54 entries: the pack ships
    more voices than any hand-written list would stay current with, and the
    naming convention is the pack's own.
    """
    code, language = _VOICE_LANGUAGES.get(voice_id[:1], _UNKNOWN_LANGUAGE)
    gender = _GENDERS.get(voice_id[1:2], "unknown")
    # `af_sarah` -> `Sarah`. The id stays the identifier; this is for reading.
    name = voice_id.split("_", 1)[-1].replace("-", " ").title() if "_" in voice_id else voice_id
    return {
        "id": voice_id,
        "name": name,
        "language": language,
        "language_code": code,
        "gender": gender,
    }


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

    def installed_voices(self) -> list[dict[str, str]]:
        """Every voice in the installed pack, or nothing if it is not on disk.

        Read from the pack itself rather than from a list in the source: the
        product shipped five voices out of the fifty-four this file has always
        contained, because the five were written down in a keyword table and
        nothing ever asked the pack what it held.
        """
        if not self.model_path.exists() or not self.voices_path.exists():
            return []
        try:
            voices = self._load().get_voices()
        except Exception:
            # An unreadable pack is a readiness problem, reported by that
            # surface. A picker asking what is available gets "nothing".
            return []
        return [describe_voice(voice_id) for voice_id in sorted(voices)]

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
            samples, sample_rate = engine.create(
                text, voice=voice, speed=speed, lang=language_of(voice)
            )
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
