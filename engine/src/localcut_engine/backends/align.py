"""Forced-alignment backend (faster-whisper, CPU int8) — turns the timeline's
narration tracks into word-timed captions. Consumes the EDL's stored segment
starts so caption timing and export timing can never disagree.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ..captions import Word, cues_to_srt, words_to_cues
from ..graph.compiler import JobSpec
from ..graph.model import DEFAULT_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError

# Fallback when no manifest is available; normally the model dir comes from
# the faster-whisper-base-en manifest entry's file dests.
_DEFAULT_MODEL_DIR = "asr/faster-whisper-base.en"


class AlignBackend(ExecutionBackend):
    name = "align"

    def __init__(self, models_dir: Path, file_dests: list[str] | None = None) -> None:
        first = (file_dests or [f"{_DEFAULT_MODEL_DIR}/model.bin"])[0]
        self.model_dir = models_dir / Path(first).parent
        self._model = None
        self._lock = asyncio.Lock()

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.CAPTIONS

    def _load(self):
        if self._model is None:
            if not (self.model_dir / "model.bin").exists():
                raise GenerationError(
                    "alignment model missing — run: localcut-engine download faster-whisper-base-en"
                )
            from faster_whisper import WhisperModel

            self._model = WhisperModel(str(self.model_dir), device="cpu", compute_type="int8")
        return self._model

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        if not (self.model_dir / "model.bin").exists():
            raise GenerationError(
                "alignment model missing — run: localcut-engine download faster-whisper-base-en"
            )
        timeline_path = ctx.input_artifacts.get(DEFAULT_PORT)
        if timeline_path is None or not Path(timeline_path).exists():
            raise GenerationError("captions job is missing its timeline input")
        timeline = json.loads(Path(timeline_path).read_text())
        segments = timeline.get("video", [])

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
                words.extend(self._align_one(path, offset))
                progress = 0.9 * (index + 1) / total
                asyncio.run_coroutine_threadsafe(ctx.progress(progress), loop)
            out = ctx.output_path(spec.output_hash, ".srt")
            out.write_text(cues_to_srt(words_to_cues(words)))
            return out

        loop = asyncio.get_running_loop()
        # CPU inference is blocking; one at a time keeps memory bounded.
        async with self._lock:
            out = await asyncio.to_thread(synth)
        await ctx.progress(1.0)
        return out

    def _align_one(self, path: Path, offset: float) -> list[Word]:
        model = self._load()
        segments, _ = model.transcribe(
            str(path),
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
