"""Script LLM backend — llama.cpp server / Ollama (both speak an
OpenAI-compatible chat API), or a cloud TextGen provider adapter. Emits the
structured screenplay (schema-enforced JSON).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..notices import SCRIPT_SHORT_OF_TARGET
from ..schema import Screenplay
from .base import ExecutionBackend, ExecutionContext, GenerationError, ServiceProbe

# The single home for the pad the assembler actually applies — duplicating it
# here would let the estimate drift from the timing it is estimating.
from .ffmpeg import NARRATION_PAD_S

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """You are a short-form video screenwriter. Given a topic, produce a JSON \
screenplay with this exact shape (no markdown fences, JSON only):
{"title": str, "hook": str, "target_duration_s": int, "aspect": str,
 "style": {"visual": str, "voice": str, "music": str},
 "scenes": [{"id": "s1", "duration_s": float, "narration": str, "visual": str,
             "motion": str, "onscreen_text": str|null}]}
Scenes are 3-8 seconds each for short videos; longer targets may use longer scenes, but never \
exceed 60 seconds per scene. "narration" is the words spoken aloud. "visual" describes what is \
on screen, as a plain description of the picture — never a label, never the words "prompt" or \
"image", just the scene itself. "motion" is a short camera direction. The first scene must hook \
the viewer instantly."""

_METADATA_PROMPT = """You are a short-form video publisher. Given a video's script, produce a \
JSON publish kit with this exact shape (no markdown fences, JSON only):
{"title": str, "description": str, "hashtags": [str]}
Title under 70 characters, hook first, no all-caps clickbait. Description is 2-3 sentences. \
5-10 hashtags, lowercase, without the # symbol."""


# Output-token budget for a screenplay. A scene costs roughly 120 tokens of
# JSON (narration + visual + motion + the field names), and the graph caps a
# project at 20 minutes — call it ~240 scenes worst case. The default 4096
# truncated anything past a couple of minutes, at HTTP 200, and the failure
# surfaced as "the model returned invalid JSON" after the tokens were paid
# for. Sized from the actual target so a short video does not reserve (or
# get billed for a provider that charges on reserved) a huge ceiling.
_SCRIPT_TOKENS_PER_SCENE = 160
_SCRIPT_TOKENS_MIN = 4096
_SCRIPT_TOKENS_MAX = 32000
# The publish kit is a title, a description and ~10 hashtags.
METADATA_MAX_TOKENS = 1024
# A natural-language edit compiles to a short list of ops, not prose.
EDIT_MAX_TOKENS = 4096


def script_max_tokens(params: dict) -> int:
    """Output cap for one screenplay request, derived from its target
    duration the same way the scene-count floor in script_prompt is."""
    target_s = int(params.get("target_duration_s", 60) or 60)
    scenes = max(2, -(-target_s // 5))  # the shortest scenes the schema allows
    return max(_SCRIPT_TOKENS_MIN, min(_SCRIPT_TOKENS_MAX, scenes * _SCRIPT_TOKENS_PER_SCENE))


# Nominal narration rate, for turning a target duration into a word budget and
# for measuring a draft against it. The *real* runtime is always the
# synthesized audio — backends/ffmpeg.py is the timing authority — so this
# number only ever sizes a prompt and the shortfall check. ~3.5 words/s
# measured on Kokoro.
SPEECH_WORDS_PER_S = 3.5
# How short a draft may come in before it is re-asked, as a fraction of the
# target. Deliberately wide: narration length varies with voice and phrasing,
# and this exists to catch a script that is half the requested video rather
# than to police seconds.
LENGTH_TOLERANCE = 0.7
# Total attempts, not extra ones. Each costs a full model round trip (and a
# VRAM load on the local path), so this buys two corrections, not a loop.
_LENGTH_ATTEMPTS = 3


def _target_duration_s(params: dict) -> int:
    """The node's target duration, coerced the way script_max_tokens already
    coerces it. `/patch` set_params accepts a null, and a bare int(None) here
    fails the script job with a TypeError instead of rendering."""
    return int(params.get("target_duration_s", 60) or 60)


def narration_word_budget(target_s: int) -> int:
    """Words of narration a `target_s` video needs, since that is what sets
    its length. Approximate by construction — it reaches the model as "about
    N words"."""
    return max(1, round(target_s * SPEECH_WORDS_PER_S))


def estimated_runtime_s(screenplay: Screenplay) -> float:
    """What this screenplay will actually assemble to: its narration spoken,
    plus the breathing room each scene carries after its line. Compare against
    `target_duration_s` — the schema's own `duration_s` per scene is what the
    model *claimed*, and nothing downstream reads it."""
    words = sum(len(scene.narration.split()) for scene in screenplay.scenes)
    return words / SPEECH_WORDS_PER_S + NARRATION_PAD_S * len(screenplay.scenes)


def script_prompt(params: dict) -> str:
    """The user-turn prompt for a screenplay, shared by the local and cloud
    script backends — they also share _SYSTEM_PROMPT and _parse_screenplay,
    so a rule stated in only one of them is a bug on the other provider.

    A scene may not exceed 60s (screenplay schema), so a long target needs a
    floor on the scene count: models otherwise return a handful of over-long
    scenes that fail validation outright, on every retry.

    The narration budget is stated with its mechanism. A model told only
    "60s" writes short couplets and pads `duration_s` to reach the number —
    which produces a 28s video, because `duration_s` is not what anything
    downstream reads."""
    target_s = _target_duration_s(params)
    return (
        f"Topic: {params.get('prompt', '')}\n"
        f"Target duration: {target_s}s (use at least {max(2, -(-target_s // 30))} scenes; "
        "no scene may exceed 60 seconds)\n"
        f"Narration: about {narration_word_budget(target_s)} words in total, across all "
        "scenes. The video's length is how long its narration takes to speak aloud, NOT the "
        "duration_s you write — write too few words and the video comes out short.\n"
        f"Aspect: {params.get('aspect', '9:16')}\n"
        f"Style preset: {params.get('style_preset', 'cinematic')}"
    )


def _shortfall_note(screenplay: Screenplay, target_s: int) -> str:
    """The re-ask. It carries the measurement: repeating the original
    instruction is what already produced the short draft."""
    words = sum(len(scene.narration.split()) for scene in screenplay.scenes)
    return (
        f"That screenplay is too short. Its narration is {words} words, which speaks in "
        f"about {estimated_runtime_s(screenplay):.0f}s — but the target is {target_s}s, "
        f"which needs about {narration_word_budget(target_s)} words.\n"
        "Rewrite it with the same story and scenes, giving every scene enough narration to "
        "fill its time. Do not shorten the narration and raise duration_s instead: "
        "duration_s does not lengthen the video, only the spoken words do."
    )


async def screenplay_within_target(
    params: dict,
    ask: Callable[[str], Awaitable[str]],
    notify: Callable[..., None] | None = None,
) -> Screenplay:
    """The longest screenplay the model will write for `target_duration_s`.

    Shared by both script backends via an `ask` closure, so the rule holds on
    every provider. Small local models write to a rhythm rather than to a word
    count and ignore the budget however plainly it is stated, so a short draft
    is re-asked carrying its own measurement — which measurably works:
    llama3.2 went 97 words on the old prompt, then 121 -> 122 -> 148 across
    three attempts here.

    A model that still falls short degrades rather than fails. That is the
    same call `supports()` makes about a missing Ollama: a limited environment
    should render what it can, not refuse the project. 148 words is llama3.2's
    ceiling, not a fault in the request, and failing would reject a usable 45s
    video over it. The shortfall goes to `notify` (the callers pass
    ExecutionContext.notify, so it reaches the scene board) and to the log,
    which is all a headless engine has.
    """
    target_s = _target_duration_s(params)
    floor = target_s * LENGTH_TOLERANCE
    prompt = script_prompt(params)
    # Unguarded, unlike the re-asks below: a model that cannot produce a
    # valid screenplay at all has nothing to degrade to, and that parse
    # error is the actionable one.
    best = LLMScriptBackend._parse_screenplay(await ask(prompt))
    candidate = best
    for attempt in range(1, _LENGTH_ATTEMPTS + 1):
        if attempt > 1:
            try:
                candidate = LLMScriptBackend._parse_screenplay(await ask(prompt))
            except GenerationError as exc:
                # A re-ask exists only to lengthen a draft already in hand,
                # so failing the job on its JSON would make asking again
                # strictly worse than not asking — and every extra ask is
                # another chance for a small model to violate the schema.
                # Observed on a real 60s render: a valid 96-word attempt 1
                # was thrown away when attempt 2 omitted a scene's `visual`.
                logger.warning(
                    "screenplay re-ask %d/%d did not parse (%s) — keeping the best draft so far",
                    attempt,
                    _LENGTH_ATTEMPTS,
                    exc,
                )
                continue
            if estimated_runtime_s(candidate) > estimated_runtime_s(best):
                best = candidate
        if candidate.scenes and estimated_runtime_s(candidate) >= floor:
            return candidate
        logger.warning(
            "screenplay attempt %d/%d: %d words, ~%.0fs against a %ds target",
            attempt,
            _LENGTH_ATTEMPTS,
            sum(len(scene.narration.split()) for scene in candidate.scenes),
            estimated_runtime_s(candidate),
            target_s,
        )
        if attempt < _LENGTH_ATTEMPTS:
            prompt = f"{script_prompt(params)}\n\n{_shortfall_note(candidate, target_s)}"
    if not best.scenes:
        # Nothing to render, and no amount of padding invents a scene.
        raise GenerationError(
            f"the script model returned a screenplay with no scenes after "
            f"{_LENGTH_ATTEMPTS} attempts"
        )
    words = sum(len(scene.narration.split()) for scene in best.scenes)
    logger.warning(
        "screenplay stays short of its target after %d attempts: %d words, ~%.0fs against %ds. "
        "Rendering it anyway — lower the target duration, or use a larger script model, "
        "to get the full length.",
        _LENGTH_ATTEMPTS,
        words,
        estimated_runtime_s(best),
        target_s,
    )
    if notify is not None:
        notify(
            SCRIPT_SHORT_OF_TARGET,
            target_s=target_s,
            estimated_s=round(estimated_runtime_s(best)),
            words=words,
        )
    return best


class LLMScriptBackend(ExecutionBackend):
    name = "llm"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434/v1",
        model: str = "qwen3:14b",
        unload_after: bool = True,
        timeout_s: int = 600,
    ) -> None:
        base = base_url.rstrip("/")
        # Accept both http://host:port and http://host:port/v1 — the chat
        # endpoint lives under /v1 on Ollama/llama.cpp, native APIs at root.
        self.root_url = base.removesuffix("/v1")
        self.chat_base = base if base.endswith("/v1") else f"{base}/v1"
        self.model = model
        self.timeout_s = timeout_s
        # The scheduler owns VRAM: on shared-GPU boxes the LLM must yield
        # before image/video jobs run (LLM → unload → image batch).
        self.unload_after = unload_after
        self.probe = ServiceProbe(f"{self.chat_base}/models")

    def supports(self, kind: NodeKind) -> bool:
        # Claim scripts only while the LLM server answers — the hybrid
        # default chain ("local,mock") must fall through to mock on a
        # machine without Ollama, not fail every script job. A missing
        # *model* on a live server still fails loudly and actionably.
        return kind is NodeKind.SCRIPT and self.probe.available()

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        if spec.model is not None and spec.model.startswith("cloud:"):
            # Never fall back to the local model silently — the user asked
            # for cloud quality and would believe they got it.
            raise GenerationError(
                f"cloud model {spec.model!r} requested but no cloud provider is "
                "configured (BYOK providers arrive in a later phase)"
            )
        if spec.params.get("task") == "metadata":
            # Publish kit (title/description/hashtags) from the script — a
            # second LLM task on the same backend, not a new node kind.
            raw = await self.complete(
                str(spec.params.get("prompt", "")),
                system=_METADATA_PROMPT,
                max_tokens=METADATA_MAX_TOKENS,
            )
            return ctx.publish_text(
                spec.output_hash, ".metadata.json", json.dumps(self._parse_metadata(raw), indent=2)
            )
        screenplay = await screenplay_within_target(
            spec.params,
            lambda text: self.complete(
                text, system=_SYSTEM_PROMPT, max_tokens=script_max_tokens(spec.params)
            ),
            notify=ctx.notify,
        )
        await ctx.progress(0.9)
        return ctx.publish_text(
            spec.output_hash, ".screenplay.json", screenplay.model_dump_json(indent=2)
        )

    async def complete(self, prompt: str, system: str, max_tokens: int = _SCRIPT_TOKENS_MAX) -> str:
        """One-shot completion with the same VRAM-yield discipline as jobs:
        interactive tasks (graph edits) share the server with script jobs and
        must release the model for image/video work afterwards."""
        raw = await self._local_complete(prompt, system=system, max_tokens=max_tokens)
        if self.unload_after:
            await self._unload()
        return raw

    async def _local_complete(
        self,
        prompt: str,
        system: str = _SYSTEM_PROMPT,
        max_tokens: int = _SCRIPT_TOKENS_MAX,
    ) -> str:
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            response = await client.post(
                f"{self.chat_base}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.7,
                    # Explicit, matching the cloud path. Sending no cap left
                    # the server's own default in charge, so an over-long
                    # screenplay came back truncated with no way to tell that
                    # apart from a model that emits bad JSON.
                    "max_tokens": max_tokens,
                },
            )
            if response.status_code != 200:
                raise GenerationError(f"local LLM error: {response.text[:500]}")
            # A 200 with an unexpected shape (empty choices, error object) must
            # fail as a classified GenerationError, not a raw KeyError/IndexError.
            try:
                choice = response.json()["choices"][0]
                text = choice["message"]["content"]
            except (ValueError, KeyError, IndexError, TypeError) as exc:
                raise GenerationError(f"local LLM returned an unreadable body: {exc}") from exc
            if choice.get("finish_reason") == "length":
                # Task-neutral wording: this path also serves the publish kit
                # and the natural-language edit, where "the screenplay" and
                # "target duration" name nothing the user can act on.
                raise GenerationError(
                    f"the local model stopped at the {max_tokens}-token output cap before "
                    "finishing — the response is incomplete. Try a shorter target duration, "
                    "or a model with a larger output limit."
                )
            return text

    async def _unload(self) -> None:
        """Best-effort VRAM release via Ollama's native API; llama.cpp and
        other OpenAI-compatible servers simply 404 and are ignored."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{self.root_url}/api/generate", json={"model": self.model, "keep_alive": 0}
                )
        except httpx.HTTPError:
            pass

    @staticmethod
    def _parse_screenplay(raw: str) -> Screenplay:
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("```")[1].removeprefix("json").strip()
        try:
            return Screenplay.model_validate(json.loads(text))
        except (json.JSONDecodeError, ValueError) as exc:
            raise GenerationError(f"LLM returned an invalid screenplay: {exc}") from exc

    @staticmethod
    def _parse_metadata(raw: str) -> dict:
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("```")[1].removeprefix("json").strip()
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise GenerationError(f"LLM returned an invalid publish kit: {exc}") from exc
        # Valid JSON is not necessarily an object: a model that answers with a
        # list or a bare string parses fine and then AttributeErrors on .get,
        # surfacing as a traceback instead of a classified generation error.
        if not isinstance(data, dict):
            raise GenerationError(f"LLM returned a {type(data).__name__}, not a publish-kit object")
        hashtags = data.get("hashtags")
        if not isinstance(hashtags, list):
            hashtags = []  # a string or object here is not a tag list
        return {
            "title": str(data.get("title", ""))[:120],
            "description": str(data.get("description", "")),
            "hashtags": [str(tag).lstrip("#") for tag in hashtags if str(tag).strip()],
        }
