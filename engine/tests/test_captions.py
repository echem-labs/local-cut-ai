"""Caption assembly units (pure functions) and the alignment backend —
real synthesis+alignment only where the model files are present."""

import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import make_spec

from localcut_engine.aspects import EXPORT_RESOLUTIONS
from localcut_engine.backends.align import AlignBackend
from localcut_engine.backends.base import ExecutionContext, GenerationError
from localcut_engine.backends.ffmpeg import FFmpegBackend
from localcut_engine.captions import (
    Cue,
    Word,
    anchor_words_to_text,
    cues_to_srt,
    parse_srt,
    srt_to_ass,
    words_to_cues,
)
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import CAPTIONS_PORT, NodeKind

MODELS_DIR = EngineConfig.from_env().resolved_models_dir
ALIGN_PRESENT = (MODELS_DIR / "asr" / "faster-whisper-base.en" / "model.bin").exists()
# Same resolution the assembly suite uses: the managed download this repo
# installs sits outside PATH on a dev box, so `shutil.which` alone reports it
# absent and every decode test below would pass through the branch that says
# ffmpeg is missing.
FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")
RTHOOK = Path(__file__).resolve().parents[1] / "packaging" / "rthook_av.py"
KOKORO_PRESENT = (MODELS_DIR / "tts" / "kokoro-v1.0.onnx").exists() and (
    MODELS_DIR / "tts" / "voices-v1.0.bin"
).exists()


def w(text: str, start: float, end: float) -> Word:
    return Word(text=text, start=start, end=end)


def test_anchor_fixes_homophones_and_keeps_timing():
    asr = [w("is", 0.0, 0.2), w("our", 0.2, 0.4), w("son.", 0.4, 0.7)]
    out = anchor_words_to_text(asr, "is our sun.")
    assert [word.text for word in out] == ["is", "our", "sun."]
    assert (out[2].start, out[2].end) == (0.4, 0.7)


def test_anchor_restores_script_punctuation_and_casing():
    asr = [w("the", 0.0, 0.1), w("sun", 0.1, 0.4), w("burns", 0.4, 0.8)]
    out = anchor_words_to_text(asr, "The Sun burns!")
    assert [word.text for word in out] == ["The", "Sun", "burns!"]


def test_anchor_drops_hallucinated_words_and_inserts_missed_ones():
    # ASR added "uh" and never heard "quietly".
    asr = [w("the", 0.0, 0.1), w("uh", 0.1, 0.2), w("tide", 0.2, 0.5), w("turns", 0.5, 0.9)]
    out = anchor_words_to_text(asr, "the tide turns quietly")
    assert [word.text for word in out] == ["the", "tide", "turns", "quietly"]
    # The trailing word has no transcribed time of its own, so it pins to the
    # preceding boundary; timing never runs backwards, and the cue it lands
    # in still gets real screen time.
    assert out[-1].start == out[-2].end
    assert all(b.start >= a.start for a, b in zip(out, out[1:]))
    cues = words_to_cues(out)
    assert "quietly" in " ".join(cue.text for cue in cues)
    assert all(cue.end > cue.start for cue in cues)


def test_anchor_inserted_sentence_still_renders_as_a_cue():
    # The missed words follow a sentence end, so they flush into their own
    # cue — which must have nonzero duration or SRT consumers drop it.
    asr = [w("stay", 0.0, 0.3), w("tuned.", 0.3, 0.7)]
    out = anchor_words_to_text(asr, "Stay tuned. More soon.")
    cues = words_to_cues(out)
    assert [cue.text for cue in cues] == ["Stay tuned.", "More soon."]
    assert all(cue.end > cue.start for cue in cues)


def test_anchor_keeps_non_latin_script_text():
    # Tokens that carry no [a-z0-9'] normalize to nothing. They must never
    # match each other by accident — the script still wins, spread over the
    # transcribed span, rather than the ASR's English guess surviving.
    asr = [w("shall", 0.0, 0.4), w("we", 0.4, 0.7), w("go", 0.7, 1.0)]
    out = anchor_words_to_text(asr, "今天 我们 出发 吧")
    assert [word.text for word in out] == ["今天", "我们", "出发", "吧"]
    assert out[0].start == 0.0 and out[-1].end == 1.0


def test_anchor_never_crosses_the_next_transcribed_word():
    # Mid-sequence inserts must stay inside the gap: time invented past a
    # real boundary would overlap the following cue on screen.
    asr = [w("One.", 0.0, 0.4), w("Two", 0.4, 0.8), w("three.", 0.8, 1.2)]
    out = anchor_words_to_text(asr, "One. A brand new inserted clause here. Two three.")
    assert [word.text for word in out] == (
        "One. A brand new inserted clause here. Two three.".split()
    )
    assert all(b.start >= a.start for a, b in zip(out, out[1:]))
    assert all(word.end >= word.start for word in out)
    cues = words_to_cues(out)
    # Cues must be ordered and non-overlapping, or burn-in stacks two lines.
    assert all(b.start >= a.end for a, b in zip(cues, cues[1:]))
    assert all(cue.end > cue.start for cue in cues)


def test_anchor_zero_width_asr_span_does_not_overlap_the_next_word():
    # faster-whisper occasionally emits a zero-width word; borrowing time for
    # the replacement must stop at the next word's start.
    asr = [w("sun", 0.0, 0.0), w("rises", 0.0, 0.5), w("east", 0.5, 1.0)]
    out = anchor_words_to_text(asr, "son rises east")
    assert [word.text for word in out] == ["son", "rises", "east"]
    assert all(b.start >= a.start for a, b in zip(out, out[1:]))
    assert out[0].end <= out[1].start


async def test_align_backend_uses_the_graph_texts(tmp_path, monkeypatch):
    """The plumbing the feature rides on: the captions node's `texts` param
    must reach the backend and be keyed by the EDL segment's scene. Mocked
    transcription so this runs without model weights."""
    import json

    backend = AlignBackend(models_dir=tmp_path)
    model_dir = backend.model_dir
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "model.bin").touch()
    narration = tmp_path / "s1.wav"
    narration.touch()
    monkeypatch.setattr(
        AlignBackend,
        "_align_one",
        lambda self, path, offset: [
            Word("our", offset + 0.0, offset + 0.3),
            Word("son.", offset + 0.3, offset + 0.8),
        ],
    )
    edl = {"video": [{"scene": "s1", "narration": narration.name, "start": 0.0, "duration": 2.0}]}
    edl_path = tmp_path / "e.timeline.json"
    edl_path.write_text(json.dumps(edl))

    out = await backend.execute(
        make_spec(NodeKind.CAPTIONS, {"texts": {"s1": "our sun."}}, output_hash="e" * 64),
        ExecutionContext(output_dir=tmp_path, input_artifacts={"default": edl_path}),
    )
    assert "our sun." in out.read_text()

    # No texts (legacy graph) → the transcription stands.
    plain = await backend.execute(
        make_spec(NodeKind.CAPTIONS, output_hash="f" * 64),
        ExecutionContext(output_dir=tmp_path, input_artifacts={"default": edl_path}),
    )
    assert "our son." in plain.read_text()


def test_anchor_without_truth_or_words_is_identity():
    asr = [w("hello", 0.0, 0.5)]
    assert anchor_words_to_text(asr, "") == asr
    assert anchor_words_to_text([], "hello") == []


def test_cues_break_on_punctuation_and_word_count():
    words = [w(f"w{i}", i * 0.3, i * 0.3 + 0.25) for i in range(8)]
    words[2] = w("stop.", 0.6, 0.85)
    cues = words_to_cues(words)
    assert cues[0].text == "w0 w1 stop."  # sentence end breaks the cue
    assert all(len(c.text.split()) <= 5 for c in cues)


def test_commas_do_not_strand_single_word_cues():
    """Anchoring restores the script's punctuation, which is far denser than
    what transcription emits — a break on every comma would flash one-word
    cues on screen. Weak punctuation breaks only once the cue has body."""
    words = [
        w("The", 0.0, 0.2),
        w("star", 0.2, 0.5),
        w("of", 0.5, 0.6),
        w("the", 0.6, 0.7),
        w("show", 0.7, 1.0),
        w("is,", 1.0, 1.2),
        w("of", 1.2, 1.4),
        w("course,", 1.4, 1.8),
        w("our", 1.8, 2.0),
        w("Sun!", 2.0, 2.5),
    ]
    cues = words_to_cues(words)
    assert [cue.text for cue in cues] == [
        "The star of the show",
        "is, of course,",
        "our Sun!",
    ]
    # Strong punctuation still breaks immediately, however short the cue.
    assert words_to_cues([w("Stop.", 0.0, 0.3), w("Go", 0.3, 0.6)])[0].text == "Stop."


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
    ass = srt_to_ass(srt, *EXPORT_RESOLUTIONS["9:16"])
    assert "[V4+ Styles]" in ass and "Dialogue: 0,0:00:00.50,0:00:02.00" in ass
    assert "{" not in ass.split("[Events]")[1].split("Text\n")[1]  # override tags neutralized


def _ass_header_fields(ass: str) -> dict[str, str]:
    """PlayRes* plus the Default style, read back through the Format: line so
    the assertions do not depend on field order."""
    info = {}
    for line in ass.splitlines():
        if line.startswith("PlayRes"):
            key, value = line.split(":", 1)
            info[key.strip()] = value.strip()
    fmt = next(line for line in ass.splitlines() if line.startswith("Format: Name,"))
    keys = [k.strip() for k in fmt.split(":", 1)[1].split(",")]
    style = next(line for line in ass.splitlines() if line.startswith("Style:"))
    values = [v.strip() for v in style.split(":", 1)[1].split(",")]
    return {**info, **dict(zip(keys, values, strict=True))}


@pytest.mark.parametrize("aspect", sorted(EXPORT_RESOLUTIONS))
def test_ass_canvas_is_the_frame_it_burns_onto(aspect):
    """A caption style is only pixel-correct on the canvas it was authored
    for. The header used to hardcode 1080x1920, so on a 16:9 export libass
    rescaled the whole style by 1080/1920 — an 84px font burned in at 47px,
    covering 19% of frame width where 9:16 covered 61%."""
    width, height = EXPORT_RESOLUTIONS[aspect]
    fields = _ass_header_fields(srt_to_ass(cues_to_srt([Cue(0.0, 1.0, "hi")]), width, height))
    assert (int(fields["PlayResX"]), int(fields["PlayResY"])) == (width, height)


@pytest.mark.parametrize("aspect", sorted(EXPORT_RESOLUTIONS))
def test_ass_caption_size_and_placement_hold_across_aspects(aspect):
    """Same physical text size and same bottom-third placement whichever way
    the video is oriented: the font tracks the short side (turning a video on
    its side must not resize its captions), the margins track the axis they
    push away from."""
    width, height = EXPORT_RESOLUTIONS[aspect]
    fields = _ass_header_fields(srt_to_ass(cues_to_srt([Cue(0.0, 1.0, "hi")]), width, height))
    assert int(fields["Fontsize"]) / min(width, height) == pytest.approx(84 / 1080, abs=0.002)
    assert int(fields["MarginV"]) / height == pytest.approx(340 / 1920, abs=0.002)
    assert int(fields["MarginL"]) / width == pytest.approx(60 / 1080, abs=0.002)


def test_ass_9_16_style_is_unchanged():
    """The portrait style is the one validated on a real export; keep it
    byte-identical so fixing the other aspects cannot regress it."""
    ass = srt_to_ass(cues_to_srt([Cue(0.0, 1.0, "hi")]), *EXPORT_RESOLUTIONS["9:16"])
    assert "PlayResX: 1080\nPlayResY: 1920" in ass
    assert "Style: Default,Sans,84,&H00FFFFFF,&H00101014,&H80000000,-1,5,1,2,60,60,340" in ass


def test_burned_captions_use_the_frame_the_export_encodes(tmp_path):
    """The plumbing. The frame size is resolved from the *timeline's* aspect,
    and burn-in must use that same number rather than resolve the export
    node's `aspect` param a second time — a patched export aspect would
    otherwise caption for a canvas the video is not being encoded at."""
    srt = tmp_path / "captions.srt"
    srt.write_text(cues_to_srt([Cue(0.0, 1.0, "hi")]), encoding="utf-8")
    spec = make_spec(NodeKind.EXPORT, {"aspect": "9:16", "captions": "burn"})
    ctx = ExecutionContext(output_dir=tmp_path, input_artifacts={CAPTIONS_PORT: srt})
    ass = FFmpegBackend()._burnable_captions(spec, ctx, tmp_path, 1920, 1080)
    assert ass is not None
    assert "PlayResX: 1920\nPlayResY: 1080" in ass.read_text(encoding="utf-8")


async def test_missing_model_gives_actionable_error(tmp_path):
    backend = AlignBackend(models_dir=tmp_path)
    (tmp_path / "edl.json").write_text('{"video": []}')
    with pytest.raises(GenerationError, match="localcut download"):
        await backend.execute(
            make_spec(NodeKind.CAPTIONS, output_hash="f" * 64),
            ExecutionContext(
                output_dir=tmp_path, input_artifacts={"default": tmp_path / "edl.json"}
            ),
        )


@pytest.mark.skipif(
    not (ALIGN_PRESENT and KOKORO_PRESENT and FFMPEG),
    reason="alignment/tts model files not downloaded, or no ffmpeg",
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

    backend = AlignBackend(models_dir=MODELS_DIR, ffmpeg_bin=FFMPEG)
    out = await backend.execute(
        make_spec(NodeKind.CAPTIONS, output_hash="c" * 64),
        ExecutionContext(output_dir=tmp_path, input_artifacts={"default": edl_path}),
    )
    cues = parse_srt(out.read_text())
    assert cues, "alignment produced no cues"
    assert cues[0].start >= 10.0  # offset by the segment start
    joined = " ".join(c.text.lower() for c in cues)
    assert "heart" in joined and "three" in joined


def test_head_words_the_asr_dropped_get_the_room_behind_them():
    """When the transcription misses a run of words at the START of a scene,
    they have no room ahead of the first transcribed word — and collapsing
    them onto one instant folds the whole line into a single unreadable
    flash. The audio was synthesized from the script, so those words WERE
    spoken: lay them into the scene's own head, never past its start."""
    from localcut_engine.captions import MIN_CUE_S, Word, anchor_words_to_text, words_to_cues

    script = "Today we take a very close look at solar flares"
    words = anchor_words_to_text([Word("flares", 1.0, 1.5)], script, floor=0.0)
    cues = words_to_cues(words)

    assert len(cues) > 1, "ten words were folded into one cue"
    assert all(cue.end > cue.start for cue in cues)
    assert all(b.start >= a.end for a, b in zip(cues, cues[1:]))
    # Every script word still appears, in order, and none is on screen for
    # less than the readable floor.
    assert " ".join(cue.text for cue in cues) == script
    assert all(cue.end - cue.start >= MIN_CUE_S - 1e-9 for cue in cues)


def test_head_insert_never_spreads_back_past_the_scene_start():
    """The floor is the previous scene's captions: crossing it stacks two
    lines on screen."""
    from localcut_engine.captions import Word, anchor_words_to_text

    words = anchor_words_to_text(
        [Word("flares", 1.0, 1.5)], "a very close look at solar flares", floor=0.8
    )
    assert words[0].start >= 0.8
    assert all(w.start >= 0.8 for w in words)


def test_no_floor_keeps_the_conservative_behaviour():
    """A caller that cannot name a scene start gets no invented time, rather
    than time borrowed from whatever came before."""
    from localcut_engine.captions import Word, anchor_words_to_text

    words = anchor_words_to_text([Word("flares", 1.0, 1.5)], "at solar flares")
    assert all(w.start >= 1.0 for w in words)


def test_alignment_hands_the_model_samples_rather_than_a_path(tmp_path, monkeypatch):
    """Whose decoder reads the narration, asserted where it is decided.

    Handed a path, faster-whisper decodes it through PyAV — whose wheel bundles
    a full FFmpeg build, libx264 and libx265 among it, for a code path this
    engine has no other use for. Handed samples it decodes nothing, which is
    what lets the freeze leave PyAV out entirely. A path reaching `transcribe`
    puts 100 MB and two GPL video encoders back in the installer, and nothing
    else in the suite would notice.
    """
    import numpy as np

    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin="ffmpeg")
    seen: dict = {}

    class _Model:
        feature_extractor = SimpleNamespace(sampling_rate=16000)

        def transcribe(self, audio, **kwargs):
            seen["audio"] = audio
            return [], None

    monkeypatch.setattr(AlignBackend, "_load", lambda self: _Model())
    monkeypatch.setattr(
        AlignBackend, "_decode", lambda self, path, rate: np.zeros(rate, dtype=np.float32)
    )
    backend._align_one(tmp_path / "narration.wav", 0.0)

    assert isinstance(seen["audio"], np.ndarray), (
        "transcribe was handed something other than samples - PyAV decodes it"
    )
    assert seen["audio"].dtype == np.float32


def test_the_decode_rate_is_the_model_s_own(tmp_path, monkeypatch):
    """faster-whisper divides the sample count by its feature extractor's rate
    to place every word, and does that whether or not it decoded the audio.

    So a rate written down beside the decode rather than read from the model
    is a value written twice across a boundary nothing reconciles: let the two
    disagree and every caption timestamp is scaled by the ratio, in a
    well-formed SRT with nothing on its face to say the timings are wrong.
    """
    import numpy as np

    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin="ffmpeg")
    asked: dict = {}

    class _Model:
        # Deliberately not 16 kHz: a decode that ignores the model answers
        # this test correctly by accident.
        feature_extractor = SimpleNamespace(sampling_rate=8000)

        def transcribe(self, audio, **kwargs):
            return [], None

    def _decode(self, path, rate):
        asked["rate"] = rate
        return np.zeros(rate, dtype=np.float32)

    monkeypatch.setattr(AlignBackend, "_load", lambda self: _Model())
    monkeypatch.setattr(AlignBackend, "_decode", _decode)
    backend._align_one(tmp_path / "narration.wav", 0.0)

    assert asked["rate"] == 8000, "narration is decoded at a rate the model does not use"


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")
def test_a_narration_file_ffmpeg_cannot_read_is_a_generation_error(tmp_path):
    """Decoding is a subprocess, so its failure has to be translated at the
    boundary or it reaches the board as an unhandled crash rather than as a job
    that failed with a reason.

    Gated on ffmpeg, and asserted against the other branch's wording: without a
    binary this takes the "could not be run" path the next test covers, and
    reports the exit-status path as covered without ever entering it.
    """
    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin=FFMPEG)
    not_audio = tmp_path / "narration.wav"
    not_audio.write_text("this is not a wav file")

    with pytest.raises(GenerationError, match="could not decode narration") as raised:
        backend._decode(not_audio, 16000)
    assert "could not be run" not in str(raised.value), (
        "ffmpeg never ran, so this is not the exit-status branch it claims to cover"
    )


def test_a_missing_ffmpeg_is_a_generation_error_too(tmp_path):
    """The other way the subprocess does not run. `ffmpeg` is resolved from
    config and can be absent on a machine that never downloaded it."""
    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin="ffmpeg-that-is-not-installed")

    with pytest.raises(GenerationError, match="could not be run"):
        backend._decode(tmp_path / "narration.wav", 16000)


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")
def test_a_decode_that_yields_no_samples_fails_rather_than_captioning_nothing(tmp_path):
    """ffmpeg exits 0 having written nothing for an input whose audio stream
    holds no samples. Passed on, `transcribe` finds no words in it, the job
    publishes an SRT with that scene simply missing and reports success, and
    the empty answer is cached under the output hash for good - the one
    failure mode a captions job has no way to show the reader."""
    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin=FFMPEG)
    empty = tmp_path / "narration.wav"
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            "0",
            "-c:a",
            "pcm_s16le",
            str(empty),
        ],
        check=True,
    )

    with pytest.raises(GenerationError, match="not a whole 16-bit sample stream"):
        backend._decode(empty, 16000)


def test_alignment_claims_captions_only_where_it_can_decode_them(tmp_path):
    """The aligner reads narration through the ffmpeg binary, so weights alone
    are not enough to serve the kind.

    Claiming it without one is worse than not claiming it: the chain's
    fallback is never consulted and the readiness report says `ready` for a
    kind whose every job dies at decode. `FFmpegBackend.supports` gates the
    same binary for the same reason.
    """
    (tmp_path / "asr" / "faster-whisper-base.en").mkdir(parents=True)
    (tmp_path / "asr" / "faster-whisper-base.en" / "model.bin").touch()

    assert AlignBackend(models_dir=tmp_path, ffmpeg_bin=FFMPEG or "ffmpeg").supports(
        NodeKind.CAPTIONS
    ) is (FFMPEG is not None)
    assert not AlignBackend(
        models_dir=tmp_path, ffmpeg_bin=str(tmp_path / "missing" / "ffmpeg")
    ).supports(NodeKind.CAPTIONS)


@pytest.mark.skipif(not ALIGN_PRESENT, reason="alignment model files not downloaded")
def test_alignment_still_works_with_pyav_unimportable(tmp_path):
    """The condition the freeze actually ships, reproduced in a subprocess.

    `localcut.spec` excludes `av` and a runtime hook puts a raising stub in
    `sys.modules` under that name, because faster-whisper imports PyAV at
    module scope and would otherwise fail outright. Nothing else here can
    check that: this venv has the real PyAV installed, so every other test
    passes whether or not the engine actually depends on it.

    So: block the real package at the finder, run the shipped hook, and
    transcribe. If this passes, the frozen engine transcribes without the
    100 MB of GPL-carrying FFmpeg that wheel brings.

    The hook file is read and executed rather than retyped here: a second
    stub written out inline is a copy of the thing under test, and no change
    to the one that actually ships could make this go red.
    """
    import sys
    import textwrap

    script = textwrap.dedent(f"""
        import sys, importlib.abc
        import numpy as np

        class Blocked(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                if name == "av" or name.startswith("av."):
                    raise ImportError("PyAV is not present in the freeze")
                return None

        sys.meta_path.insert(0, Blocked())
        source = open({str(RTHOOK)!r}, encoding="utf-8").read()
        exec(compile(source, "rthook_av.py", "exec"), {{}})
        assert "av" in sys.modules, "the hook registered nothing under the name"

        from faster_whisper import WhisperModel
        model = WhisperModel({str(MODELS_DIR / "asr" / "faster-whisper-base.en")!r},
                             device="cpu", compute_type="int8")
        # Silence is enough: the model must run, not recognise anything.
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32),
                                       language="en", beam_size=1,
                                       word_timestamps=True, vad_filter=False)
        list(segments)
        print("OK")
    """)
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, cwd=tmp_path, timeout=300
    )
    assert done.returncode == 0, f"transcription needs PyAV after all:\n{done.stderr[-2000:]}"
    assert "OK" in done.stdout


def test_faster_whisper_imports_with_pyav_absent(tmp_path):
    """The half of the claim above that needs no model weights.

    CI downloads none, so the transcription test skips there and the freeze's
    load-bearing assumption - that `import faster_whisper` survives PyAV being
    excluded - is gated on a machine nobody runs. This part is unskippable:
    block the real package, run the shipped hook, import the library.
    """
    import sys
    import textwrap

    script = textwrap.dedent(f"""
        import sys, importlib.abc

        class Blocked(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                if name == "av" or name.startswith("av."):
                    raise ImportError("PyAV is not present in the freeze")
                return None

        sys.meta_path.insert(0, Blocked())
        exec(compile(open({str(RTHOOK)!r}, encoding="utf-8").read(), "rthook_av.py", "exec"), {{}})
        import faster_whisper
        # The stub stands where a module stands: refusing a `hasattr` or a
        # `repr` puts this message on an unrelated traceback somewhere else
        # entirely, because `inspect` and `pickle` walk all of sys.modules.
        assert repr(sys.modules["av"]) == "<module 'av'>"
        assert getattr(sys.modules["av"], "__file__", None) is None
        print("OK")
    """)
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, cwd=tmp_path, timeout=120
    )
    assert done.returncode == 0, (
        f"faster-whisper cannot import without PyAV:\n{done.stderr[-2000:]}"
    )
    assert "OK" in done.stdout


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")
def test_a_real_decode_returns_the_scale_and_the_rate_it_was_asked_for(tmp_path):
    """The one path nothing else here runs.

    Both failure branches are covered above and the round trip is not: the
    only success path is inside `test_real_narration_aligns_to_timed_captions`,
    which needs model weights CI does not download. So `-ar`, `-f s16le` and
    the `/ 32768.0` that turns them back into faster-whisper's own scale are
    three values a change could silently move - into captions that are still
    well-formed and timed against the wrong clock.

    Written here rather than synthesised by ffmpeg, because the assertion is
    about amplitude and `sine` emits at -18 dBFS - which passes whether or not
    the conversion scales at all.
    """
    import wave

    import numpy as np

    backend = AlignBackend(models_dir=tmp_path, ffmpeg_bin=FFMPEG)
    full_scale = tmp_path / "narration.wav"
    with wave.open(str(full_scale), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        # Alternating peaks: a square wave at the Nyquist limit, so every
        # sample sits at an end of the 16-bit range.
        handle.writeframes(np.tile(np.array([32767, -32768], np.int16), 16000).tobytes())

    samples = backend._decode(full_scale, 16000)
    assert samples.dtype == np.float32
    assert samples.shape == (32000,), "the decode did not honour the rate it was given"
    # s16 handed on unscaled would come back around 32767 instead.
    assert 0.99 < float(np.abs(samples).max()) <= 1.0

    assert backend._decode(full_scale, 8000).shape == (16000,), "the rate is not reaching ffmpeg"
