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
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..aspects import (
    EXPORT_AUDIO_KBPS_BOUNDS,
    EXPORT_FPS_CHOICES,
    EXPORT_SHORT_SIDE_CHOICES,
    EXPORT_USER_PARAMS,
    EXPORT_VIDEO_KBPS_BOUNDS,
)
from .model import NodeKind, StoryGraph, scene_sort_key
from .templates import DEFAULT_CLIP_S, MAX_CLIP_S
from .patch import PatchOp

# Params the LLM may see and set, per node kind. Aspect and format params are
# deliberately absent (project-wide, validated at project creation), as is the
# script node (editing it re-runs the LLM and re-derives every scene).
EDITABLE_PARAMS: dict[NodeKind, frozenset[str]] = {
    NodeKind.KEYFRAME: frozenset({"prompt"}),
    NodeKind.CLIP: frozenset({"prompt", "motion", "duration_s"}),
    NodeKind.NARRATION: frozenset({"text", "voice", "speed"}),
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

SUGGEST_SCENE_SYSTEM_PROMPT = """You are helping build one scene of a short video from a \
picture the user just supplied. You are told what the video is about, what the scenes before \
this one say, and how long this scene runs; you are also shown the image itself. Respond with \
JSON only (no markdown fences), in this exact shape:
{"narration": str, "prompt": str}
Rules:
- "narration" is what the voice says over this scene. Write it to be spoken aloud, in the \
voice and tense the project's existing narration already uses.
- Write narration to the word count you are given. That count IS the scene's length: the \
narration is spoken and the clip runs as long as the speech, so a handful of words makes a \
scene that is over before it is seen.
- Write a complete sentence. Never continue or complete a sentence from an earlier scene.
- "prompt" describes the shot for a video model that will ANIMATE this exact image. Describe \
what is in the picture and how it should move; do not invent a different subject.
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
    said = [
        text
        for node in nodes
        if node.get("kind") == "narration"
        for text in [str(node.get("params", {}).get("text") or "").strip()]
        if text
    ]
    if said:
        recent = said[-_SUGGEST_SCENE_RECENT:]
        lines = "\n".join(f"- {line}" for line in recent)
        parts.append(f"The scenes before this one say:\n{lines}")
        parts.append("Your new scene comes after those. Do not repeat what they already said.")
    else:
        parts.append("This is the first scene with words, so the narration sets the voice.")

    # Imported here, not at module scope: `backends.llm` pulls httpx and the
    # ffmpeg timing constants, which a graph module has no business loading
    # to reach one arithmetic helper. The helper is the point — it is the
    # same words-per-second the script writer is held to, so a scene added
    # this way is measured the way every other scene is.
    from ..backends.llm import narration_word_budget

    # The length the scene needs, floored by what this project actually
    # writes. A five-second default asks for eighteen words, which next to
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


def parse_scene_suggestion(raw: str) -> dict:
    """LLM output → the two strings. Raises ValueError on anything unusable.

    Same fence-stripping as `parse_edit_plan`: models emit ```json blocks
    however firmly the system prompt asks them not to. Validated rather than
    passed through, because these two strings go straight into a patch.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1].removeprefix("json").strip()
    try:
        return SceneSuggestion.model_validate(json.loads(text)).model_dump()
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ValueError(f"the model returned an unusable scene suggestion: {exc}") from exc


EDIT_SYSTEM_PROMPT = """You are a video project editor operating on a scene graph. You receive a \
JSON view of a project's editable nodes and an instruction. Respond with JSON only (no markdown \
fences), in this exact shape:
{"summary": str, "edits": [
  {"action": "update", "node_id": str, "params": {key: value}},
  {"action": "remove_scene", "scene_id": str}
]}
Rules:
- Only change what the instruction asks for; leave everything else alone.
- params keys must come from the node's own params shown in the view.
- keyframe/clip "prompt" values are image/video generation prompts; keep the established \
visual style unless asked to change it. "motion" is a short camera direction.
- narration "text" is spoken aloud. The video's length follows narration length, so to make \
the video shorter, shorten narration text or remove scenes. narration "speed" is the speech \
rate (1.0 normal, 0.5-1.5).
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


def _scrub_removed(params: dict, removed: set[str]) -> dict:
    """Timeline params with every reference to the removed scenes dropped."""
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
        timeline_params.update(_scrub_removed(merged, removed))
    if timeline_params:
        if "timeline" in graph.nodes and graph.nodes["timeline"].pinned:
            # A pinned timeline serves its frozen EDL; scrubbing its params
            # would only diverge saved state from render. Leave it be.
            warnings.append("timeline is pinned; skipped timeline edits")
        else:
            ops.append(PatchOp(op="set_params", node_id="timeline", params=timeline_params))
    return ops, warnings
