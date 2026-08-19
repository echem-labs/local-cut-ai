"""Forced-alignment backend (faster-whisper, CPU int8) — turns the timeline's
narration tracks into word-timed captions. Consumes the EDL's stored segment
starts so caption timing and export timing can never disagree.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from pathlib import Path

import numpy as np

from ..captions import Word, anchor_words_to_text, cues_to_srt, words_to_cues
from ..graph.compiler import JobSpec
from ..graph.model import DEFAULT_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError
from .ffmpeg import ffmpeg_available

logger = logging.getLogger(__name__)

# Fallback when no manifest is available; normally the model dir comes from
# the faster-whisper-base-en manifest entry's file dests.
_DEFAULT_MODEL_DIR = "asr/faster-whisper-base.en"
# A progress publish that cannot land within this is not worth blocking
# transcription for — the SRT matters, the percentage does not.
_PROGRESS_TIMEOUT_S = 5.0
# Decoding runs about three orders of magnitude faster than real time, so this
# is not a budget — it is the bound on a decode that has stopped making
# progress at all. `synth()` runs on a worker thread that nothing can
# interrupt, under the inference lock, so without it a stalled ffmpeg wedges
# every later captions job and holds engine shutdown open behind it.
_DECODE_TIMEOUT_S = 120.0


class AlignBackend(ExecutionBackend):
    name = "align"

    def __init__(
        self,
        models_dir: Path,
        file_dests: list[str] | None = None,
        ffmpeg_bin: str = "ffmpeg",
    ) -> None:
        first = (file_dests or [f"{_DEFAULT_MODEL_DIR}/model.bin"])[0]
        self.model_dir = models_dir / Path(first).parent
        self.ffmpeg_bin = ffmpeg_bin
        self._model = None
        self._lock = asyncio.Lock()

    def supports(self, kind: NodeKind) -> bool:
        # Weights-gated like the other local backends: no whisper model on
        # disk → captions fall through to the chain's fallback. Binary-gated
        # too, the same way FFmpegBackend gates assembly: narration reaches
        # the model through the ffmpeg binary, so an aligner without one
        # cannot serve the kind at all and claiming it would turn every
        # captions job into a failure the readiness report called ready.
        return (
            kind is NodeKind.CAPTIONS
            and (self.model_dir / "model.bin").exists()
            and ffmpeg_available(self.ffmpeg_bin)
        )

    def _load(self):
        if self._model is None:
            if not (self.model_dir / "model.bin").exists():
                raise GenerationError(
                    "alignment model missing - run: localcut download faster-whisper-base-en"
                )
            from faster_whisper import WhisperModel

            self._model = WhisperModel(str(self.model_dir), device="cpu", compute_type="int8")
        return self._model

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        if not (self.model_dir / "model.bin").exists():
            raise GenerationError(
                "alignment model missing - run: localcut download faster-whisper-base-en"
            )
        timeline_path = ctx.input_artifacts.get(DEFAULT_PORT)
        if timeline_path is None or not Path(timeline_path).exists():
            raise GenerationError("captions job is missing its timeline input")
        timeline = json.loads(Path(timeline_path).read_text())
        segments = timeline.get("video", [])
        texts: dict = spec.params.get("texts") or {}

        def report(fraction: float) -> None:
            """Publish progress from the transcription thread onto the loop.

            The future is awaited, not discarded. A `concurrent.futures.Future`
            emits no "exception never retrieved" warning, so a progress persist
            that failed was completely invisible and the board silently stopped
            updating. Progress is also strictly best-effort: a failure here (or
            a loop that has already closed during shutdown) must never take
            down an otherwise-complete captions job before it writes its SRT.
            """
            coro = ctx.progress(fraction)
            try:
                future = asyncio.run_coroutine_threadsafe(coro, loop)
            except RuntimeError:
                # Loop closed under us (shutdown) — the SRT still lands. Close
                # the coroutine explicitly: an un-awaited one warns at GC time,
                # in an unrelated stack, about a shutdown that was orderly.
                coro.close()
                return
            try:
                future.result(timeout=_PROGRESS_TIMEOUT_S)
            except TimeoutError:
                future.cancel()
                logger.debug("progress publish timed out; continuing transcription")
            except Exception:  # noqa: BLE001 — progress must not fail the job
                logger.warning("progress publish failed during alignment", exc_info=True)

        def synth() -> Path:
            words: list[Word] = []
            total = len(segments) or 1
            for index, segment in enumerate(segments):
                narration = segment.get("narration")
                if not narration:
                    continue
                path = Path(narration)
                if not path.is_absolute():
                    path = ctx.output_dir / path
                if not path.exists():
                    raise GenerationError(
                        f"scene {segment.get('scene')}: narration artifact is missing"
                    )
                offset = float(segment.get("start", 0.0))
                scene_words = self._align_one(path, offset)
                # Anchor to the script's narration when the graph provides
                # it — the transcription is timing scaffolding, not text.
                truth = texts.get(str(segment.get("scene")))
                if truth:
                    # floor=offset: head words the ASR dropped may be laid back
                    # into this scene's own window, never into the one before.
                    scene_words = anchor_words_to_text(scene_words, truth, floor=offset)
                words.extend(scene_words)
                report(0.9 * (index + 1) / total)
            # publish_text encodes UTF-8 and renames into place: a transcribed
            # non-cp1252 character (CJK/Cyrillic proper noun, em-dash) would
            # crash on Windows' default codepage, and a truncated SRT would be
            # served as finished captions forever.
            return ctx.publish_text(spec.output_hash, ".srt", cues_to_srt(words_to_cues(words)))

        loop = asyncio.get_running_loop()
        # CPU inference is blocking; one at a time keeps memory bounded.
        async with self._lock:
            out = await asyncio.to_thread(synth)
        await ctx.progress(1.0)
        return out

    def _decode(self, path: Path, sample_rate: int) -> np.ndarray:
        """Narration as mono float32 at the model's own rate, via ffmpeg.

        Handed a path, faster-whisper decodes it through PyAV, whose wheel
        bundles a full FFmpeg build - libx264 and libx265 among it. Handed an
        array it decodes nothing. Shelling out is what upstream's own docstring
        points at for this, and it is the same binary the rest of the engine
        already assembles video with.

        `sample_rate` is the model's, not a constant: faster-whisper divides
        `len(audio)` by its feature extractor's rate to place every word, and
        does that whether or not it did the decoding. A rate written here
        instead would scale every caption timestamp by the ratio the day the
        two disagreed, with a well-formed SRT and no error to show for it.
        """
        try:
            out = subprocess.run(
                [
                    self.ffmpeg_bin,
                    "-nostdin",
                    "-hide_banner",
                    # Leaves the failure alone on stderr, which is what the
                    # tail below reports. The banner, the stream dump and the
                    # `\r`-terminated progress line are all lines to
                    # `splitlines()`, and the progress line is the *last* of
                    # them once a run has produced any output - so the message
                    # would be a byte count rather than a reason.
                    "-v",
                    "error",
                    "-threads",
                    "0",
                    "-i",
                    str(path),
                    "-f",
                    "s16le",
                    "-ac",
                    "1",
                    "-acodec",
                    "pcm_s16le",
                    "-ar",
                    str(sample_rate),
                    "-",
                ],
                capture_output=True,
                check=False,
                timeout=_DECODE_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as exc:
            # Raised after the child has been killed and reaped, so nothing is
            # left running behind the failure.
            raise GenerationError(
                "could not decode narration for alignment: ffmpeg did not finish within "
                f"{_DECODE_TIMEOUT_S:.0f}s"
            ) from exc
        except OSError as exc:
            # `check=False` covers a non-zero exit, not a binary that is not
            # there: the exec itself fails and raises before there is a
            # returncode to look at.
            raise GenerationError(
                f"could not decode narration for alignment: {self.ffmpeg_bin} could not be run "
                "- install ffmpeg or set LOCALCUT_FFMPEG_BIN"
            ) from exc
        if out.returncode != 0:
            detail = out.stderr.decode("utf-8", "replace").strip().splitlines()
            raise GenerationError(
                f"could not decode narration for alignment: {detail[-1] if detail else 'ffmpeg failed'}"
            )
        if not out.stdout or len(out.stdout) % 2:
            # A zero-exit decode that yielded no whole samples: an input whose
            # audio stream is empty, or output cut mid-sample. Left to run,
            # `transcribe` finds nothing in it and the job publishes an SRT
            # with that scene missing, reports success, and caches the answer
            # under the output hash forever.
            raise GenerationError(
                "could not decode narration for alignment: ffmpeg produced "
                f"{len(out.stdout)} bytes, which is not a whole 16-bit sample stream"
            )
        # s16 -> f32 on the same scale faster-whisper's own decoder uses.
        return np.frombuffer(out.stdout, np.int16).astype(np.float32) / 32768.0

    def _align_one(self, path: Path, offset: float) -> list[Word]:
        model = self._load()
        segments, _ = model.transcribe(
            self._decode(path, model.feature_extractor.sampling_rate),
            language="en",
            beam_size=1,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=False,
        )
        words: list[Word] = []
        for segment in segments:
            for word in segment.words or []:
                words.append(
                    Word(
                        text=word.word.strip(),
                        start=offset + word.start,
                        end=offset + word.end,
                    )
                )
        return words
