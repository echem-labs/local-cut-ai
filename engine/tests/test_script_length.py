"""The screenplay's narration budget.

`backends/ffmpeg.py` is the timing authority: narration duration drives scene
duration, so a video is exactly as long as its narration takes to speak.
Nothing used to connect that to `target_duration_s` — the script model was
asked for a 60s video, wrote 97 words of one-line couplets, and the project
assembled to 27.9s with no signal anywhere that the target had been missed.
"""

import pytest

from localcut_engine.backends.llm import (
    LENGTH_CEILING,
    LENGTH_FLOOR,
    LETTERS_PER_WORD,
    SPEECH_LETTERS_PER_S,
    _SYSTEM_PROMPT,
    estimated_runtime_s,
    narration_word_budget,
    screenplay_within_target,
    script_prompt,
)
from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.ffmpeg import NARRATION_PAD_S
from localcut_engine.schema import Scene, SceneStyle, Screenplay


def screenplay(words_per_scene: int, scenes: int = 9) -> Screenplay:
    return Screenplay(
        title="t",
        scenes=[
            Scene(
                id=f"s{i + 1}",
                duration_s=6.0,
                narration=" ".join(["word"] * words_per_scene),
                visual="a hill",
            )
            for i in range(scenes)
        ],
    )


def test_word_budget_scales_with_the_target():
    assert narration_word_budget(60) == pytest.approx(
        60 * SPEECH_LETTERS_PER_S / LETTERS_PER_WORD, abs=1
    )
    assert narration_word_budget(30) < narration_word_budget(60) < narration_word_budget(120)
    # A floor, not a zero: the budget reaches a prompt as "about N words".
    assert narration_word_budget(5) >= 1


# Two scripts of very different word length, each synthesized by Kokoro
# (af_sarah, speed 1.0) one line at a time, the way a narration node is.
# The couplets are the kind of text llama3.2 wrote for the first cut this
# estimate was checked against (97 words, 27.9s). The explainer is what
# qwen3:8b wrote for a 60s target; those three lines are a real cut, whose
# narration measured 20.69 + 22.38 + 18.16s and which assembled to 62.28s.
_COUPLETS = [
    "A little cloud went out to play. It drifted up and far away.",
    "It met a bird who said hello. They flew together, nice and slow.",
    "The sun came out and made it glow. The wind began to push and blow.",
    "The cloud got big and dark and round. It rained a bit upon the ground.",
    "The flowers drank and grew so tall. The cloud was happy after all.",
    "Then night came down with stars so bright. The little cloud said soft good night.",
    "It dreamed of rain and wind and sun. Tomorrow there is much more fun.",
]
_EXPLAINER = [
    "Honeybees use a mesmerizing waggle dance to communicate flower locations to their "
    "hive. When foragers return, they perform this intricate dance on the hive’s "
    "surface, vibrating their bodies to create a rhythmic signal. This dance isn’t just "
    "movement—it’s a precise language that encodes critical information about the "
    "flowers’ direction and distance.",
    "The dance’s direction reveals the flower’s orientation relative to the sun. Bees "
    "tilt their bodies during the waggle run, signaling the angle needed to reach the "
    "bloom. The longer the waggle, the farther the flowers—this duration encodes "
    "distance in seconds. Meanwhile, the hive’s scout bees decode this information, "
    "adjusting their flight paths to match the dance’s instructions.",
    "This dance is a masterpiece of evolution, allowing bees to share complex information "
    "without words. By decoding the waggle dance, colonies thrive, finding the most "
    "abundant flowers and ensuring survival. Next time you see bees buzzing, "
    "remember—they’re sharing a secret map, one dance at a time.",
]


def _scenes_saying(lines: list[str]) -> Screenplay:
    return Screenplay(
        title="t",
        scenes=[
            Scene(id=f"s{i}", duration_s=6.0, narration=line, visual="a hill")
            for i, line in enumerate(lines, 1)
        ],
    )


# What qwen3:8b wrote for a 20s target on a real Ubuntu first run, after one
# re-ask: 38 words that made a 13.9s video. Kokoro, through the engine, reads its
# two lines in 5.33 and 7.81s.
_TWENTY_SECONDS_SHORT = [
    "Honeybees use a unique dance to communicate the location of flowers to their hive mates.",
    "The waggle dance is a precise signal that tells the direction and distance of the "
    "flowers, ensuring the hive can find food efficiently.",
]


@pytest.mark.parametrize(
    "lines, measured_s",
    [
        # Synthesized speech plus the 0.35s pad after each line.
        pytest.param(_COUPLETS, 27.6 + 7 * 0.35, id="short-words"),
        pytest.param(_EXPLAINER, 62.28, id="long-words"),
        pytest.param(_TWENTY_SECONDS_SHORT, 5.33 + 7.81 + 2 * 0.35, id="twenty-second-target"),
    ],
)
def test_the_estimate_holds_for_short_words_and_long_ones(lines, measured_s):
    """The same voice read the couplets at 3.5 words a second and the
    explainer at 2.5, so no words-per-second rate gets both: 3.5 put the
    explainer's real 62s cut at 45s, and the script model was re-asked to
    lengthen a draft that was already on target. Per letter, the two read
    at 13.4 and 13.7 a second and the 20s draft at 14.0. Within a twentieth,
    because a rate under all three measures every draft long. A draft the
    length check takes as on target then speaks short."""
    assert estimated_runtime_s(_scenes_saying(lines)) == pytest.approx(measured_s, rel=0.05)


def test_runtime_estimate_counts_padding_per_scene():
    """Each scene carries breathing room after its narration, so scene count
    changes the runtime even at identical word count."""
    assert estimated_runtime_s(screenplay(10, scenes=9)) > estimated_runtime_s(
        screenplay(90, scenes=1)
    )


def test_script_prompt_states_the_budget_and_what_sets_the_length():
    prompt = script_prompt({"prompt": "a kids poem", "target_duration_s": 60})
    assert str(narration_word_budget(60)) in prompt
    # The mechanism, not just a number: a model told only "60s" writes short
    # couplets and pads duration_s, which nothing downstream reads.
    assert "narration" in prompt.lower()
    assert "duration_s" in prompt


def test_system_prompt_does_not_name_the_visual_field_a_prompt():
    """llama3.2 echoed this instruction into the data: every scene's `visual`
    came back as the literal string "image-generation prompt: <two words>",
    which reaches SDXL verbatim."""
    assert "image-generation prompt" not in _SYSTEM_PROMPT


def test_a_scene_is_written_as_one_continuous_shot():
    """Every scene renders as ONE keyframe image animated into ONE clip, so an
    editing technique written into a scene is drawn literally. qwen3:8b wrote
    the visual "A split-screen showing the dance's angle and duration, with
    animated bees flying toward flowers" and the motion "Cut between the dance
    and bees navigating through a field of flowers"; SDXL drew a three-panel
    collage and LTX animated it."""
    assert "ONE continuous shot" in _SYSTEM_PROMPT
    for technique in ("split screen", "collage", "montage", "picture-in-picture", "never a cut"):
        assert technique in _SYSTEM_PROMPT
    # Words meant for the screen have a field of their own, burned in at
    # assembly, instead of being lettered into the picture by the image model.
    assert 'go in "onscreen_text"' in _SYSTEM_PROMPT
    # And the rule is asked for as what to draw, not what to avoid: a model
    # that copies "no split screen" into `visual` hands SDXL the words.
    assert "only what is in the frame" in _SYSTEM_PROMPT


async def test_a_screenplay_that_hits_the_target_is_asked_once():
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=23).model_dump_json()

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert len(asked) == 1
    assert estimated_runtime_s(out) >= 60 * LENGTH_FLOOR


def test_the_ask_gives_a_range_with_a_ceiling():
    """ "About N words" read as a floor: asked for 70 words for a 20s video,
    qwen3:8b wrote 88, 105 and 108, and those cut to 33, 37 and 42s."""
    prompt = script_prompt({"prompt": "p", "target_duration_s": 20})
    low, high = narration_word_budget(20 * 0.9), narration_word_budget(20 * 1.1)
    assert f"between {low} and {high} words" in prompt


async def test_a_short_screenplay_is_re_asked_with_the_shortfall():
    attempts = [
        screenplay(words_per_scene=11).model_dump_json(),  # ~34s
        screenplay(words_per_scene=23).model_dump_json(),  # ~67s
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return attempts[len(asked) - 1]

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert len(asked) == 2
    assert estimated_runtime_s(out) >= 60 * LENGTH_FLOOR
    # The re-ask has to carry the measurement, or it is the same blind
    # instruction that produced the short draft in the first place.
    assert "99" in asked[1]  # words it actually wrote
    assert "too short" in asked[1]
    assert str(narration_word_budget(60)) in asked[1]


def _draft_lasting(seconds: float, scenes: int = 2) -> Screenplay:
    """A screenplay whose estimate is `seconds`, in five-letter words."""
    letters = round((seconds - NARRATION_PAD_S * scenes) * SPEECH_LETTERS_PER_S)
    words = max(1, letters // (5 * scenes))
    return _scenes_saying([" ".join(["abcde"] * words)] * scenes)


async def test_a_draft_a_quarter_short_is_re_asked_with_the_shortfall():
    """The 20s draft above, a quarter short, is asked again with what it
    measured."""
    replies = [
        _scenes_saying(_TWENTY_SECONDS_SHORT).model_dump_json(),
        _draft_lasting(20).model_dump_json(),
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return replies[len(asked) - 1]

    out = await screenplay_within_target({"target_duration_s": 20}, ask)
    assert len(asked) == 2
    assert "too short" in asked[1]
    assert "38 words" in asked[1]
    assert estimated_runtime_s(out) == pytest.approx(20, abs=1)


@pytest.mark.parametrize(
    "ratio, re_asked",
    [
        pytest.param(0.8, True, id="a-fifth-short"),
        pytest.param(1.2, True, id="a-fifth-long"),
        pytest.param(0.9, False, id="a-tenth-short"),
        pytest.param(1.1, False, id="a-tenth-long"),
    ],
)
async def test_a_draft_is_re_asked_as_far_short_as_long(ratio, re_asked):
    """The window is the same width on both sides of the target: a draft a
    fifth short is asked again just as one a fifth long is. One a tenth
    either way is kept."""
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return _draft_lasting(30 * ratio if len(asked) == 1 else 30).model_dump_json()

    await screenplay_within_target({"target_duration_s": 30}, ask)
    assert (len(asked) > 1) is re_asked
    assert 1 - LENGTH_FLOOR == pytest.approx(LENGTH_CEILING - 1)


async def test_an_unfixable_shortfall_renders_the_closest_attempt(caplog):
    """A model at its ceiling degrades rather than fails — the same call
    `supports()` makes about a missing Ollama. llama3.2 tops out around 150
    words however it is asked, and refusing the project would throw away a
    usable 45s video over it. The best attempt wins, and it is logged."""
    lengths = [8, 11, 9]  # words per scene: none reaches the target
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=lengths[len(asked) - 1]).model_dump_json()

    with caplog.at_level("WARNING"):
        out = await screenplay_within_target({"target_duration_s": 60}, ask)

    assert len(asked) == 3  # it kept pushing before settling
    # The longest attempt, not the last one: a re-ask can come back worse.
    assert out.model_dump() == screenplay(words_per_scene=11).model_dump()
    assert "short of its target" in caplog.text
    assert "60s" in caplog.text and "target duration" in caplog.text


async def test_a_re_ask_that_comes_back_worse_does_not_lose_the_better_draft():
    lengths = [11, 4, 4]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=lengths[len(asked) - 1]).model_dump_json()

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert estimated_runtime_s(out) == estimated_runtime_s(screenplay(words_per_scene=11))


async def test_an_over_long_screenplay_is_re_asked_to_come_down():
    """The check used to be one-sided, and a re-ask that over-corrected was
    kept for being long. Asked for a 20s video, qwen3:8b wrote 22 words,
    was told to write more, and came back with 108: a 42s cut."""
    attempts = [
        screenplay(words_per_scene=60).model_dump_json(),  # ~170s
        screenplay(words_per_scene=23).model_dump_json(),  # ~67s
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return attempts[len(asked) - 1]

    out = await screenplay_within_target({"target_duration_s": 60}, ask)

    assert len(asked) == 2
    assert out.model_dump() == screenplay(words_per_scene=23).model_dump()
    assert "too long" in asked[1]
    assert "540" in asked[1]  # words it actually wrote
    assert estimated_runtime_s(out) <= 60 * LENGTH_CEILING


async def test_the_draft_nearest_the_target_wins_not_the_longest(caplog):
    """When no attempt lands in range, the one to render is the one that
    misses by least. Preferring the longest shipped the over-correction."""
    lengths = [40, 8, 30]  # ~114s, ~25s, ~86s against 60s: none in range
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=lengths[len(asked) - 1]).model_dump_json()

    with caplog.at_level("WARNING"):
        out = await screenplay_within_target({"target_duration_s": 60}, ask)

    assert len(asked) == 3
    assert out.model_dump() == screenplay(words_per_scene=30).model_dump()
    assert "longer than its target" in caplog.text


async def test_a_screenplay_with_no_scenes_is_refused_not_rendered():
    """The one case degrading cannot cover: there is nothing to render, and
    no amount of padding invents a scene."""

    async def ask(prompt: str) -> str:
        return Screenplay(title="t", scenes=[]).model_dump_json()

    with pytest.raises(GenerationError, match="no scenes"):
        await screenplay_within_target({"target_duration_s": 60}, ask)


# -- blank fields: the model's "nothing to say" must not defeat a default ------


def test_blank_style_fields_get_the_declared_defaults():
    """Pydantic fills defaults for *missing* keys, not empty ones — and a
    small model that has nothing to say for a field returns `""`, not an
    omission. The kids-poem sample shipped with `style.music: ""`, so the
    music bed generated from the bare prompt "instrumental"; an empty
    `style.visual` is worse, silently unstyling every keyframe and clip."""
    parsed = Screenplay.model_validate(
        {"title": "t", "style": {"visual": "", "voice": "  ", "music": ""}}
    )
    assert parsed.style.visual == SceneStyle().visual
    assert parsed.style.voice == SceneStyle().voice
    assert parsed.style.music == SceneStyle().music


def test_real_style_values_are_untouched():
    parsed = Screenplay.model_validate(
        {"title": "t", "style": {"visual": "gouache", "voice": "warm", "music": "waltz"}}
    )
    assert (parsed.style.visual, parsed.style.voice, parsed.style.music) == (
        "gouache",
        "warm",
        "waltz",
    )


def test_blank_scene_motion_gets_its_default():
    parsed = Screenplay.model_validate(
        {
            "title": "t",
            "scenes": [
                {"id": "s1", "duration_s": 5, "narration": "hi", "visual": "a hill", "motion": ""}
            ],
        }
    )
    assert parsed.scenes[0].motion == "static shot"


def test_blank_hook_stays_blank():
    """The hook is prose with no fallback text — blank is a legitimate value
    there, not a defeated default."""
    assert Screenplay.model_validate({"title": "t", "hook": ""}).hook == ""


def test_keyframe_prompt_survives_a_blank_scene_visual():
    """`scene.visual` has no default to fall back on, so the joined keyframe
    prompt must not ship a dangling ", " when the model leaves it empty."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph

    screenplay = Screenplay.model_validate(
        {
            "title": "t",
            "style": {"visual": "watercolor"},
            "scenes": [{"id": "s1", "duration_s": 5, "narration": "hi", "visual": ""}],
        }
    )
    graph = expand_screenplay(prompt_template_graph("t"), screenplay)
    assert graph.nodes["s1.keyframe"].params["prompt"] == "watercolor"


# -- a re-ask must never be worse than not asking -------------------------------


async def test_an_unparseable_re_ask_keeps_the_draft_it_already_had(caplog):
    """The regression a real run caught: attempt 1 returned a valid 96-word
    screenplay, attempt 2 came back with a scene missing `visual`, and the
    parse error failed the whole job — so asking again was strictly worse
    than not asking, and a project that would have rendered short rendered
    nothing. A re-ask exists only to lengthen a draft already in hand."""
    replies = [
        screenplay(words_per_scene=11).model_dump_json(),  # valid, short
        '{"title": "t", "scenes": [{"id": "s1", "duration_s": 5}]}',  # missing fields
        "not json at all",
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return replies[len(asked) - 1]

    with caplog.at_level("WARNING"):
        out = await screenplay_within_target({"target_duration_s": 60}, ask)

    assert len(asked) == 3  # a bad re-ask still costs its attempt
    assert out.model_dump() == screenplay(words_per_scene=11).model_dump()
    assert "did not parse" in caplog.text


async def test_a_valid_re_ask_after_an_unparseable_one_still_wins():
    replies = [
        screenplay(words_per_scene=11).model_dump_json(),  # short
        "}{ not json",
        screenplay(words_per_scene=23).model_dump_json(),  # on target
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return replies[len(asked) - 1]

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert estimated_runtime_s(out) >= 60 * LENGTH_FLOOR


async def test_an_unparseable_first_ask_still_fails():
    """Nothing to degrade to: a model that cannot produce a valid screenplay
    at all must surface that error, not a confusing length message."""

    async def ask(prompt: str) -> str:
        return "not json at all"

    with pytest.raises(GenerationError, match="invalid screenplay"):
        await screenplay_within_target({"target_duration_s": 60}, ask)


def test_a_null_target_duration_does_not_crash_the_prompt():
    """`target_duration_s` is reachable through /patch set_params, which
    accepts null. script_max_tokens already coerces; the prompt and the
    length check must agree or the job dies with a bare TypeError."""
    assert str(narration_word_budget(60)) in script_prompt({"target_duration_s": None})


def test_feedback_reaches_the_prompt_with_the_screenplay_it_amends():
    """Enhance = re-ask carrying the current screenplay plus the user's
    notes. Both script backends build their user turn here, so asserting the
    prompt covers local and cloud alike."""
    base = '{"title": "The Fall of Istanbul", "scenes": []}'
    prompt = script_prompt(
        {
            "prompt": "istanbul, dramatic",
            "target_duration_s": 60,
            "feedback": "Make it about the 1453 conquest, not 1922.",
            "base_screenplay": base,
        }
    )
    assert "Make it about the 1453 conquest, not 1922." in prompt
    assert base in prompt
    assert "rewrite" in prompt.lower()
    # The original ask still anchors the rewrite: budget and topic hold.
    assert "istanbul, dramatic" in prompt


def test_feedback_without_a_base_changes_nothing():
    """A feedback param that arrives without the screenplay it refers to
    (hand-edited graph, partial patch) must not emit a dangling instruction."""
    plain = script_prompt({"prompt": "p", "target_duration_s": 60})
    assert script_prompt({"prompt": "p", "target_duration_s": 60, "feedback": "x"}) == plain
