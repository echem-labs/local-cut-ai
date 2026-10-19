"""Script LLM backend — llama.cpp server / Ollama (both speak an
OpenAI-compatible chat API), or a cloud TextGen provider adapter. Emits the
structured screenplay (schema-enforced JSON).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..notices import SCRIPT_SHORT_OF_TARGET
from ..providers.images import data_url
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
the viewer instantly.
Each scene is filmed as ONE continuous shot: a single picture is drawn from "visual" and then \
animated with "motion", with no editing inside the scene. So "visual" is one moment in one \
frame, never a split screen, collage, montage, grid of panels, picture-in-picture or sequence of \
shots, and never words, captions or labels drawn into the picture. "motion" is one camera \
movement through that shot, such as a slow push-in or a pan, never a cut or a transition. To show \
something else, start a new scene. Words meant for the screen go in "onscreen_text". Describe \
only what is in the frame, never what is absent from it."""

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
# Added to any of the caps above for a model that thinks before it answers and
# cannot be asked not to (LLMScriptBackend._thinking). qwen3:8b spent about
# 3400 tokens thinking ahead of a 470-token screenplay; this leaves room for
# twice that before the answer starts.
THINKING_TOKENS = 8192


def script_max_tokens(params: dict) -> int:
    """Output cap for one screenplay request, derived from its target
    duration the same way the scene-count floor in script_prompt is."""
    target_s = int(params.get("target_duration_s", 60) or 60)
    scenes = max(2, -(-target_s // 5))  # the shortest scenes the schema allows
    return max(_SCRIPT_TOKENS_MIN, min(_SCRIPT_TOKENS_MAX, scenes * _SCRIPT_TOKENS_PER_SCENE))


# Nominal narration rate, for turning a target duration into a word budget and
# for measuring a draft against it. The *real* runtime is always the
# synthesized audio (backends/ffmpeg.py is the timing authority), so this
# number only ever sizes a prompt and the length check.
#
# Counted in letters, because that is what Kokoro's pace holds steady on. One
# voice (af_sarah, speed 1.0, one synthesis per line as a narration node is
# rendered) read short-word children's couplets at 3.54 words/s and explainer
# narration at 2.52 words/s, but at 13.4 and 13.7 letters/s. A words rate
# fits one of those and misses the other by a third: 3.5 words/s was right
# for the couplets and put a real 62s explainer cut at 45s. Nineteen narrated
# scenes rendered across the voices one machine used averaged 13.2 letters/s.
# 76 drafts by qwen3.5:9b and llama3.2 (222 scenes, mostly af_sarah) read at
# a median 13.8, with only one in ten of them under 13.1. A rate under the
# voice's own measures every draft long, so one the length check takes as on
# target speaks short; 13.5 leaves that at a few percent, still on the short
# side.
SPEECH_LETTERS_PER_S = 13.5
# Letters in a word of the narration script models write (5.0 across those
# 758 words). Only used to say a budget in words, the unit a model can count;
# a draft is always measured by its own letters.
LETTERS_PER_WORD = 5.0
# How short or long a draft may come in before it is re-asked, as fractions
# of the target: the same distance either side, a little wider than the ask
# below so a draft that does what it was asked is kept. Kokoro reads a
# script model's narration at 13 to 15.5 letters a second depending on the
# voice and the text, so tighter than this would re-ask drafts the voice
# was always going to land wherever it lands.
LENGTH_FLOOR = 0.85
LENGTH_CEILING = 1.15
# What an ask aims for, as a band around the target. Narrower than the
# window above: a model asked for "about N" writes past N, so the ask names
# both ends.
_ASK_BAND = 0.1
# Total attempts, not extra ones. Each costs a full model round trip (and a
# VRAM load on the local path), so this buys two corrections, not a loop.
_LENGTH_ATTEMPTS = 3


def _target_duration_s(params: dict) -> int:
    """The node's target duration, coerced the way script_max_tokens already
    coerces it. `/patch` set_params accepts a null, and a bare int(None) here
    fails the script job with a TypeError instead of rendering."""
    return int(params.get("target_duration_s", 60) or 60)


def narration_word_budget(target_s: float) -> int:
    """Words of narration a `target_s` video needs, since that is what sets
    its length. Approximate by construction: it reaches the model inside a
    range around this number."""
    return max(1, round(target_s * SPEECH_LETTERS_PER_S / LETTERS_PER_WORD))


def spoken_seconds(text: str) -> float:
    """How long `text` takes to say, before the pad assembly adds after it.

    Letters by `str.isalpha`, which is Unicode category L: what the
    desktop's `\\p{L}` matches in lib/formats.ts. Digits, punctuation and
    the spaces between words are not counted."""
    return sum(char.isalpha() for char in text) / SPEECH_LETTERS_PER_S


def estimated_runtime_s(screenplay: Screenplay) -> float:
    """What this screenplay will actually assemble to: its narration spoken,
    plus the breathing room each scene carries after its line. Compare against
    `target_duration_s`. The schema's own `duration_s` per scene is what the
    model *claimed*: it sets how long a clip the video model renders (and how
    many takes), but assembly fits every narrated scene to its narration, so
    it never sets the length of the cut."""
    spoken = sum(spoken_seconds(scene.narration) for scene in screenplay.scenes)
    return spoken + NARRATION_PAD_S * len(screenplay.scenes)


def _words(screenplay: Screenplay) -> int:
    return sum(len(scene.narration.split()) for scene in screenplay.scenes)


def _word_range(target_s: float) -> tuple[int, int]:
    """The fewest and most words an ask names for `target_s`."""
    return (
        narration_word_budget(target_s * (1 - _ASK_BAND)),
        narration_word_budget(target_s * (1 + _ASK_BAND)),
    )


def script_prompt(params: dict) -> str:
    """The user-turn prompt for a screenplay, shared by the local and cloud
    script backends — they also share _SYSTEM_PROMPT and _parse_screenplay,
    so a rule stated in only one of them is a bug on the other provider.

    A scene may not exceed 60s (screenplay schema), so a long target needs a
    floor on the scene count: models otherwise return a handful of over-long
    scenes that fail validation outright, on every retry.

    The narration budget is stated with its mechanism. A model told only
    "60s" writes short couplets and pads `duration_s` to reach the number,
    which produces a 28s video, because the cut runs as long as its narration
    whatever `duration_s` says. And it is stated as a range, because "about
    N words" reads as a floor: qwen3:8b asked for about 70 wrote 108."""
    target_s = _target_duration_s(params)
    low, high = _word_range(target_s)
    ask = (
        f"Topic: {params.get('prompt', '')}\n"
        f"Target duration: {target_s}s (use at least {max(2, -(-target_s // 30))} scenes; "
        "no scene may exceed 60 seconds)\n"
        f"Narration: about {narration_word_budget(target_s)} words in total, across all "
        f"scenes: between {low} and {high} words, no fewer and no more. The video's length "
        "is how long its narration takes to speak aloud, NOT the duration_s you write. Too "
        "few words and the video comes out short; too many and it runs long.\n"
        f"Aspect: {params.get('aspect', '9:16')}\n"
        f"Style preset: {params.get('style_preset', 'cinematic')}"
    )
    # Enhance: the re-ask carries the screenplay it amends. Both or neither —
    # feedback without its base (a hand-edited graph, a partial patch) would
    # ask the model to revise something it cannot see.
    feedback = str(params.get("feedback") or "").strip()
    base = str(params.get("base_screenplay") or "").strip()
    if feedback and base:
        ask += (
            f"\n\nHere is the current screenplay:\n{base}\n\n"
            f"The user asked for this revision: {feedback}\n"
            "Rewrite the screenplay applying that feedback, keeping whatever it does not "
            "touch. The duration and narration budget above still apply."
        )
    return ask


def _length_note(screenplay: Screenplay, target_s: int) -> str:
    """The re-ask. It carries the measurement: repeating the original
    instruction is what already produced the draft that missed.

    The words it asks for are scaled from the draft's own. A model writing
    short words needs more of them to fill the same time, and the draft has
    already shown which kind it writes."""
    words = _words(screenplay)
    runtime = estimated_runtime_s(screenplay)
    if words and runtime:
        low = max(1, round(words * target_s * (1 - _ASK_BAND) / runtime))
        high = max(low, round(words * target_s * (1 + _ASK_BAND) / runtime))
    else:
        low, high = _word_range(target_s)
    measured = (
        f"Its narration is {words} words, which speaks in about {runtime:.0f}s, but the "
        f"target is {target_s}s."
    )
    if runtime < target_s:
        return (
            f"That screenplay is too short. {measured}\n"
            f"Rewrite it with the same story and scenes, with between {low} and {high} words "
            "of narration in total, giving every scene enough to fill its time. Do not "
            "shorten the narration and raise duration_s instead: duration_s does not lengthen "
            "the video, only the spoken words do."
        )
    return (
        f"That screenplay is too long. {measured}\n"
        f"Rewrite it with the same story, cutting the narration to between {low} and {high} "
        "words in total. Shorter lines or fewer scenes both work. Lowering duration_s does "
        "not, because only the spoken words set the video's length."
    )


def _miss_s(screenplay: Screenplay, target_s: int) -> float:
    """How far from the target this draft would cut, in seconds. A draft with
    no scenes misses by more than any draft that has one."""
    if not screenplay.scenes:
        return math.inf
    return abs(estimated_runtime_s(screenplay) - target_s)


async def screenplay_within_target(
    params: dict,
    ask: Callable[[str], Awaitable[str]],
    notify: Callable[..., None] | None = None,
) -> Screenplay:
    """The screenplay nearest `target_duration_s` the model will write.

    Shared by both script backends via an `ask` closure, so the rule holds on
    every provider. Small local models write to a rhythm rather than to a word
    count and ignore the budget however plainly it is stated, so a draft
    outside the window is re-asked carrying its own measurement. For a short
    draft that measurably works: llama3.2 went 97 words on the old prompt,
    then 121 -> 122 -> 148 across three attempts. It over-corrects too. Told
    to write more for a 20s video, qwen3:8b went from 22 words to 108, so a
    long draft is re-asked as well, and when none lands in the window the one
    kept is the one nearest the target rather than the longest.

    A model that still misses degrades rather than fails. That is the same
    call `supports()` makes about a missing Ollama: a limited environment
    should render what it can, not refuse the project. 148 words is
    llama3.2's ceiling, not a fault in the request, and failing would reject
    a usable 45s video over it. A shortfall goes to `notify` (the callers
    pass ExecutionContext.notify, so it reaches the scene board) and to the
    log, which is all a headless engine has.
    """
    target_s = _target_duration_s(params)
    floor, ceiling = target_s * LENGTH_FLOOR, target_s * LENGTH_CEILING
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
                # A re-ask exists only to correct a draft already in hand,
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
            if _miss_s(candidate, target_s) < _miss_s(best, target_s):
                best = candidate
        if candidate.scenes and floor <= estimated_runtime_s(candidate) <= ceiling:
            return candidate
        logger.warning(
            "screenplay attempt %d/%d: %d words, ~%.0fs against a %ds target",
            attempt,
            _LENGTH_ATTEMPTS,
            _words(candidate),
            estimated_runtime_s(candidate),
            target_s,
        )
        if attempt < _LENGTH_ATTEMPTS:
            prompt = f"{script_prompt(params)}\n\n{_length_note(candidate, target_s)}"
    if not best.scenes:
        # Nothing to render, and no amount of padding invents a scene.
        raise GenerationError(
            f"the script model returned a screenplay with no scenes after "
            f"{_LENGTH_ATTEMPTS} attempts"
        )
    words = _words(best)
    runtime = estimated_runtime_s(best)
    if runtime > ceiling:
        # Logged and rendered, with no notice: SCRIPT_SHORT_OF_TARGET says
        # the opposite, and a cut that runs long shows its own length on
        # the board.
        logger.warning(
            "screenplay stays longer than its target after %d attempts: %d words, ~%.0fs "
            "against %ds. Rendering the draft nearest the target.",
            _LENGTH_ATTEMPTS,
            words,
            runtime,
            target_s,
        )
        return best
    logger.warning(
        "screenplay stays short of its target after %d attempts: %d words, ~%.0fs against %ds. "
        "Rendering it anyway — lower the target duration, or use a larger script model, "
        "to get the full length.",
        _LENGTH_ATTEMPTS,
        words,
        runtime,
        target_s,
    )
    if notify is not None:
        notify(
            SCRIPT_SHORT_OF_TARGET,
            target_s=target_s,
            estimated_s=round(runtime),
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
        default_model: Callable[[], str | None] | None = None,
    ) -> None:
        base = base_url.rstrip("/")
        # Accept both http://host:port and http://host:port/v1 — the chat
        # endpoint lives under /v1 on Ollama/llama.cpp, native APIs at root.
        self.root_url = base.removesuffix("/v1")
        self.chat_base = base if base.endswith("/v1") else f"{base}/v1"
        self.model = model
        # Live read of what a job with no model of its own is written with.
        # The engine passes recommend.script_model (the user's pick in
        # Settings > Models, else Auto), and `model` is the fallback for an
        # instance built without one. A callable, not a value: the pick can
        # change mid-session and the next job must see it without a backend
        # rebuild. It can block (Auto's first answer probes the hardware), so
        # the async paths below ask it from a thread.
        self.default_model = default_model
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

    async def list_models(self) -> list[str]:
        """Model names the server can complete with, from the OpenAI-compat
        `/models` surface (Ollama and llama.cpp both serve it). Raises
        httpx.HTTPError when the server is unreachable — the caller decides
        what a missing server means."""
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{self.chat_base}/models")
            if response.status_code != 200:
                return []
            try:
                payload = response.json()
            except ValueError:
                return []
        # Ollama answers a server with no models as `"data": null`, which is
        # the state LocalCut's own copy is in until its first pull finishes.
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            return []
        return sorted(str(row["id"]) for row in data if isinstance(row, dict) and row.get("id"))

    async def resident_models(self) -> set[str] | None:
        """Model names currently held in memory by the server, or None when it
        cannot say.

        The one honest progress signal available for a local read. The chat
        request is a single opaque POST that returns when the whole answer is
        ready, so the client has nothing to show between "sent" and "done" —
        but the slow part is almost never the reading. It is the loading:
        several GB off disk and onto the GPU, minutes on a contended one,
        during which a spinner alone is indistinguishable from a hang.

        Cheap and, importantly, INDEPENDENT of the chat endpoint — Ollama
        answers `/api/ps` immediately even while a generation is in flight, so
        polling this cannot itself be blocked by the read it is reporting on.
        """
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(f"{self.root_url}/api/ps")
        except httpx.HTTPError:
            return None
        if response.status_code != 200:
            return None
        try:
            models = response.json().get("models") or []
        except ValueError:
            return None
        return {str(row["name"]) for row in models if isinstance(row, dict) and row.get("name")}

    async def list_vision_models(self) -> list[str] | None:
        """Installed model names that can actually SEE, or None when the
        server cannot say.

        Ollama's native `/api/show` reports a `capabilities` list, and
        `"vision"` in it is the only trustworthy signal available: the
        OpenAI-compatible `/models` surface both servers share reports names
        and nothing else, so a picker built from that would offer text-only
        models for a job whose whole contract is that nothing guesses about a
        picture. A text model named here answers from the prompt alone, at
        HTTP 200, indistinguishable from a real reading.

        None rather than [] for a server that does not serve `/api/show`
        (llama.cpp and friends): "I cannot tell which of these can see" and
        "none of these can see" are different answers, and the caller must
        not render the second when it has the first.
        """
        try:
            names = await self.list_models()
        except httpx.HTTPError:
            return None
        if not names:
            return None
        async with httpx.AsyncClient(timeout=10) as client:

            async def sees(name: str) -> tuple[str, bool | None]:
                try:
                    response = await client.post(f"{self.root_url}/api/show", json={"model": name})
                except httpx.HTTPError:
                    return name, None
                if response.status_code != 200:
                    return name, None
                try:
                    caps = response.json().get("capabilities") or []
                except ValueError:
                    return name, None
                return name, "vision" in caps

            answers = await asyncio.gather(*(sees(name) for name in names))
        # Every probe failing means the server does not speak Ollama's native
        # API at all — unknown, not empty.
        if all(seen is None for _, seen in answers):
            return None
        return [name for name, seen in answers if seen]

    def resolve_model(self, requested: str | None) -> str:
        """The Ollama model a node's `model` choice lands on: an explicit
        request wins (with the `local:` routing prefix stripped — the server
        knows only bare names); otherwise `default_model`, and only then the
        constructor's model."""
        if requested:
            return requested.removeprefix("local:")
        if self.default_model is not None and (configured := self.default_model()):
            return configured
        return self.model

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        if spec.model is not None and spec.model.startswith("cloud:"):
            # Never fall back to the local model silently — the user asked
            # for cloud quality and would believe they got it.
            raise GenerationError(
                f"cloud model {spec.model!r} requested but no cloud provider is "
                "configured (BYOK providers arrive in a later phase)"
            )
        model = await asyncio.to_thread(self.resolve_model, spec.model)
        ctx.record_model(model)
        if spec.params.get("task") == "metadata":
            # Publish kit (title/description/hashtags) from the script — a
            # second LLM task on the same backend, not a new node kind.
            raw = await self.complete(
                str(spec.params.get("prompt", "")),
                system=_METADATA_PROMPT,
                max_tokens=METADATA_MAX_TOKENS,
                model=model,
            )
            return ctx.publish_text(
                spec.output_hash, ".metadata.json", json.dumps(self._parse_metadata(raw), indent=2)
            )
        try:
            screenplay = await screenplay_within_target(
                spec.params,
                # Straight to the server rather than through `complete`, which
                # yields the model after every call: a re-ask is the same job
                # asking again at once, and yielding between asks made each
                # one load the weights again. A real 60s job spent eight
                # minutes over three asks. The yield happens once, below,
                # however the asking ends.
                lambda text: self._local_complete(
                    text, model, system=_SYSTEM_PROMPT, max_tokens=script_max_tokens(spec.params)
                ),
                notify=ctx.notify,
            )
        finally:
            if self.unload_after:
                await self._unload(model)
        await ctx.progress(0.9)
        return ctx.publish_text(
            spec.output_hash, ".screenplay.json", screenplay.model_dump_json(indent=2)
        )

    async def complete(
        self,
        prompt: str,
        system: str,
        max_tokens: int = _SCRIPT_TOKENS_MAX,
        model: str | None = None,
    ) -> str:
        """One-shot completion with the same VRAM-yield discipline as jobs:
        interactive tasks (graph edits) share the server with script jobs and
        must release the model for image/video work afterwards. A call that
        fails releases it too, or it stays resident until the server's own
        keep-alive runs out, with ComfyUI next in line for the GPU."""
        # The one place the configured default is applied — the private
        # helpers below take a resolved name so it cannot drift between them.
        model = await asyncio.to_thread(self.resolve_model, model)
        try:
            return await self._local_complete(prompt, model, system=system, max_tokens=max_tokens)
        finally:
            if self.unload_after:
                await self._unload(model)

    async def describe(
        self,
        system: str,
        prompt: str,
        image: Path,
        max_tokens: int = 4096,
        model: str | None = None,
    ) -> str:
        """The same completion, with a picture the model can actually see.

        The OpenAI-compatible `image_url` part, which is what Ollama and
        llama.cpp serve for a vision model — the same shape
        `OpenAICompatTextGen.describe` sends to a cloud endpoint, so one
        request body serves both and there is no second spelling to drift.

        `model` is required in practice and never falls back to the script
        model: `resolve_model` would hand back a text-only default that
        cannot see, and the server would answer from the prompt alone with a
        confident description of a picture nothing looked at. That is the
        trap `TextGen.describe` refuses by default, and it must not be
        reachable here either.
        """
        if not model:
            raise GenerationError(
                "no local vision model is set — choose one under Settings > Models"
            )
        model = model.removeprefix("local:")
        # Image first, for the same reason the cloud adapters do it: a picture
        # placed after the question is attended to less.
        content = [
            {"type": "image_url", "image_url": {"url": await data_url(image)}},
            {"type": "text", "text": prompt},
        ]
        try:
            return await self._local_complete(content, model, system=system, max_tokens=max_tokens)
        finally:
            if self.unload_after:
                await self._unload(model)

    async def _local_complete(
        self,
        content: str | list,
        model: str,
        system: str = _SYSTEM_PROMPT,
        max_tokens: int = _SCRIPT_TOKENS_MAX,
    ) -> str:
        body: dict = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.7,
            # Explicit, matching the cloud path. Sending no cap left the
            # server's own default in charge, so an over-long screenplay came
            # back truncated with no way to tell that apart from a model that
            # emits bad JSON.
            "max_tokens": max_tokens,
        }
        match await self._thinking(model):
            case "stoppable":
                body["reasoning_effort"] = "none"
            case "unstoppable":
                # The cap is sized for the answer. Raised by the thinking a
                # model cannot be talked out of, the answer keeps its room.
                body["max_tokens"] = max_tokens + THINKING_TOKENS
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            try:
                response = await client.post(f"{self.chat_base}/chat/completions", json=body)
            except httpx.TimeoutException as exc:
                # The ceiling above is generous precisely because a cold load
                # on a modest GPU is slow, so reaching it means the server
                # took the request and never answered — a wedged Ollama
                # runner does exactly this, and every later request queues
                # behind it. httpx's timeouts stringify to "", so without
                # this the job is recorded as failed with no reason at all.
                raise GenerationError(
                    f"the local LLM server took the request for {model!r} and did not answer "
                    f"within {self.timeout_s}s. It may be busy loading another model, or "
                    "stuck - restarting it clears a wedged one."
                ) from exc
            except httpx.HTTPError as exc:
                # Connect errors carry an address at best and "" at worst.
                raise GenerationError(
                    f"could not reach the local LLM server at {self.chat_base}: "
                    f"{exc or type(exc).__name__}"
                ) from exc
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
                    f"the local model stopped at the {body['max_tokens']}-token output cap before "
                    "finishing — the response is incomplete. Try a shorter target duration, "
                    "or a model with a larger output limit."
                )
            return text

    async def _thinking(self, model: str) -> str | None:
        """Whether `model` thinks before it answers, and whether it can be
        asked not to: "stoppable", "unstoppable", or None when it does not
        think or the server cannot say.

        It matters because the thinking is generated output. Ollama runs
        thinking models with thinking on by default, on the OpenAI-compatible
        endpoint too, and passes `max_tokens` to the runner as the limit on
        everything generated, thinking included, while none of the thinking
        reaches `content`. qwen3:8b spent 3845 tokens to return 470 of
        screenplay, and on another ask ran out at the 4096 cap with no
        screenplay at all. Every caller here wants JSON and nothing else, so
        none of them needs the thinking.

        Ollama's `/api/show` lists "thinking" among a model's capabilities,
        and from 0.34.3 says in `thinking.values` whether false is accepted.
        When it is, `reasoning_effort: "none"` turns thinking off (Ollama maps
        it to think=false). When it is not, or the server predates the field
        and so cannot say whether "none" would be accepted, the model thinks
        and the cap is raised to leave room for the answer. llama.cpp and the
        other OpenAI-compatible servers serve no `/api/show`, so they get the
        plain request they already accept.
        """
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(f"{self.root_url}/api/show", json={"model": model})
            if response.status_code != 200:
                return None
            shown = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        if not isinstance(shown, dict) or "thinking" not in (shown.get("capabilities") or []):
            return None
        controls = shown.get("thinking")
        values = controls.get("values") if isinstance(controls, dict) else None
        if isinstance(values, list) and False in values:
            return "stoppable"
        return "unstoppable"

    async def _unload(self, model: str) -> None:
        """Best-effort VRAM release via Ollama's native API; llama.cpp and
        other OpenAI-compatible servers simply 404 and are ignored. Takes the
        model that was actually loaded — releasing the configured default
        instead would leave a picked model resident, which is the whole point
        of the yield."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{self.root_url}/api/generate",
                    json={"model": model, "keep_alive": 0},
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
