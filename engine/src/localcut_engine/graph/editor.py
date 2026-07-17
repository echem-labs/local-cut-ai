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

from pydantic import BaseModel, Field, ValidationError

from .model import NodeKind, StoryGraph, scene_sort_key
from .patch import PatchOp

# Params the LLM may see and set, per node kind. Aspect and format params are
# deliberately absent (project-wide, validated at project creation), as is the
# script node (editing it re-runs the LLM and re-derives every scene).
EDITABLE_PARAMS: dict[NodeKind, frozenset[str]] = {
    NodeKind.KEYFRAME: frozenset({"prompt"}),
    NodeKind.CLIP: frozenset({"prompt", "motion", "duration_s"}),
    NodeKind.NARRATION: frozenset({"text", "voice"}),
    NodeKind.MUSIC: frozenset({"brief"}),
    NodeKind.THUMBNAIL: frozenset({"prompt"}),
    NodeKind.TIMELINE: frozenset({"order", "trims", "transitions", "overlays"}),
    NodeKind.EXPORT: frozenset({"captions"}),
}

_TRANSITIONS = {"cut", "crossfade", "dip"}
_CAPTION_MODES = {"burn", "sidecar"}
_MAX_TEXT = 2000
_MAX_OVERLAY = 200
_CLIP_MIN_S, _CLIP_MAX_S = 1.0, 15.0

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
the video shorter, shorten narration text or remove scenes.
- on-screen text lives in the timeline node's "overlays" (scene id -> text), not on clips.
- the timeline's "order" lists scene ids in play order; "transitions" maps a scene id to the \
transition out of that scene: one of cut, crossfade, dip; "trims" maps a scene id to \
{"in": seconds, "out": seconds} of the source clip.
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
    return view


_DROP = object()


def _clean_text(value: Any, limit: int, warnings: list[str], label: str) -> Any:
    if value is None:
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
    if kind is NodeKind.EXPORT and key == "captions":
        if value in _CAPTION_MODES:
            return value
        warnings.append(f"{label}: must be one of {sorted(_CAPTION_MODES)}")
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
                if entry in _TRANSITIONS:
                    clean[sid] = entry
                else:
                    warnings.append(f"{label}[{sid}]: must be one of {sorted(_TRANSITIONS)}")
            elif key == "trims":
                try:
                    trim = {k: max(0.0, float(entry[k])) for k in ("in", "out") if entry.get(k)}
                except (TypeError, ValueError):
                    warnings.append(f"{label}[{sid}]: in/out must be seconds")
                    continue
                if trim:
                    clean[sid] = trim
            else:  # overlays — None clears a title
                clean[sid] = None if entry is None else str(entry)[:_MAX_OVERLAY]
        return clean or _DROP
    # Everything else on the whitelist is prose (prompts, narration, briefs).
    return _clean_text(value, _MAX_TEXT, warnings, label)


def _scrub_removed(params: dict, removed: set[str]) -> dict:
    """Timeline params with every reference to the removed scenes dropped."""
    scrubbed: dict[str, Any] = {}
    if isinstance(order := params.get("order"), list):
        scrubbed["order"] = [s for s in order if s not in removed]
    for key in ("trims", "transitions", "overlays"):
        if isinstance(entries := params.get(key), dict):
            scrubbed[key] = {s: v for s, v in entries.items() if s not in removed}
    return scrubbed


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

    for edit in plan.edits:
        if edit.action == "remove_scene":
            sid = edit.scene_id or ""
            if scope != "project":
                warnings.append(f"remove_scene {sid!r}: only allowed at project scope")
            elif sid not in scene_ids:
                warnings.append(f"remove_scene: unknown scene {sid!r}")
            elif len(scene_ids - removed - {sid}) < 1:
                warnings.append(f"remove_scene {sid!r}: cannot remove the only remaining scene")
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
    timeline_params = dict(updates.get("timeline") or {})
    if removed and "timeline" in graph.nodes:
        # Scrub after the plan's own timeline edits so a reorder that also
        # removes a scene doesn't resurrect it from the pre-edit params.
        merged = {**graph.nodes["timeline"].params, **timeline_params}
        timeline_params.update(_scrub_removed(merged, removed))
    if timeline_params:
        ops.append(PatchOp(op="set_params", node_id="timeline", params=timeline_params))
    return ops, warnings
