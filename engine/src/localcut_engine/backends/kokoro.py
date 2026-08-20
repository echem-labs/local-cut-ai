"""Kokoro TTS backend — the fast narration tier. Runs on CPU via ONNX
(kokoro-onnx), so it never competes with the GPU pipeline; the quality
tier (Chatterbox, with cloning + consent gate) arrives as a second
SpeechGen backend later.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

log = logging.getLogger(__name__)

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
DEFAULT_VOICE = "af_sarah"

#: Kokoro voice ids encode their language and gender in the first two
#: characters — `bf_emma` is British female, `am_onyx` American male. These
#: are the espeak codes the ids map onto; the English names for them live in
#: the desktop's i18n catalog, because the wire carries ids and the client
#: does the labelling (see `voices.json`, pinned by test_ui_contract.py).
_VOICE_LANGUAGES = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt-br",
    "z": "cmn",
}
_GENDERS = {"f": "female", "m": "male"}

#: espeak phonemizes the *text*, and the narration text is always English —
#: the script LLM writes English and a node carries no language of its own.
#: Only the two English variants may reach `create(lang=...)`: a Japanese
#: code makes espeak spell English out letter by letter ("ˈeɪtʃ ˈiː ˈɛl"),
#: and fr/hi/cmn emit literal "(en)" switch markers that survive Kokoro's
#: vocab filter and get voiced. A voice's own language is still reported by
#: `describe_voice` — it just cannot decide how English text is read.
_SPEAKABLE_CODES = frozenset({"en-us", "en-gb"})
_FALLBACK_CODE = "en-us"

#: The speeds kokoro-onnx accepts, guarded there by a bare assert. Anything
#: outside is clamped rather than allowed to reach it.
_SPEED_FLOOR, _SPEED_CEILING = 0.5, 2.0


#: The whole `<language><gender>_<stem>` shape, matched before any single
#: letter is trusted: `jenny` starts with `j`, and filing it under Japanese
#: is the guess this pattern exists to avoid. Each group is then read on its
#: own, so a pack carrying a language prefix this file does not know still
#: reports that voice's gender and name and reports only its language as
#: unknown. Used with `fullmatch`, so a trailing newline is not an id.
_VOICE_ID_SCHEME = re.compile(r"([a-z])([fm])_(.+)")


def language_of(voice_id: str) -> str:
    """The espeak language code to phonemize this voice's English text with.

    British voices read English as British. Every other voice reads it as
    American, because the alternative is not an accent but an unintelligible
    rendering; see `_SPEAKABLE_CODES`.
    """
    scheme = _VOICE_ID_SCHEME.fullmatch(voice_id)
    code = _VOICE_LANGUAGES.get(scheme.group(1)) if scheme else None
    return code if code in _SPEAKABLE_CODES else _FALLBACK_CODE


def describe_voice(voice_id: str) -> dict[str, str | None]:
    """One voice, as the API and a picker need it.

    Derived from the id rather than a table of 54 entries: the pack ships
    more voices than any hand-written list would stay current with, and the
    naming convention is the pack's own.

    Everything here is an id, not display copy: `language_code` is an espeak
    code and `gender` a bare token, both labelled client-side out of
    `i18n/en/voices.json`. An engine that sent "American English" would put
    the one untranslatable string in the app on the picker. A language the
    table does not name reports null rather than a guess — null is what the
    catalog renders as "unknown", and it cannot be mistaken for a real code.

    `name` is the stem, and the stem alone is NOT unique across the pack:
    `am_santa`, `em_santa` and `pm_santa` all read "Santa". A picker showing
    one flat list has to qualify it with `language_code`; `id` is the only
    field that identifies a voice.
    """
    scheme = _VOICE_ID_SCHEME.fullmatch(voice_id)
    if scheme is None:
        # An id outside the scheme is shown as it is rather than reshaped.
        return {"id": voice_id, "name": voice_id, "language_code": None, "gender": None}
    language, gender, stem = scheme.groups()
    return {
        "id": voice_id,
        # `af_sarah` -> `Sarah`. The id stays the identifier; this is for reading.
        "name": stem.replace("-", " ").title(),
        "language_code": _VOICE_LANGUAGES.get(language),
        "gender": _GENDERS[gender],
    }


def pick_voice(brief: str) -> str:
    words = set(re.findall(r"[a-z]+", brief.lower()))
    for keyword, voice in _VOICE_MAP:
        if keyword in words:  # whole words only: "female" must not match "male"
            return voice
    return DEFAULT_VOICE


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

        Read from the pack itself rather than from a list in the source: it
        holds an order of magnitude more voices than the keyword table above
        names, and a hand-written list cannot stay current with a file the
        user downloads.

        The names are the keys of the voices archive, so this reads that file
        and not the 325 MB inference session beside it. Going through
        `_load()` would cost ~1.1s and ~476 MB to answer with 54 strings,
        pin the session for the life of the process, hold the archive open
        against a later re-download, and — since `_lock` is an asyncio lock
        this cannot take from a worker thread — race `_load()` into building
        a second session while a narration job is loading the first.
        """
        return [describe_voice(voice_id) for voice_id in sorted(self._installed_ids())]

    def _installed_ids(self) -> set[str]:
        """The voice ids in the pack, or an empty set if it cannot be read."""
        try:
            import numpy as np

            with np.load(self.voices_path) as archive:
                return set(archive.files)
        except Exception as exc:
            # Absent is the ordinary first-run state; unreadable is not, and
            # losing the reason for it silently is how a corrupt pack looks
            # identical to a missing one. Either way a caller gets "nothing".
            if self.voices_path.exists():
                log.warning("kokoro voice pack at %s is unreadable: %s", self.voices_path, exc)
            return set()

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
        # kokoro-onnx meets an unknown voice as a bare `assert voice in
        # self.voices`, which escapes as an AssertionError rather than this
        # backend's error contract — so the board would show a stray
        # assertion instead of a reason. Checked only when the pack could
        # actually be read: an empty set means "unreadable", not "holds no
        # voices", and must not reject everything.
        installed = self._installed_ids()
        if installed and voice not in installed:
            raise GenerationError(
                f"no voice {voice!r} in the installed pack - pick one of: "
                f"{', '.join(sorted(installed)[:8])}..."
            )
        # A raw /patch can carry a null/garbage speed; coerce safely, then
        # clamp. kokoro-onnx meets an out-of-range speed with a bare assert
        # two lines above the voice one, so an unclamped value escapes as an
        # AssertionError rather than this backend's error contract — and only
        # after the 325 MB session has been built for a job that cannot run.
        # This is the synthesizer's own range; the product's tighter bound is
        # the editor's, and clamping to it here would silently rewrite a
        # speed a client set deliberately. NaN falls out at the floor.
        try:
            speed = float(spec.params.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(_SPEED_CEILING, max(_SPEED_FLOOR, speed))

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
