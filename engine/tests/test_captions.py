"""Caption assembly units (pure functions) and the alignment backend —
real synthesis+alignment only where the model files are present."""

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
