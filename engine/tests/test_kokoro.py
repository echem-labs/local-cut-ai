"""Kokoro TTS backend: error path always; real synthesis only where the
model files are present (dev machines / self-hosted CI)."""

import os
import shutil

import pytest
from conftest import make_spec

from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.backends.kokoro import (
    KokoroBackend,
    describe_voice,
    language_of,
)
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
    with pytest.raises(GenerationError, match="localcut download"):
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


# --- Voice enumeration -------------------------------------------------
#
# The pack has always held fifty-four voices and the product offered five,
# because the five were written into a keyword table and nothing asked the
# pack what it contained. These cover the reading of it, and the language
# each voice's text has to be phonemized in — which was hardcoded to
# American English for every one of them, British voices included.


@pytest.mark.parametrize(
    ("voice_id", "code", "gender", "name"),
    [
        ("af_sarah", "en-us", "female", "Sarah"),
        ("am_onyx", "en-us", "male", "Onyx"),
        ("bf_emma", "en-gb", "female", "Emma"),
        ("bm_george", "en-gb", "male", "George"),
        ("jf_alpha", "ja", "female", "Alpha"),
        ("zm_yunxi", "cmn", "male", "Yunxi"),
    ],
)
def test_a_voice_id_describes_itself(voice_id, code, gender, name):
    described = describe_voice(voice_id)
    assert described == {
        "id": voice_id,
        "name": name,
        "language_code": code,
        "gender": gender,
    }


@pytest.mark.parametrize("voice_id", ["custom-voice", "jenny", "podcast", "af", "a", ""])
def test_an_unconventional_id_is_reported_unknown_rather_than_guessed(voice_id):
    """A pack that adds a voice outside the naming scheme must not be
    silently filed under whatever its first letter happens to collide with.

    `jenny` and `podcast` are the ones that bite: `j` and `p` are both real
    prefixes, so a first-letter lookup calls them Japanese and Portuguese
    and phonemizes English text accordingly. Checking the whole
    `<language><gender>_` shape is what makes the claim true; an id whose
    first letter is simply absent from the table would pass either way.
    """
    described = describe_voice(voice_id)
    # null, not a sentinel string: a picker labels it from its own catalog,
    # and no real espeak code can be mistaken for it.
    assert described["language_code"] is None
    assert described["gender"] is None
    assert described["id"] == voice_id
    # The id is shown as it is rather than reshaped into a name.
    assert described["name"] == voice_id
    # Whatever it is, it is still read as English rather than as the
    # language its first letter collides with.
    assert language_of(voice_id) == "en-us"


def test_british_voices_are_phonemized_as_british():
    """The whole point of carrying a language per voice: every voice was
    synthesized with American phonemes while this was a constant."""
    assert language_of("bf_emma") == "en-gb"
    assert language_of("bm_daniel") == "en-gb"
    assert language_of("af_sarah") == "en-us"


@pytest.mark.parametrize("voice_id", ["jf_alpha", "zm_yunxi", "ff_siwis", "hf_alpha", "ef_dora"])
def test_a_non_english_voice_still_reads_english_text_as_english(voice_id):
    """The narration text is always English, and espeak's `lang` describes
    the text, not the speaker.

    Asking it for Japanese spells the English out letter by letter
    ("ˈeɪtʃ ˈiː ˈɛl ˈɛl ˈəʊ" for "hello", ~4x the phonemes and so ~4x the
    clip); French, Hindi and Mandarin emit literal "(en)" switch markers
    whose characters are all in Kokoro's vocab, so they survive the filter
    and get spoken. The voice still reports its own language — that is what
    a picker groups by — but it cannot decide how English is read.
    """
    assert language_of(voice_id) == "en-us"
    assert describe_voice(voice_id)["language_code"] != "en-us"


def test_no_pack_on_disk_enumerates_nothing(tmp_path):
    """The picker's empty state, not an error: a machine that has not
    downloaded the weights is normal, and the caller renders 'none
    installed' from the same shape it renders a list from."""
    backend = KokoroBackend(models_dir=tmp_path)
    assert backend.installed_voices() == []


@pytest.mark.skipif(not KOKORO_PRESENT, reason="Kokoro weights not on this machine")
def test_the_installed_pack_is_read_rather_than_listed_in_source():
    voices = KokoroBackend(models_dir=MODELS_DIR).installed_voices()
    # The five the keyword table knows about are a strict subset of what the
    # pack holds; if these ever match, the enumeration has stopped reading.
    from localcut_engine.backends.kokoro import _VOICE_MAP

    ids = {voice["id"] for voice in voices}
    assert {voice for _, voice in _VOICE_MAP} < ids
    assert len(voices) > 20, f"only {len(voices)} voices read from the installed pack"
    # Every entry is usable by a picker without further lookup.
    for voice in voices:
        assert voice["id"] and voice["name"] and voice["language_code"]


async def test_the_voice_decides_the_language_synthesis_is_asked_for(tmp_path, monkeypatch):
    """Pins `lang` at the call site, not just in the helper.

    `language_of` had tests of its own while `create()` was still reached
    with a constant, so reverting the one line that carries it left the
    suite green — the bug this change exists to fix could come back
    untouched. Driving `execute()` with a stand-in engine is what closes
    that: it asserts what Kokoro is actually asked for.
    """
    import numpy as np

    calls = []

    class FakeEngine:
        def create(self, text, voice, speed, lang):
            calls.append({"text": text, "voice": voice, "speed": speed, "lang": lang})
            return np.zeros(2400, dtype="float32"), 24000

    backend = KokoroBackend(models_dir=tmp_path)
    monkeypatch.setattr(backend, "_load", lambda: FakeEngine())
    ctx = ExecutionContext(output_dir=tmp_path)

    for voice_id, expected in [
        ("bf_emma", "en-gb"),
        ("af_sarah", "en-us"),
        # A Japanese voice reading an English script is still read as
        # English; asking espeak for `ja` spells the letters out loud.
        ("jf_alpha", "en-us"),
    ]:
        calls.clear()
        spec = make_spec(
            NodeKind.NARRATION,
            {"text": "hello there", "voice_id": voice_id},
            node_id="s1.narration",
            output_hash=voice_id.ljust(64, "0"),
        )
        await backend.execute(spec, ctx)
        assert calls == [
            {"text": "hello there", "voice": voice_id, "speed": 1.0, "lang": expected}
        ], f"{voice_id} was synthesized as {calls}"


def test_enumeration_does_not_build_an_inference_session(tmp_path, monkeypatch):
    """Reading 54 names must not construct the 325 MB ONNX session.

    Going through `_load()` cost ~1.1s and ~476 MB to answer a read-only
    listing, cached the session for the life of the process, held the
    voices archive open against a later re-download, and — `_lock` being an
    asyncio lock a worker thread cannot take — raced a narration job into
    building a second session. The names are keys in the voices archive.
    """
    backend = KokoroBackend(models_dir=tmp_path)

    def explode():
        raise AssertionError("installed_voices must not load the inference session")

    monkeypatch.setattr(backend, "_load", explode)
    assert backend.installed_voices() == []
    assert backend._engine is None

    if KOKORO_PRESENT:
        real = KokoroBackend(models_dir=MODELS_DIR)
        monkeypatch.setattr(real, "_load", explode)
        assert len(real.installed_voices()) > 20
        assert real._engine is None


async def test_an_unknown_voice_fails_with_a_reason_not_an_assertion(tmp_path, monkeypatch):
    """kokoro-onnx guards its voice lookup with a bare `assert`, which would
    reach the board as a stray AssertionError rather than this backend's
    error contract. Now that /voices publishes ids a client can send back,
    a stale one is an ordinary mistake and has to read like one."""
    backend = KokoroBackend(models_dir=tmp_path)
    monkeypatch.setattr(backend, "_installed_ids", lambda: {"af_sarah", "bf_emma"})
    spec = make_spec(
        NodeKind.NARRATION,
        {"text": "hello", "voice_id": "bf_isabella"},
        node_id="s1.narration",
        output_hash="c" * 64,
    )
    with pytest.raises(GenerationError, match="no voice 'bf_isabella'"):
        await backend.execute(spec, ExecutionContext(output_dir=tmp_path))


async def test_an_unreadable_pack_does_not_reject_every_voice(tmp_path, monkeypatch):
    """An empty id set means the pack could not be read, not that it holds
    no voices — rejecting on it would turn one unreadable file into "no
    voice you can name is valid" and mask the real fault."""
    calls = []

    class FakeEngine:
        def create(self, text, voice, speed, lang):
            calls.append(voice)
            import numpy as np

            return np.zeros(2400, dtype="float32"), 24000

    backend = KokoroBackend(models_dir=tmp_path)
    monkeypatch.setattr(backend, "_installed_ids", set)
    monkeypatch.setattr(backend, "_load", lambda: FakeEngine())
    spec = make_spec(
        NodeKind.NARRATION,
        {"text": "hello", "voice_id": "af_sarah"},
        node_id="s1.narration",
        output_hash="d" * 64,
    )
    await backend.execute(spec, ExecutionContext(output_dir=tmp_path))
    assert calls == ["af_sarah"]
