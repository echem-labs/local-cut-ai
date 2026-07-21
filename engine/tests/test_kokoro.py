"""Kokoro TTS backend: error path always; real synthesis only where the
model files are present (dev machines / self-hosted CI)."""

import os
import shutil

import pytest
from conftest import make_spec

from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.backends.kokoro import KokoroBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind

MODELS_DIR = EngineConfig.from_env().resolved_models_dir
KOKORO_PRESENT = (MODELS_DIR / "tts" / "kokoro-v1.0.onnx").exists() and (
    MODELS_DIR / "tts" / "voices-v1.0.bin"
).exists()


def narration_spec(text: str) -> JobSpec:
    return make_spec(
        NodeKind.NARRATION,
        {"text": text, "voice": "energetic narrator"},
        node_id="s1.narration",
        output_hash="b" * 64,
    )


async def test_missing_model_files_give_actionable_error(tmp_path):
    backend = KokoroBackend(models_dir=tmp_path)
    with pytest.raises(GenerationError, match="localcut-engine download"):
        await backend.execute(narration_spec("hello"), ExecutionContext(output_dir=tmp_path))


async def test_empty_text_rejected(tmp_path):
    backend = KokoroBackend(models_dir=tmp_path)
    with pytest.raises(GenerationError, match="no text"):
        await backend.execute(narration_spec("   "), ExecutionContext(output_dir=tmp_path))


@pytest.mark.skipif(not KOKORO_PRESENT, reason="kokoro model files not downloaded")
async def test_real_synthesis_produces_playable_wav(tmp_path):
    backend = KokoroBackend(models_dir=MODELS_DIR)
    out = await backend.execute(
        narration_spec("Most animals have one heart. This creature has three."),
        ExecutionContext(output_dir=tmp_path),
    )
    assert out.suffix == ".wav" and out.stat().st_size > 10_000
    ffmpeg = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")
    if ffmpeg:
        duration = await FFmpegBackend(ffmpeg_bin=ffmpeg)._probe_duration(out)
        assert duration is not None
        assert 1.0 < duration < 15.0  # sane spoken length for one sentence


def test_clone_routing_never_lands_on_stock_voices(tmp_path):
    """`local:chatterbox` narration resolves to the cloning backend when the
    chain has one, and fails loudly — never Kokoro — when it doesn't."""
    import pytest

    from localcut_engine.backends.base import BackendRegistry, GenerationError
    from localcut_engine.backends.chatterbox import CLONE_MODEL, ChatterboxBackend
    from localcut_engine.backends.kokoro import KokoroBackend
    from localcut_engine.graph.model import NodeKind

    kokoro = KokoroBackend(models_dir=tmp_path)
    for path in (kokoro.model_path, kokoro.voices_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()  # supports() is weights-gated

    registry = BackendRegistry()
    registry.register(ChatterboxBackend(models_dir=tmp_path))
    registry.register(kokoro)
    assert registry.resolve(NodeKind.NARRATION, CLONE_MODEL).name == "chatterbox"
    assert registry.resolve(NodeKind.NARRATION).name == "kokoro"
    assert registry.resolve(NodeKind.NARRATION, "local:kokoro-82m").name == "kokoro"

    bare = BackendRegistry()
    bare.register(kokoro)
    with pytest.raises(GenerationError, match="chatterbox"):
        bare.resolve(NodeKind.NARRATION, CLONE_MODEL)


async def test_chatterbox_requires_sample_and_reports_missing_package(tmp_path):
    import pytest
    from conftest import make_spec

    from localcut_engine.backends.base import ExecutionContext, GenerationError
    from localcut_engine.backends.chatterbox import ChatterboxBackend
    from localcut_engine.graph.model import NodeKind

    backend = ChatterboxBackend(models_dir=tmp_path)
    ctx = ExecutionContext(output_dir=tmp_path)
    with pytest.raises(GenerationError, match="voice sample"):
        await backend.execute(make_spec(NodeKind.NARRATION, {"text": "hi"}), ctx)

    sample = tmp_path / "sample.wav"
    sample.write_bytes(b"RIFF")
    ctx = ExecutionContext(output_dir=tmp_path, input_artifacts={"voice_ref": sample})
    # chatterbox-tts is not installable on this Python yet — the failure must
    # name the fix, not explode as an ImportError.
    with pytest.raises(GenerationError, match="chatterbox-tts"):
        await backend.execute(make_spec(NodeKind.NARRATION, {"text": "hi"}), ctx)
