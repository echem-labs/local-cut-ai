"""Caption assembly units (pure functions) and the alignment backend —
real synthesis+alignment only where the model files are present."""

import pytest
from conftest import make_spec

from localcut_engine.backends.align import AlignBackend
from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.captions import (
    Cue,
    Word,
    cues_to_srt,
    parse_srt,
    srt_to_ass,
    words_to_cues,
)
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import NodeKind

MODELS_DIR = EngineConfig.from_env().resolved_models_dir
ALIGN_PRESENT = (MODELS_DIR / "asr" / "faster-whisper-base.en" / "model.bin").exists()
KOKORO_PRESENT = (MODELS_DIR / "tts" / "kokoro-v1.0.onnx").exists() and (
    MODELS_DIR / "tts" / "voices-v1.0.bin"
).exists()


def w(text: str, start: float, end: float) -> Word:
    return Word(text=text, start=start, end=end)


def test_cues_break_on_punctuation_and_word_count():
    words = [w(f"w{i}", i * 0.3, i * 0.3 + 0.25) for i in range(8)]
    words[2] = w("stop.", 0.6, 0.85)
    cues = words_to_cues(words)
    assert cues[0].text == "w0 w1 stop."  # sentence end breaks the cue
    assert all(len(c.text.split()) <= 5 for c in cues)


def test_cues_break_on_long_pause():
    words = [w("one", 0.0, 0.3), w("two", 2.0, 2.3)]  # 1.7s gap
    cues = words_to_cues(words)
    assert len(cues) == 2
    assert cues[1].start == 2.0


def test_srt_roundtrip():
    cues = [
        Cue(start=0.0, end=1.25, text="hello there"),
        Cue(start=61.5, end=63.0, text="minute two"),
    ]
    srt = cues_to_srt(cues)
    assert "00:00:00,000 --> 00:00:01,250" in srt
    assert "00:01:01,500 --> 00:01:03,000" in srt
    parsed = parse_srt(srt)
    assert [c.text for c in parsed] == ["hello there", "minute two"]
    assert parsed[1].start == pytest.approx(61.5)


def test_srt_to_ass_styles_and_escapes():
    srt = cues_to_srt([Cue(start=0.5, end=2.0, text="brace {test}")])
    ass = srt_to_ass(srt)
    assert "[V4+ Styles]" in ass and "Dialogue: 0,0:00:00.50,0:00:02.00" in ass
    assert "{" not in ass.split("[Events]")[1].split("Text\n")[1]  # override tags neutralized


async def test_missing_model_gives_actionable_error(tmp_path):
    backend = AlignBackend(models_dir=tmp_path)
    (tmp_path / "edl.json").write_text('{"video": []}')
    with pytest.raises(GenerationError, match="localcut-engine download"):
        await backend.execute(
            make_spec(NodeKind.CAPTIONS, output_hash="f" * 64),
            ExecutionContext(
                output_dir=tmp_path, input_artifacts={"default": tmp_path / "edl.json"}
            ),
        )


@pytest.mark.skipif(
    not (ALIGN_PRESENT and KOKORO_PRESENT),
    reason="alignment/tts model files not downloaded",
)
async def test_real_narration_aligns_to_timed_captions(tmp_path):
    """Kokoro speaks a known line; faster-whisper must return word-timed cues
    offset by the segment's EDL start."""
    import json

    from localcut_engine.backends.kokoro import KokoroBackend

    tts = KokoroBackend(models_dir=MODELS_DIR)
    wav = await tts.execute(
        make_spec(
            NodeKind.NARRATION,
            {
                "text": "Most animals have one heart. This creature has three.",
                "voice": "calm narrator",
            },
            output_hash="b" * 64,
        ),
        ExecutionContext(output_dir=tmp_path),
    )

    edl = {"video": [{"scene": "s1", "narration": wav.name, "start": 10.0, "duration": 5.0}]}
    edl_path = tmp_path / "e.timeline.json"
    edl_path.write_text(json.dumps(edl))

    backend = AlignBackend(models_dir=MODELS_DIR)
    out = await backend.execute(
        make_spec(NodeKind.CAPTIONS, output_hash="c" * 64),
        ExecutionContext(output_dir=tmp_path, input_artifacts={"default": edl_path}),
    )
    cues = parse_srt(out.read_text())
    assert cues, "alignment produced no cues"
    assert cues[0].start >= 10.0  # offset by the segment start
    joined = " ".join(c.text.lower() for c in cues)
    assert "heart" in joined and "three" in joined
