"""Natural-language editing — LLM-generated graph patches.

The LLM never mutates the graph. It receives a scoped, whitelisted view of
the editable nodes plus the user's instruction, and returns a constrained
edit plan; `compile_edits` validates every part of that plan against the
live graph and compiles it into ordinary PatchOps. The same `apply_patch`
codepath that serves the inspector UI applies them, so a natural-language
edit is exactly a manual edit with the typing done by a model.

Whitelists gate both directions: the view only shows params the LLM may
touch, and the compiler drops anything outside them (unknown nodes, pinned
nodes, foreign keys, malformed values) with a warning instead of failing
the whole edit. On-screen text is edited through the timeline's `overlays`
(presentation-time data — assembly reads it there, and editing a title must
not re-render the clip). Narrative restructuring beyond removing a scene is
out of scope by design: that is a script regeneration, which re-derives the
whole cast of scenes from a new screenplay.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..aspects import (
    EXPORT_AUDIO_KBPS_BOUNDS,
    EXPORT_FPS_CHOICES,
    EXPORT_SHORT_SIDE_CHOICES,
    EXPORT_USER_PARAMS,
    EXPORT_VIDEO_KBPS_BOUNDS,
)
from ..backends.kokoro import VOICE_ID_PATTERN
from .model import NodeKind, StoryGraph, scene_sort_key
from .templates import DEFAULT_CLIP_S, MAX_CLIP_S
from .patch import PatchOp

# Params the LLM may see and set, per node kind. Aspect and format params are
# deliberately absent (project-wide, validated at project creation), as is the
# script node (editing it re-runs the LLM and re-derives every scene).
EDITABLE_PARAMS: dict[NodeKind, frozenset[str]] = {
    NodeKind.KEYFRAME: frozenset({"prompt"}),
    NodeKind.CLIP: frozenset({"prompt", "motion", "duration_s"}),
    NodeKind.NARRATION: frozenset({"text", "voice", "speed", "voice_id"}),
    NodeKind.MUSIC: frozenset({"brief"}),
    NodeKind.THUMBNAIL: frozenset({"prompt"}),
    NodeKind.TIMELINE: frozenset(
        {"order", "trims", "transitions", "overlays", "ducking", "beat_align"}
    ),
    # The same set expand_screenplay carries across a re-expansion: what the
    # user owns on the export node is exactly what a plan may set.
    NodeKind.EXPORT: EXPORT_USER_PARAMS,
}

_TRANSITIONS = {"cut", "crossfade", "dip"}
_CAPTION_MODES = {"burn", "sidecar"}
_MAX_TEXT = 2000
_MAX_OVERLAY = 200
_CLIP_MIN_S, _CLIP_MAX_S = 1.0, 15.0
_SPEED_MIN, _SPEED_MAX = 0.5, 1.5
# A pack voice id, the shape /voices enumerates. Bounded on this path
# because it is persisted onto the node and reaches the backend as a lookup
# key, and the model writing it is told no vocabulary — the same reason
# ToolRequest bounds `model`, and the same editor-only reach `speed` and
# `text` have. Membership in the pack is the backend's to answer, which it
# does at render; this only keeps a path fragment or a novel out of the
# shape of a voice.
_VOICE_ID_RE = re.compile(VOICE_ID_PATTERN)

SUGGEST_SCENE_SYSTEM_PROMPT = """You are helping build one scene of a short video from a \
picture the user just supplied. You are told what the video is about, what the scenes before \
this one say, and how long this scene runs; you are also shown the image itself. Respond with \
JSON only (no markdown fences), in this exact shape:
{"narration": str, "prompt": str}
Rules:
- "narration" is what the voice says over this scene. Write it to be spoken aloud, in the \
voice and tense the project's existing narration already uses.
- Write the narration in the language the project's existing narration is written in (for the \
first scene with words, the language the video's description is written in). Never switch \
language partway through, not even for the last few words of a sentence.
- Write narration to the word count you are given. That count IS the scene's length: the \
narration is spoken and the clip runs as long as the speech, so a handful of words makes a \
scene that is over before it is seen.
- Write a complete sentence. Never continue or complete a sentence from an earlier scene.
- "prompt" describes the shot for a video model that will ANIMATE this exact image. Describe \
what is in the picture and how it should move; do not invent a different subject.
- The scene is ONE continuous shot of this picture: one camera movement through it, never a \
cut, a transition, a split screen or a montage, and never words drawn into the frame. Describe \
only what is in the frame, never what is absent from it.
- Match the established visual style of the project's other scenes.
- Return the two keys and nothing else."""

# Two short strings. A cap this size is generous for them and still bounds a
# model that decides to explain itself at length on the user's key.
SUGGEST_SCENE_MAX_TOKENS = 1024

# How many of the preceding scenes' lines to quote. Enough to establish a
# voice and to show where the script had got to; not so many that a long
# project buries the picture, which is the thing actually being described.
_SUGGEST_SCENE_RECENT = 3


def typical_clip_s(durations: list[float]) -> float:
    """How long a scene added on its own should run, from what the project
    already does.

    A flat constant writes a line measured against a scene the project would
    never have made: a 30s explainer cut from six 5s beats and a 90s piece
    built from 12s ones want different lengths from a picture dropped into
    them. Median rather than mean — one deliberately long establishing shot
    should not stretch every scene added after it.
    """
    if not durations:
        return DEFAULT_CLIP_S
    ordered = sorted(durations)
    return min(MAX_CLIP_S, max(1.0, ordered[len(ordered) // 2]))


def _narration_lines(view: dict) -> list[str]:
    """Every narration line the project's scenes already speak, in order."""
    return [
        text
        for scene in view.get("scenes") or []
        for node in scene.get("nodes") or []
        if node.get("kind") == "narration"
        for text in [str(node.get("params", {}).get("text") or "").strip()]
        if text
    ]


def language_sample(view: dict) -> str:
    """The project's own words, which a suggestion's letters are held to.

    The narration already written when there is any, because that is what
    the new line will be heard beside, whatever language the brief was typed
    in. Before there is any, the description the user typed for the video:
    the only words of theirs such a project holds, and the language they
    asked in. Empty when there is neither, and an empty sample holds a
    suggestion to nothing (see `foreign_letters`).
    """
    said = _narration_lines(view)
    if said:
        return "\n".join(said)
    return str((view.get("brief") or {}).get("prompt") or "")


# Han and both kana count as one writing system, because Japanese writes all
# three in a single sentence: a project whose earlier lines happened to use no
# katakana must still take a line that does. Bopomofo is the phonetic script
# Chinese is annotated in. Hangul stays apart, since modern Korean prose is
# written in Hangul alone and Han characters in a Korean project are the switch.
_SAME_SYSTEM = {"HIRAGANA": "CJK", "KATAKANA": "CJK", "IDEOGRAPHIC": "CJK", "BOPOMOFO": "CJK"}


def _systems_of(char: str) -> set[str]:
    """The writing system a character's letters belong to; empty for anything
    that is not a letter.

    Only letters carry a language. Punctuation, digits, symbols and emoji are
    shared across writing systems (an English line can end in "。" or carry
    "✨" without being in another language), so they never count. Modifier
    letters are left out with them: the length mark in カード and the repeat
    mark in 時々 only ever stand beside letters of their own system, while
    `ʼ` turns up in plain English transliteration.

    The system is the first word of the letter's Unicode name, which is how
    the standard spells it: LATIN SMALL LETTER A, CYRILLIC SMALL LETTER A,
    CJK UNIFIED IDEOGRAPH-7684. NFKC folds presentation variants (fullwidth
    Latin, halfwidth katakana, mathematical bold) onto the letters they stand
    for first, and only a letter is folded, so a symbol whose compatibility
    form spells words (㍿, ™) stays a symbol.
    """
    category = unicodedata.category(char)
    if not category.startswith("L") or category == "Lm":
        return set()
    systems = set()
    for folded in unicodedata.normalize("NFKC", char):
        category = unicodedata.category(folded)
        if category.startswith("L") and category != "Lm":
            word = unicodedata.name(folded, "").split(" ", 1)[0]
            if word:
                systems.add(_SAME_SYSTEM.get(word, word))
    return systems


# Writing systems no project's text is held against. Latin is the one other
# languages' prose borrows as a matter of course, for names, acronyms and
# units ("AI" in a Japanese line, "km" in a Russian one), and a shot
# description is English in every project because English is what image and
# video models read. Greek letters stand as symbols in any language's science
# and maths (π, Δ, and µ, which NFKC folds onto Greek mu). What this lets
# through is a drift INTO Latin or Greek prose, and that is not the failure
# being caught: a model whose training leans on another language finishing
# an English sentence in it.
_SHARED_SYSTEMS = frozenset({"LATIN", "GREEK"})


def foreign_letters(text: str, sample: str) -> str:
    """The letters in `text` from a writing system `sample` does not use (and
    not one of `_SHARED_SYSTEMS`), each once and in order of appearance.
    Empty when there are none.

    A sample with no letters at all holds `text` to nothing. With no words
    of the user's to go on there is no language to keep to, and assuming one
    would refuse the user's own.
    """
    known = set().union(*map(_systems_of, sample))
    if not known:
        return ""
    known |= _SHARED_SYSTEMS
    return "".join(dict.fromkeys(char for char in text if _systems_of(char) - known))


def suggest_scene_prompt(view: dict, seconds: float | None = None) -> str:
    """What to ask for one new scene built on a picture.

    A JSON dump of the whole graph was what this used to send, and it asked a
    model to do three jobs at once: parse a machine format, infer the video's
    subject from a `brief` key buried in it, and guess how much to write. The
    smaller local models the vision path exists to use did the first badly and
    the third not at all — the narration came back as a five-word fragment
    continuing a sentence from a scene it had half-read.

    So the context is spelled out instead: what the video is about, the last
    few lines in the voice the new one has to match, and a word budget derived
    from the length this scene will actually run. Narration is what sets that
    length (the clip runs as long as the speech), so the budget is not a style
    note — it is the scene's duration, stated in the only unit the model can
    act on.
    """
    parts: list[str] = []
    brief = view.get("brief") or {}
    topic = brief.get("prompt")
    if topic:
        parts.append(f"The video is about: {topic}")
    style = brief.get("style_preset")
    if style:
        parts.append(f"Visual style: {style}")
    total = brief.get("target_duration_s")
    if total:
        parts.append(f"The finished video runs about {total} seconds.")

    nodes = [node for scene in view.get("scenes") or [] for node in scene.get("nodes") or []]
    if seconds is None:
        seconds = typical_clip_s(
            [
                float(value)
                for node in nodes
                if node.get("kind") == "clip"
                for value in [node.get("params", {}).get("duration_s")]
                if isinstance(value, int | float)
            ]
        )

    # The narration already written, in order, so the new line continues a
    # voice rather than inventing one.
    said = _narration_lines(view)
    if said:
        recent = said[-_SUGGEST_SCENE_RECENT:]
        lines = "\n".join(f"- {line}" for line in recent)
        parts.append(f"The scenes before this one say:\n{lines}")
        parts.append("Your new scene comes after those. Do not repeat what they already said.")
        # Pointed at the lines rather than named: nothing here knows what
        # language a project is in, only what its narration looks like.
        parts.append(
            "Write your narration in the same language as those lines, from first word to last."
        )
    else:
        parts.append("This is the first scene with words, so the narration sets the voice.")
        if topic:
            parts.append(
                "Write it in the language the description of the video above is written in."
            )

    # Imported here, not at module scope: `backends.llm` pulls httpx and the
    # ffmpeg timing constants, which a graph module has no business loading
    # to reach one arithmetic helper. The helper is the point — it is the
    # same speech rate the script writer is held to, so a scene added this
    # way is measured the way every other scene is.
    from ..backends.llm import narration_word_budget

    # The length the scene needs, floored by what this project actually
    # writes. A five-second default asks for thirteen words, which next to
    # scenes carrying forty reads as a caption dropped into a script — and
    # narration is what sets a scene's runtime, so matching the project's own
    # density is what makes the new scene sit at the same pace as the rest.
    words = narration_word_budget(seconds)
    if said:
        lengths = sorted(len(line.split()) for line in said)
        words = max(words, lengths[len(lengths) // 2])
    parts.append(
        f"This scene runs about {seconds:.0f} seconds. Write about {words} words of narration "
        f"— complete sentences, the same length and depth as the lines above."
    )
    parts.append(
        "Start a new sentence with its own subject. Do not begin with a word that only makes "
        "sense as the continuation of the previous scene's line."
    )
    parts.append("Write the narration and the visual prompt for one new scene built on the image.")
    return "\n\n".join(parts)


class SceneSuggestion(BaseModel):
    """The two fields `add_scene` leaves blank, and the compiler needs."""

    model_config = ConfigDict(extra="ignore")

    narration: str = Field(min_length=1, max_length=_MAX_TEXT)
    prompt: str = Field(min_length=1, max_length=_MAX_TEXT)


# How many of the stray letters a refusal quotes. Enough to recognise what
# the model switched into, not a paragraph of it.
_STRAY_QUOTED = 12


def parse_scene_suggestion(raw: str, sample: str = "") -> dict:
    """LLM output → the two strings. Raises ValueError on anything unusable.

    Same fence-stripping as `parse_edit_plan`: models emit ```json blocks
    however firmly the system prompt asks them not to. Validated rather than
    passed through, because these two strings go straight into a patch.

    `sample` is the project's own words (`language_sample`). A suggestion
    that slips into a writing system they do not use is unusable in the
    same way bad JSON is: an English voice reads each CJK character aloud as
    "Chinese letter", and the captions burn the characters onto the cut. It
    is refused rather than repaired, because the route's caller can simply
    ask again and nothing here can say what the stray clause meant.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1].removeprefix("json").strip()
    try:
        suggestion = SceneSuggestion.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ValueError(f"the model returned an unusable scene suggestion: {exc}") from exc
    # Named the way the dialog labels the two fields.
    for field, label in (("narration", "narration"), ("prompt", "shot description")):
        stray = foreign_letters(getattr(suggestion, field), sample)
        if stray:
            raise ValueError(
                f"the model's {label} switched to a writing system this project is not "
                f"written in ({stray[:_STRAY_QUOTED]}). Ask again for another suggestion."
            )
    return suggestion.model_dump()


EDIT_SYSTEM_PROMPT = """You are a video project editor operating on a scene graph. You receive a \
JSON view of a project's editable nodes and an instruction. Respond with JSON only (no markdown \
fences), in this exact shape:
{"summary": str, "edits": [
  {"action": "update", "node_id": str, "params": {key: value}},
  {"action": "remove_scene", "scene_id": str}
]}
Rules:
- Only change what the instruction asks for; leave everything else alone.
- "summary" says in a few words what your edits change. Describe only the edits you return, \
and never state a count (words, seconds, scenes) you have not counted in them.
- params keys must come from the node's own params shown in the view.
- keyframe/clip "prompt" values are image/video generation prompts; keep the established \
visual style unless asked to change it. "motion" is a short camera direction.
- each scene renders as ONE continuous shot: one picture, then animated. A keyframe/clip \
"prompt" is one moment in one frame, never a split screen, collage, montage, picture-in-picture \
or sequence of shots, and never words drawn into the picture. "motion" is one camera movement, \
never a cut or a transition. Describe only what is in the frame, never what is absent from it.
- narration "text" is spoken aloud. The video's length follows narration length, so to make \
the video shorter, shorten narration text or remove scenes. narration "speed" is the speech \
rate (1.0 normal, 0.5-1.5).
- narration "voice" is a free-text style brief ("warm female narrator") and is what to edit \
when the instruction describes a voice. narration "voice_id" names one exact speaker in the \
installed voice pack and overrides the brief; only ever copy a voice_id already shown in the \
view, never invent or guess one, because an id the pack does not hold fails the render.
- on-screen text lives in the timeline node's "overlays" (scene id -> text), not on clips.
- the timeline's "order" lists scene ids in play order; "transitions" maps a scene id to the \
transition out of that scene: one of cut, crossfade, dip; "trims" maps a scene id to \
{"in": seconds, "out": seconds} of the source clip; "ducking" (bool, default true) dips the \
music under narration; "beat_align" (bool) snaps scene cuts to the music's beat.
- the export node: "captions" is burn or sidecar; "fps" one of 24/25/30/50/60; "resolution" \
the frame's short side (480/720/1080); "video_kbps"/"audio_kbps" encode bitrates.
- never edit nodes marked "pinned": true — the user locked them.
- remove_scene only when the instruction clearly asks for removal or shortening.
- If nothing applies, return {"summary": "why", "edits": []}."""


class Edit(BaseModel):
    action: Literal["update", "remove_scene"]
    node_id: str | None = None
    scene_id: str | None = None
    params: dict[str, Any] | None = None


class EditPlan(BaseModel):
    summary: str = ""
    edits: list[Edit] = Field(default_factory=list)


def parse_edit_plan(raw: str) -> EditPlan:
    """LLM output → EditPlan. Raises ValueError on anything unusable."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1].removeprefix("json").strip()
    try:
        return EditPlan.model_validate(json.loads(text))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ValueError(f"the model returned an unusable edit plan: {exc}") from exc


def _scene_ids(graph: StoryGraph) -> list[str]:
    return sorted({n.split(".")[0] for n in graph.nodes if "." in n}, key=scene_sort_key)


def graph_view(graph: StoryGraph, scope: str = "project") -> dict:
    """The editable view the LLM sees: whitelisted params only, grouped by
    scene. Scope is "project" (everything) or a scene id (that scene's
    members only). Raises KeyError for an unknown scene."""

    def node_view(node_id: str) -> dict:
        node = graph.nodes[node_id]
        allowed = EDITABLE_PARAMS.get(node.kind, frozenset())
        view: dict = {
            "node_id": node.id,
            "kind": node.kind.value,
            "params": {k: v for k, v in node.params.items() if k in allowed},
        }
        if node.pinned:
            view["pinned"] = True
        return view

    scene_ids = _scene_ids(graph)
    if scope != "project":
        if scope not in scene_ids:
            raise KeyError(scope)
        scene_ids = [scope]

    view: dict = {
        "scope": scope,
        "scenes": [
            {
                "scene_id": sid,
                "nodes": [node_view(n) for n in sorted(graph.nodes) if n.startswith(f"{sid}.")],
            }
            for sid in scene_ids
        ],
    }
    if scope == "project":
        script = graph.nodes.get("script")
        if script is not None:
            view["brief"] = {
                k: script.params[k]
                for k in ("prompt", "target_duration_s", "style_preset")
                if k in script.params
            }
        for node_id in ("music", "timeline", "export", "thumbnail"):
            if node_id in graph.nodes:
                view[node_id] = node_view(node_id)
    view["revision"] = graph_revision(graph, scope)
    return view


_DROP = object()


def _clean_text(value: Any, limit: int, warnings: list[str], label: str) -> Any:
    if value is None:
        return _DROP
    # str() on a list/dict would write a Python repr into the node — spoken
    # aloud by TTS and, since captions anchor to narration text, burned onto
    # the screen. Every other clause rejects non-scalars; so does this one.
    if not isinstance(value, str | int | float | bool):
        warnings.append(f"{label}: expected text")
        return _DROP
    text = str(value).strip()
    if not text:
        warnings.append(f"{label}: empty value dropped")
        return _DROP
    return text[:limit]


def _sanitize(  # noqa: PLR0911 — one clause per param family
    kind: NodeKind, key: str, value: Any, scene_ids: set[str], warnings: list[str]
) -> Any:
    label = f"{kind.value}.{key}"
    if kind is NodeKind.CLIP and key == "duration_s":
        try:
            return min(_CLIP_MAX_S, max(_CLIP_MIN_S, float(value)))
        except (TypeError, ValueError):
            warnings.append(f"{label}: not a number")
            return _DROP
    if kind is NodeKind.NARRATION and key == "voice_id":
        # fullmatch, not match: `$` would also accept a trailing newline.
        if isinstance(value, str) and _VOICE_ID_RE.fullmatch(value):
            return value
        warnings.append(f"{label}: not a voice id")
        return _DROP
    if kind is NodeKind.NARRATION and key == "speed":
        try:
            return min(_SPEED_MAX, max(_SPEED_MIN, float(value)))
        except (TypeError, ValueError):
            warnings.append(f"{label}: not a number")
            return _DROP
    if kind is NodeKind.TIMELINE and key in ("ducking", "beat_align"):
        if isinstance(value, bool):
            return value
        if value in ("true", "false"):
            return value == "true"
        warnings.append(f"{label}: must be true or false")
        return _DROP
    if kind is NodeKind.EXPORT and key == "captions":
        # `value in _CAPTION_MODES` hashes value — a list/dict from the model
        # would raise TypeError (which nothing catches, 500ing /edit), so gate
        # on str first, exactly like the transitions branch below.
        if isinstance(value, str) and value in _CAPTION_MODES:
            return value
        warnings.append(f"{label}: must be one of {sorted(_CAPTION_MODES)}")
        return _DROP
    if kind is NodeKind.EXPORT and key in ("fps", "resolution"):
        choices = EXPORT_FPS_CHOICES if key == "fps" else EXPORT_SHORT_SIDE_CHOICES
        try:
            if not isinstance(value, bool) and int(float(value)) in choices:
                return int(float(value))
        except (TypeError, ValueError):
            pass
        warnings.append(f"{label}: must be one of {list(choices)}")
        return _DROP
    if kind is NodeKind.EXPORT and key in ("video_kbps", "audio_kbps"):
        lo, hi = EXPORT_VIDEO_KBPS_BOUNDS if key == "video_kbps" else EXPORT_AUDIO_KBPS_BOUNDS
        try:
            if isinstance(value, bool):
                raise TypeError
            return min(hi, max(lo, int(float(value))))
        except (TypeError, ValueError):
            warnings.append(f"{label}: not a number")
            return _DROP
    if kind is NodeKind.TIMELINE:
        if key == "order":
            if not isinstance(value, list):
                warnings.append(f"{label}: not a list")
                return _DROP
            order = [s for s in dict.fromkeys(map(str, value)) if s in scene_ids]
            return order or _DROP
        if not isinstance(value, dict):
            warnings.append(f"{label}: not an object")
            return _DROP
        clean: dict[str, Any] = {}
        for sid, entry in value.items():
            if sid not in scene_ids:
                warnings.append(f"{label}: unknown scene {sid!r}")
                continue
            if key == "transitions":
                # `entry in _TRANSITIONS` hashes entry — a list/dict from the
                # model would raise TypeError, so gate on str first.
                if isinstance(entry, str) and entry in _TRANSITIONS:
                    clean[sid] = entry
                else:
                    warnings.append(f"{label}[{sid}]: must be one of {sorted(_TRANSITIONS)}")
            elif key == "trims":
                if not isinstance(entry, dict):
                    warnings.append(f"{label}[{sid}]: must be an object with in/out")
                    continue
                try:
                    trim = {k: max(0.0, float(entry[k])) for k in ("in", "out") if entry.get(k)}
                except (TypeError, ValueError):
                    warnings.append(f"{label}[{sid}]: in/out must be seconds")
                    continue
                if trim:
                    clean[sid] = trim
            else:  # overlays — None clears a title, a scalar sets it
                if entry is None:
                    clean[sid] = None
                elif isinstance(entry, (str, int, float)) and not isinstance(entry, bool):
                    clean[sid] = str(entry)[:_MAX_OVERLAY]
                else:
                    # A list/dict would str()-coerce to a Python repr burned
                    # verbatim on screen — drop it like the other branches do.
                    warnings.append(f"{label}[{sid}]: on-screen text must be text")
        return clean or _DROP
    # Everything else on the whitelist is prose (prompts, narration, briefs).
    return _clean_text(value, _MAX_TEXT, warnings, label)


_TIMELINE_MAPS = ("overlays", "trims", "transitions")


def scrub_removed(params: dict, removed: set[str]) -> dict:
    """Timeline params with every reference to the removed scenes dropped.

    Public because the `remove_scene` patch op compiles to the same thing:
    a scene removed from the board and a scene removed by the NL editor
    must leave the cut in the same state, and two implementations of "drop
    the references" is how one of them keeps a dangling id in `order`."""
    scrubbed: dict[str, Any] = {}
    if isinstance(order := params.get("order"), list):
        scrubbed["order"] = [s for s in order if s not in removed]
    for key in _TIMELINE_MAPS:
        if isinstance(entries := params.get(key), dict):
            scrubbed[key] = {s: v for s, v in entries.items() if s not in removed}
    return scrubbed


def _merge_timeline(existing: dict, updates: dict) -> dict:
    """Fold the plan's timeline edits onto the live timeline params PER SCENE.
    set_params replaces a whole key, so a plan touching one scene's overlay
    must carry the others' forward or they vanish; a null overlay clears just
    that scene. `order` is a full-list replacement (already sanitized)."""
    merged: dict[str, Any] = {}
    for key, value in updates.items():
        if key in _TIMELINE_MAPS and isinstance(value, dict):
            base = dict(existing.get(key) or {})
            for sid, entry in value.items():
                if key == "overlays" and entry is None:
                    base.pop(sid, None)  # clear this title only
                else:
                    base[sid] = entry
            merged[key] = base
        else:
            merged[key] = value
    return merged


def graph_revision(graph: StoryGraph, scope: str = "project") -> str:
    """A short digest of the SCENE nodes an edit is compiled against. The race
    it guards is a background script job re-expanding the graph (which
    renumbers scenes positionally) between view and apply; that rewrites scene
    content, so hashing the in-scope scene members catches it. It deliberately
    excludes the timeline/script/music/export nodes so an unrelated concurrent
    param write (e.g. a debounced trim flush) can't false-409 the edit."""
    import hashlib

    members = [
        (nid, node)
        for nid, node in graph.nodes.items()
        if "." in nid and (scope == "project" or nid.startswith(f"{scope}."))
    ]
    payload = sorted(
        (nid, node.kind.value, json.dumps(node.params, sort_keys=True, default=str))
        for nid, node in members
    )
    return hashlib.sha256(json.dumps(payload).encode()).hexdigest()[:16]


def compile_edits(
    graph: StoryGraph, plan: EditPlan, scope: str = "project"
) -> tuple[list[PatchOp], list[str]]:
    """Validate an LLM edit plan against the live graph and compile it to
    PatchOps. Invalid parts are dropped with a warning — a partially wrong
    plan still applies its good edits rather than failing outright."""
    warnings: list[str] = []
    scene_ids = set(_scene_ids(graph))
    removed: set[str] = set()
    updates: dict[str, dict[str, Any]] = {}
    timeline_pinned = "timeline" in graph.nodes and graph.nodes["timeline"].pinned

    for edit in plan.edits:
        if edit.action == "remove_scene":
            sid = edit.scene_id or ""
            if scope != "project":
                warnings.append(f"remove_scene {sid!r}: only allowed at project scope")
            elif sid not in scene_ids:
                warnings.append(f"remove_scene: unknown scene {sid!r}")
            elif len(scene_ids - removed - {sid}) < 1:
                warnings.append(f"remove_scene {sid!r}: cannot remove the only remaining scene")
            elif any(graph.nodes[n].pinned for n in graph.nodes if n.startswith(f"{sid}.")):
                # remove_scene must honor pins exactly like update does — a
                # locked scene isn't silently deleted by an edit.
                warnings.append(f"remove_scene {sid!r}: scene has a pinned node")
            elif timeline_pinned:
                # Removing a scene means editing the timeline to drop its
                # references; a pinned timeline serves a frozen EDL, so the
                # removal would delete the nodes yet leave the cut unchanged.
                # Refuse rather than apply a no-op-but-destructive edit.
                warnings.append(f"remove_scene {sid!r}: unpin the timeline to remove scenes")
            else:
                removed.add(sid)
            continue
        node = graph.nodes.get(edit.node_id or "")
        if node is None:
            warnings.append(f"update: unknown node {edit.node_id!r}")
            continue
        if scope != "project" and not node.id.startswith(f"{scope}."):
            warnings.append(f"update {node.id}: outside the {scope!r} scope")
            continue
        if node.pinned:
            warnings.append(f"update {node.id}: node is pinned")
            continue
        allowed = EDITABLE_PARAMS.get(node.kind, frozenset())
        clean: dict[str, Any] = {}
        for key, value in (edit.params or {}).items():
            if key not in allowed:
                warnings.append(f"update {node.id}: {key!r} is not editable")
                continue
            sane = _sanitize(node.kind, key, value, scene_ids, warnings)
            if sane is not _DROP:
                clean[key] = sane
        if clean:
            updates.setdefault(node.id, {}).update(clean)

    ops: list[PatchOp] = []
    for node_id, params in updates.items():
        if node_id.split(".")[0] in removed:
            warnings.append(f"update {node_id}: scene is being removed")
        elif node_id != "timeline":  # timeline merges with removal scrubbing below
            ops.append(PatchOp(op="set_params", node_id=node_id, params=params))
    for sid in sorted(removed, key=scene_sort_key):
        ops.extend(
            PatchOp(op="remove_node", node_id=member)
            for member in sorted(n for n in graph.nodes if n.startswith(f"{sid}."))
        )
    existing_timeline = graph.nodes["timeline"].params if "timeline" in graph.nodes else {}
    # Per-scene merge so a plan touching one scene's overlay/trim/transition
    # doesn't wipe the others (set_params replaces a whole key).
    timeline_params = _merge_timeline(existing_timeline, updates.get("timeline") or {})
    if removed and "timeline" in graph.nodes:
        # Scrub after the plan's own timeline edits so a reorder that also
        # removes a scene doesn't resurrect it from the pre-edit params.
        merged = {**existing_timeline, **timeline_params}
        timeline_params.update(scrub_removed(merged, removed))
    if timeline_params:
        if "timeline" in graph.nodes and graph.nodes["timeline"].pinned:
            # A pinned timeline serves its frozen EDL; scrubbing its params
            # would only diverge saved state from render. Leave it be.
            warnings.append("timeline is pinned; skipped timeline edits")
        else:
            ops.append(PatchOp(op="set_params", node_id="timeline", params=timeline_params))
    return ops, warnings


# -- what an edit does, in words ----------------------------------------------
#
# The model writes a summary beside its plan, and that summary is a claim
# about the plan, not a reading of it. qwen3:8b called a cut from 207 words
# to 100 "Trimmed narration to 160 words", and plans whose every edit was
# refused still read "adjusted music volume under narration". What Apply
# lands is the compiled ops, so what the user reads is built from them: one
# line per change, and a headline. The model's sentence is the headline only
# when nothing in it can be shown wrong against those ops; otherwise the
# headline comes from the ops and the model's sentence is quoted with what
# it got wrong.

# How much of a prompt or an on-screen title a change line quotes.
_QUOTED = 60

# Claims a summary makes about counts and scenes. `_claim_problems` checks a
# count against the real ones with some slack: models round, and a count that
# comes near a real one is not the misreport being caught.
_WORDS_CLAIM = re.compile(r"\b(\d+(?:\.\d+)?)[\s-]*words?\b", re.IGNORECASE)
_SECONDS_CLAIM = re.compile(r"\b(\d+(?:\.\d+)?)[\s-]*(?:s|secs?|seconds?)\b", re.IGNORECASE)
_SCENE_REF = re.compile(r"\bscenes?\s+(\d+(?:\s*(?:,|and|&|to|through|-)\s*\d+)*)", re.IGNORECASE)
_REMOVAL_WORDS = re.compile(r"\b(?:remov|delet|drop|cut)", re.IGNORECASE)
_EVERY_SCENE = re.compile(r"\b(?:each|every|all(?: the)?|all \d+) scenes?\b", re.IGNORECASE)
# The words before a subject that make it a place rather than a thing changed.
_PLACE = re.compile(r"\b(?:under|over|beneath|below|above|behind|against|during)\s+(?:the\s+)?$")

# What a summary may say it changed, and which changes bear that out. A
# subject the summary names and no change touches is a claim the edit does
# not make. Generous on purpose, because a false mismatch replaces a true
# sentence: "voice" is satisfied by a speed change too, and a subject named
# only as where something happens ("the music under the narration") is not
# a claim about it at all (see `_PLACE`). The narration is left to the word
# and second counts below, which check it more closely than a word can.
_SUBJECTS: tuple[tuple[re.Pattern[str], frozenset[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), frozenset(subjects), what)
    for pattern, subjects, what in (
        (r"\bmusic\b|\bsoundtrack\b", {"music", "ducking", "beat"}, "the music"),
        (r"\bvolume\b|\bquieter\b|\blouder\b", {"ducking"}, "the volume"),
        (r"\bvoices?\b|\bspeakers?\b", {"voice", "speed"}, "the voice"),
        (r"\bspeed\b|\bspeech rate\b", {"speed"}, "the speech speed"),
        (r"\bcaptions?\b|\bsubtitles?\b", {"captions"}, "the captions"),
        (r"\btransitions?\b|\bcross-?fades?\b|\bdissolves?\b", {"transitions"}, "the transitions"),
        (r"\bon-?screen\b|\boverlays?\b|\btitles?\b", {"overlays"}, "the on-screen text"),
        (r"\breorder|\bscene order\b|\bswap", {"order"}, "the scene order"),
        (
            r"\bimages?\b|\bpictures?\b|\bkeyframes?\b|\bvisuals?\b|\bstills?\b",
            {"picture", "shot", "thumbnail"},
            "the pictures",
        ),
        (r"\bcamera\b|\bmotion\b|\bpans?\b|\bzoom", {"motion", "shot"}, "the camera movement"),
        (r"\bframe rate\b|\bfps\b|\bresolution\b|\bbitrate\b", {"export"}, "the export settings"),
        (r"\bthumbnail", {"thumbnail"}, "the thumbnail"),
    )
)


@dataclass(frozen=True)
class _Change:
    subject: str
    line: str
    scenes: frozenset[str] = frozenset()


def _scene_number(scene_id: str) -> str:
    tail = scene_id[1:]
    return tail if scene_id.startswith("s") and tail.isdigit() else scene_id


def _scene_label(scene_id: str) -> str:
    return f"Scene {_scene_number(scene_id)}"


def _scene_list(scene_ids: list[str]) -> str:
    """The scenes in words, in scene order: scene 2, or scenes 2, 3 and 5."""
    numbers = [_scene_number(sid) for sid in sorted(scene_ids, key=scene_sort_key)]
    if len(numbers) == 1:
        return f"scene {numbers[0]}"
    return f"scenes {', '.join(numbers[:-1])} and {numbers[-1]}"


def _joined(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def _quote(value: Any) -> str:
    text = " ".join(str(value).split())
    if len(text) > _QUOTED:
        text = text[: _QUOTED - 3].rstrip() + "..."
    return f'"{text}"'


def _word_count(value: Any) -> int:
    return len(str(value or "").split())


def _narration_by_scene(graph: StoryGraph) -> dict[str, str]:
    return {
        node_id.removesuffix(".narration"): str(node.params.get("text") or "")
        for node_id, node in graph.nodes.items()
        if node.kind is NodeKind.NARRATION and node_id.endswith(".narration")
    }


def _number(value: Any) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return str(value)


def _timeline_changes(
    graph: StoryGraph, key: str, old: Any, new: Any, removed: set[str]
) -> list[_Change]:
    if key == "order":
        # The order a timeline without one plays in, less what the same
        # edit removes: a removal is reported as a removal, not a reorder.
        before = [s for s in (old or _scene_ids(graph)) if s not in removed]
        after = list(new or [])
        if after == before:
            return []
        moved = frozenset(s for i, s in enumerate(after) if i >= len(before) or before[i] != s)
        numbers = ", ".join(_scene_number(s) for s in after)
        return [_Change(subject="order", scenes=moved, line=f"Scene order: {numbers}")]
    if key in _TIMELINE_MAPS:
        old_map = {s: v for s, v in (old or {}).items() if s not in removed}
        new_map = dict(new or {})
        changes: list[_Change] = []
        for sid in sorted(set(old_map) | set(new_map), key=scene_sort_key):
            was, now = old_map.get(sid), new_map.get(sid)
            if was == now:
                continue
            label = _scene_label(sid)
            if key == "transitions":
                line = f"Transition after {label.lower()}: {now or 'cut'}"
            elif key == "trims":
                spans = ", ".join(f"{k} {_number(v)} s" for k, v in (now or {}).items())
                line = f"{label} trim: {spans}" if spans else f"{label} trim removed"
            elif now is None:
                line = f"{label} on-screen text removed"
            else:
                line = f"{label} on-screen text: {_quote(now)}"
            changes.append(_Change(subject=key, scenes=frozenset({sid}), line=line))
        return changes
    if key == "ducking":
        # On unless a plan turned it off: the editor's own prompt calls true
        # the default.
        if bool(new) == (old is None or bool(old)):
            return []
        line = "Music dips under the narration" if new else "Music stays level under the narration"
        return [_Change(subject="ducking", line=line)]
    if key == "beat_align":
        if bool(new) == bool(old):
            return []
        line = "Cuts land on the music's beat" if new else "Cuts no longer follow the music's beat"
        return [_Change(subject="beat", line=line)]
    return [_Change(subject="other", line=f"Timeline {key} changed")]


def _export_change(key: str, old: Any, new: Any) -> _Change:
    if key == "captions":
        line = (
            "Captions burned into the picture"
            if new == "burn"
            else "Captions as a separate subtitle file"
        )
        return _Change(subject="captions", line=line)
    label, unit = {
        "fps": ("Frame rate", " fps"),
        "resolution": ("Resolution", "p"),
        "video_kbps": ("Video bitrate", " kbit/s"),
        "audio_kbps": ("Audio bitrate", " kbit/s"),
    }.get(key, (f"Export {key}", ""))
    span = f"{new}{unit}" if old is None else f"{old}{unit} to {new}{unit}"
    return _Change(subject="export", line=f"{label}: {span}")


def _param_changes(
    graph: StoryGraph, node_id: str, key: str, old: Any, new: Any, removed: set[str]
) -> list[_Change]:
    kind = graph.nodes[node_id].kind
    scene = node_id.split(".")[0] if "." in node_id else ""
    scenes = frozenset({scene}) if scene else frozenset()
    label = _scene_label(scene) if scene else ""

    def change(subject: str, line: str) -> list[_Change]:
        return [_Change(subject=subject, scenes=scenes, line=line)]

    if kind is NodeKind.NARRATION and key == "text":
        was, now = _word_count(old), _word_count(new)
        if was == now:
            return change("narration", f"{label} narration reworded, {now} words")
        return change("narration", f"{label} narration: {was} words to {now}")
    if kind is NodeKind.NARRATION and key == "voice":
        return change("voice", f"{label} voice: {_quote(new)}")
    if kind is NodeKind.NARRATION and key == "voice_id":
        return change("voice", f"{label} speaker: {new}")
    if kind is NodeKind.NARRATION and key == "speed":
        return change("speed", f"{label} speech speed: {_number(old or 1.0)} to {_number(new)}")
    if kind is NodeKind.KEYFRAME and key == "prompt":
        return change("picture", f"{label} picture: {_quote(new)}")
    if kind is NodeKind.CLIP and key == "prompt":
        return change("shot", f"{label} shot: {_quote(new)}")
    if kind is NodeKind.CLIP and key == "motion":
        return change("motion", f"{label} camera move: {_quote(new)}")
    if kind is NodeKind.CLIP and key == "duration_s":
        span = f"{_number(new)} s" if old is None else f"{_number(old)} s to {_number(new)} s"
        return change("clip_length", f"{label} clip length: {span}")
    if kind is NodeKind.MUSIC and key == "brief":
        return change("music", f"Music: {_quote(new)}")
    if kind is NodeKind.THUMBNAIL and key == "prompt":
        return change("thumbnail", f"Thumbnail: {_quote(new)}")
    if kind is NodeKind.TIMELINE:
        return _timeline_changes(graph, key, old, new, removed)
    if kind is NodeKind.EXPORT:
        return [_export_change(key, old, new)]
    return change("other", f"{node_id} {key} changed")


def _edit_changes(before: StoryGraph, ops: list[PatchOp]) -> list[_Change]:
    """One change per param an op actually moves, then one per removed
    scene. A param set to the value it already has is no change at all, and
    is left out rather than counted."""
    removed = {
        op.node_id.split(".")[0] for op in ops if op.op == "remove_node" and "." in op.node_id
    }
    changes: list[_Change] = []
    for op in ops:
        if op.op != "set_params" or op.node_id not in before.nodes:
            continue
        current = before.nodes[op.node_id].params
        for key, new in (op.params or {}).items():
            old = current.get(key)
            if new != old:
                changes.extend(_param_changes(before, op.node_id, key, old, new, removed))
    changes.extend(
        _Change(subject="removal", scenes=frozenset({sid}), line=f"{_scene_label(sid)} removed")
        for sid in sorted(removed, key=scene_sort_key)
    )
    return changes


def _runtime_s(narration: dict[str, str]) -> float:
    """The cut's length as its narration sets it: the same measure the
    script's length check uses."""
    from ..backends.llm import NARRATION_PAD_S, spoken_seconds

    lines = [text for text in narration.values() if text.strip()]
    return sum(spoken_seconds(text) for text in lines) + NARRATION_PAD_S * len(lines)


def _claim_problems(
    claim: str, before: StoryGraph, after: StoryGraph, ops: list[PatchOp], changes: list[_Change]
) -> list[str]:
    """What in the model's summary the ops show to be wrong, as clauses
    that follow "but". Empty when nothing in it can be checked or nothing
    checked is wrong."""
    problems: list[str] = []
    touched = {change.subject for change in changes}

    untouched = [
        what
        for pattern, subjects, what in _SUBJECTS
        if not touched & subjects
        and any(
            not _PLACE.search(claim[: match.start()].lower()) for match in pattern.finditer(claim)
        )
    ]
    if untouched:
        problems.append(f"nothing in it changes {_joined(untouched)}")

    named: set[str] = set()
    for match in _SCENE_REF.finditer(claim):
        numbers = [int(n) for n in re.findall(r"\d+", match.group(1))]
        if len(numbers) == 2 and re.search(r"to|through|-", match.group(1)):
            numbers = list(range(numbers[0], min(numbers[1], numbers[0] + 50) + 1))
        named |= {f"s{n}" for n in numbers}
    changed_scenes = set().union(*(change.scenes for change in changes)) if changes else set()
    if left := sorted(named - changed_scenes, key=scene_sort_key):
        problems.append(f"it does not change {_scene_list(left)}")
    # gemma4:e2b: "Trimmed narration for each scene" over a plan that
    # touched three scenes of eight.
    scenes = _scene_ids(before)
    if _EVERY_SCENE.search(claim) and len(changed_scenes & set(scenes)) < len(scenes):
        problems.append(
            f"it changes {len(changed_scenes & set(scenes))} of the {len(scenes)} scenes"
        )

    removed = sorted(
        {sid for change in changes if change.subject == "removal" for sid in change.scenes},
        key=scene_sort_key,
    )
    if removed and not _REMOVAL_WORDS.search(claim):
        verb = "is" if len(removed) == 1 else "are"
        problems.append(f"it does not say that {_scene_list(removed)} {verb} removed")

    was, now = _narration_by_scene(before), _narration_by_scene(after)
    total_was = sum(_word_count(text) for text in was.values())
    total_now = sum(_word_count(text) for text in now.values())
    word_counts = {float(total_was), float(total_now)}
    for lines in (was, now):
        if lines:
            word_counts |= {float(_word_count(text)) for text in lines.values()}
            word_counts.add(round(sum(_word_count(t) for t in lines.values()) / len(lines)))
    for match in _WORDS_CLAIM.finditer(claim):
        said = float(match.group(1))
        if not any(abs(said - count) <= max(3.0, 0.1 * said) for count in word_counts):
            per_scene = round(total_now / len(now)) if now else 0
            problems.append(f"the narration comes to {total_now} words, about {per_scene} a scene")
            break

    runtime_now = _runtime_s(now)
    seconds = {_runtime_s(was), runtime_now}
    for lines in (was, now):
        seconds |= {_runtime_s({sid: text}) for sid, text in lines.items()}
    # A number of seconds the edit itself sets or replaces (a clip's length)
    # is one the summary may name, and so is the length the video was asked
    # to run.
    for op in ops:
        if op.op != "set_params" or op.node_id not in before.nodes:
            continue
        current = before.nodes[op.node_id].params
        for key, value in (op.params or {}).items():
            for number in (value, current.get(key)):
                if isinstance(number, int | float) and not isinstance(number, bool):
                    seconds.add(float(number))
    script = before.nodes.get("script")
    target = script.params.get("target_duration_s") if script is not None else None
    if isinstance(target, int | float) and not isinstance(target, bool):
        seconds.add(float(target))
    for match in _SECONDS_CLAIM.finditer(claim):
        said = float(match.group(1))
        if not any(abs(said - value) <= max(2.0, 0.15 * said) for value in seconds):
            problems.append(f"the narration runs about {runtime_now:.0f} s")
            break
    return problems


def _headline(changes: list[_Change], before: StoryGraph, after: StoryGraph) -> str:
    """The summary the ops themselves give. Removed scenes lead, since they
    are the change least easy to spot afterwards, then the narration as one
    change when several scenes' lines move (its total is what a user asks
    about), or else the first other change, and a count of the rest."""
    if not changes:
        return "Nothing in the project changes"
    removed = [sid for change in changes if change.subject == "removal" for sid in change.scenes]
    narrated = [change for change in changes if change.subject == "narration"]
    lead: list[str] = []
    if removed:
        listed = _scene_list(removed)
        lead.append(f"{listed[0].upper()}{listed[1:]} removed")
    if len(narrated) > 1:
        was = sum(_word_count(t) for t in _narration_by_scene(before).values())
        now = sum(_word_count(t) for t in _narration_by_scene(after).values())
        lead.append(f"Narration in {len(narrated)} scenes: {was} words to {now} in all")
    elif narrated:
        lead.append(narrated[0].line)
    others = [change.line for change in changes if change.subject not in ("removal", "narration")]
    if not lead:
        lead, others = others[:1], others[1:]
    text = ". ".join(lead)
    if others:
        text += f" and {len(others)} other change{'' if len(others) == 1 else 's'}"
    return text


def describe_edit(
    before: StoryGraph, after: StoryGraph, ops: list[PatchOp], plan: EditPlan
) -> dict:
    """What an edit does, for the person deciding whether to apply it.

    `before` is the graph the ops were compiled against and `after` the same
    graph with them applied. Returns:

    - `summary`: the headline. The model's own sentence when nothing in it is
      wrong against the ops, otherwise one built from them. A plan that
      compiled to nothing keeps the model's reason when it proposed nothing,
      and has no summary when everything it proposed was refused.
    - `changes`: one line per change the ops make, in plain words.
    - `mismatch`: when the model's sentence was set aside, that sentence
      quoted with what the ops show instead. None otherwise.
    """
    claim = " ".join(plan.summary.split())
    if not ops:
        if plan.edits and claim:
            return {
                "summary": "",
                "changes": [],
                "mismatch": f'The model described this as "{claim}", but none of the '
                "changes it proposed can be made.",
            }
        return {"summary": claim, "changes": [], "mismatch": None}
    changes = _edit_changes(before, ops)
    lines = [change.line for change in changes]
    if not changes:
        # Every op sets a value the project already has.
        problems = ["it changes nothing in the project"]
    else:
        problems = _claim_problems(claim, before, after, ops, changes) if claim else []
    if claim and not problems:
        return {"summary": claim, "changes": lines, "mismatch": None}
    mismatch = f'The model described this as "{claim}", but {_joined(problems)}.' if claim else None
    return {"summary": _headline(changes, before, after), "changes": lines, "mismatch": mismatch}
