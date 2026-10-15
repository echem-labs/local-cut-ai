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

Present is not the same as working, and `runtime_problem` is the one
answer to whether it works: the /voices capability, the refusal at the
consented upload and a render that cannot load the model all read it, so
what the user is offered and what a render meets cannot disagree.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import shutil
import tempfile
import threading
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import VOICE_REF_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError
from .ffmpeg import FFmpegBin, resolve_ffmpeg

logger = logging.getLogger(__name__)

CLONE_MODEL = "local:chatterbox"
_SPEED_MIN, _SPEED_MAX = 0.5, 2.0  # atempo's single-pass range

INSTALL_HINT = (
    "voice cloning requires the chatterbox-tts package (PyTorch) in the engine "
    "environment, and engine/clone-requirements.txt lists what it needs. In a dev "
    "checkout, start the engine with `uv run --with-requirements clone-requirements.txt "
    "localcut serve`, or the desktop dev shell with LOCALCUT_DEV_CLONE=1; "
    "docs/voices.md has the steps."
)


def _has_module(name: str) -> bool:
    """Whether `name` can be found, without importing it."""
    from importlib.util import find_spec

    try:
        return find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _import_problem() -> str | None:
    """Import chatterbox the way a render will, and say what stopped it.

    `chatterbox.tts` is the module a render loads the model from, and
    importing it brings in PyTorch, transformers and resemble-perth. Any
    exception counts, not only ImportError: a torch whose DLLs will not load
    raises OSError on Windows, and a transformers that dislikes the installed
    tokenizers raises at import time, not when it is used.

    The watermarker needs its own look. resemble-perth wraps its implicit
    watermarker's import in `except ImportError` and leaves the name as None,
    so the package imports cleanly and ChatterboxTTS only finds out when it
    calls None while constructing a model. The cause seen so far is
    `pkg_resources`, which perth imports and setuptools 82 stopped shipping.

    Each reason ends by asking for a restart, because `runtime_problem`
    keeps the answer for the life of the process.
    """
    try:
        importlib.import_module("chatterbox.tts")
        perth = importlib.import_module("perth")
    except Exception as exc:  # noqa: BLE001 - whatever the import raised is the answer
        logger.warning("chatterbox-tts is installed but does not import", exc_info=True)
        return (
            f"chatterbox-tts is installed but does not import ({type(exc).__name__}: {exc}). "
            "Repair the engine environment as docs/voices.md describes, then restart "
            "the engine."
        )
    if getattr(perth, "PerthImplicitWatermarker", None) is not None:
        return None
    if not _has_module("pkg_resources"):
        # setuptools 81 still ships it behind a deprecation warning, and that
        # warning's own advice is `<81`, so that is the pin to name.
        return (
            "chatterbox-tts imports, but its watermarker (resemble-perth) does not: it "
            "needs pkg_resources, which setuptools 82 and later no longer ship. Run "
            '`uv pip install "setuptools<81"` in the engine environment, then restart '
            "the engine."
        )
    return (
        "chatterbox-tts imports, but its watermarker (resemble-perth's "
        "PerthImplicitWatermarker) does not, so no voice model can load. Check that "
        "resemble-perth imports in the engine environment, then restart the engine."
    )


class ChatterboxBackend(ExecutionBackend):
    name = "chatterbox"

    def __init__(self, models_dir: Path, ffmpeg_bin: FFmpegBin = "ffmpeg") -> None:
        # Optional manifest-managed weights; absent → the package's own
        # from_pretrained cache (HF hub) is used.
        self.model_dir = models_dir / "tts" / "chatterbox"
        self._ffmpeg_bin = ffmpeg_bin
        self._engine = None
        # Serialize load + GPU inference (like Kokoro/align): concurrent
        # narration jobs would otherwise double-load the weights into VRAM and
        # run simultaneous CUDA generate() calls → out-of-memory.
        self._lock = asyncio.Lock()
        # `runtime_problem` runs on worker threads (a route and a render can
        # ask at once), and the import it guards should happen once.
        self._probe_lock = threading.Lock()
        self._probed = False
        self._problem: str | None = None

    @property
    def ffmpeg_bin(self) -> str:
        """Asked at each use, as FFmpegBackend asks: the retime runs whichever
        binary is there when the job does."""
        return resolve_ffmpeg(self._ffmpeg_bin)

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.NARRATION

    def serves_model(self, model: str | None) -> bool:
        return model == CLONE_MODEL

    @staticmethod
    def package_installed() -> bool:
        """Whether the optional runtime is installed at all.

        `find_spec`, not an import: importing chatterbox pulls PyTorch into
        the engine process, which is seconds and hundreds of MB, and on most
        machines the package is simply absent. This is the cheap first
        question; `runtime_problem` asks the expensive one only past it.
        """
        return _has_module("chatterbox")

    def runtime_problem(self) -> str | None:
        """Why a clone cannot run here, or None when it can. Blocking.

        The clone control is the one place a user commits to this before any
        job runs: ticking consent and picking a sample rewrites EVERY
        narration node to `local:chatterbox`, so a runtime that cannot load
        fails all of them at once, and clearing it means editing each node by
        hand in the advanced inspector. A client that can ask this first can
        decline the trade instead of discovering it afterwards, which only
        works if the answer comes from the import rather than from the
        package being on disk: a dev checkout's `uv run` re-syncs the
        environment to the lockfile underneath an installed chatterbox, and
        an install that took the latest setuptools never had a watermarker.

        Absence is checked on every call, so a package installed while the
        engine runs is picked up without a restart. Past that, the import
        happens once and the answer is kept, failure included: it loads
        PyTorch, so callers run this off the event loop, and a second try in
        the same process meets the half-imported modules the first left
        behind rather than the environment as it now is.
        """
        if not self.package_installed():
            return INSTALL_HINT
        with self._probe_lock:
            if not self._probed:
                self._problem = _import_problem()
                self._probed = True
            return self._problem

    def _load(self):
        problem = self.runtime_problem()
        if problem is not None:
            raise GenerationError(problem)
        import torch
        from chatterbox.tts import ChatterboxTTS

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
