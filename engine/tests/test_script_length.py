"""The screenplay's narration budget.

`backends/ffmpeg.py` is the timing authority: narration duration drives scene
duration, so a video is exactly as long as its narration takes to speak.
Nothing used to connect that to `target_duration_s` — the script model was
asked for a 60s video, wrote 97 words of one-line couplets, and the project
assembled to 27.9s with no signal anywhere that the target had been missed.
"""

import pytest

from localcut_engine.backends.llm import (
    LENGTH_TOLERANCE,
    SPEECH_WORDS_PER_S,
    _SYSTEM_PROMPT,
    estimated_runtime_s,
    narration_word_budget,
    screenplay_within_target,
    script_prompt,
)
from localcut_engine.backends.base import GenerationError
from localcut_engine.schema import Scene, Screenplay


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
    assert narration_word_budget(60) == pytest.approx(60 * SPEECH_WORDS_PER_S, abs=1)
    assert narration_word_budget(30) < narration_word_budget(60) < narration_word_budget(120)
    # A floor, not a zero: the budget reaches a prompt as "about N words".
    assert narration_word_budget(5) >= 1


def test_runtime_estimate_matches_the_observed_cut():
    """The real case: 97 words over 8 scenes assembled to 27.9s. The estimate
    only has to be close enough to tell that apart from a 60s video."""
    observed = screenplay(words_per_scene=12, scenes=8)  # 96 words
    assert estimated_runtime_s(observed) == pytest.approx(27.9, abs=3.0)


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


async def test_a_screenplay_that_hits_the_target_is_asked_once():
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=23).model_dump_json()

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert len(asked) == 1
    assert estimated_runtime_s(out) >= 60 * LENGTH_TOLERANCE


async def test_a_short_screenplay_is_re_asked_with_the_shortfall():
    attempts = [
        screenplay(words_per_scene=11).model_dump_json(),  # ~28s, the real case
        screenplay(words_per_scene=23).model_dump_json(),  # ~60s
    ]
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return attempts[len(asked) - 1]

    out = await screenplay_within_target({"target_duration_s": 60}, ask)
    assert len(asked) == 2
    assert estimated_runtime_s(out) >= 60 * LENGTH_TOLERANCE
    # The re-ask has to carry the measurement, or it is the same blind
    # instruction that produced the short draft in the first place.
    assert "99" in asked[1]  # words it actually wrote
    assert str(narration_word_budget(60)) in asked[1]


async def test_an_unfixable_shortfall_renders_the_longest_attempt(caplog):
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


async def test_an_over_long_screenplay_is_left_alone():
    """The check is one-sided. A model that writes generously is not the
    failure being guarded against, and re-rolling it would throw away a good
    screenplay over an approximate word rate."""
    asked = []

    async def ask(prompt: str) -> str:
        asked.append(prompt)
        return screenplay(words_per_scene=60).model_dump_json()

    await screenplay_within_target({"target_duration_s": 60}, ask)
    assert len(asked) == 1


async def test_a_screenplay_with_no_scenes_is_refused_not_rendered():
    """The one case degrading cannot cover: there is nothing to render, and
    no amount of padding invents a scene."""

    async def ask(prompt: str) -> str:
        return Screenplay(title="t", scenes=[]).model_dump_json()

    with pytest.raises(GenerationError, match="no scenes"):
        await screenplay_within_target({"target_duration_s": 60}, ask)
