"""Importing a ComfyUI workflow as a usable render template.

The backend already drives ComfyUI through workflow JSON with `%%TOKEN%%`
placeholders substituted per job (see backends/comfyui.py). Importing is
therefore not a new execution path — it is letting a power user supply the
same kind of document the packaged templates are, which is exactly why the
gate has to be here rather than at render time.

Two checks do the work:

1. **Format.** ComfyUI exports two shapes and they are not interchangeable.
   The editor's "Save" writes the UI graph (`{"nodes": [...], "links": [...]}`)
   which its own /prompt endpoint rejects; "Save (API format)" writes the
   node-id-keyed dict the API takes. Telling these apart by hand is the single
   most common way an import fails, so it is detected by name and reported as
   the one-click fix it is, not as "invalid workflow".

2. **Allowlist.** Every class_type must be a builtin or come from an enabled
   pack (see allowlist.py). A workflow naming a node from a catalogued but
   disabled pack is rejected with the pack to enable — the operator's decision
   is a decision, not a guessing game about which node was the problem.
"""

from __future__ import annotations

import importlib.resources
import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .. import jsondoc
from ..backends.comfyui import PLACEHOLDERS
from ..project.store import _write_atomic
from .allowlist import CLASS_TYPE_PATTERN, Allowlist

# A stored template's filename stem. Bare, lowercase-ish, no separators — the
# backend resolves `comfy_template` params against the same directory and
# already refuses anything path-shaped, so this keeps a hostile name from ever
# reaching that check.
# Checked with `fullmatch`, never `match`: in Python `$` also matches just
# before a trailing newline, so "clip_default\n" passed and became a real
# file — while the DELETE route binds this SAME pattern string through
# pydantic, whose rust engine reads `$` as end of text and 422s it, leaving a
# file that could be written and never removed. The pattern text stays `$`
# because pydantic's engine has no `\Z`; `fullmatch` is what makes the two
# agree.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# A workflow bigger than this is not a workflow. ComfyUI's own graphs run to
# tens of KiB; the packaged ones are under 8.
MAX_WORKFLOW_BYTES = 512 * 1024
MAX_WORKFLOW_NODES = 500

_UI_FORMAT_KEYS = ("nodes", "links", "last_node_id")


class WorkflowError(ValueError):
    """An import that cannot proceed, with the reason and the fix."""


class WorkflowReview(BaseModel):
    """What an import would do, before it does it."""

    class_types: list[str] = Field(default_factory=list)
    # Catalogued packs this workflow needs, split by whether they are enabled.
    packs_required: list[str] = Field(default_factory=list)
    packs_missing: list[str] = Field(default_factory=list)
    # class_types matching nothing at all — not a builtin, not in any pack.
    unknown_nodes: list[str] = Field(default_factory=list)
    # `%%TOKEN%%` placeholders present. A workflow with none still renders,
    # it just renders the same thing every time.
    placeholders: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.unknown_nodes and not self.packs_missing


def parse_workflow(source: str | bytes | dict) -> dict:
    """A workflow document, or WorkflowError explaining which one to export."""
    if isinstance(source, (str, bytes)):
        if len(source) > MAX_WORKFLOW_BYTES:
            raise WorkflowError(
                f"workflow is larger than {MAX_WORKFLOW_BYTES // 1024} KiB — "
                "that is not a ComfyUI graph"
            )
        try:
            source = json.loads(source)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise WorkflowError(f"not valid JSON: {exc}") from exc
    if not isinstance(source, dict):
        raise WorkflowError("a ComfyUI workflow is a JSON object")
    if not source:
        raise WorkflowError("workflow is empty")
    if any(key in source for key in _UI_FORMAT_KEYS):
        raise WorkflowError(
            "this is the ComfyUI editor's own save format, which its API does not accept — "
            "in ComfyUI use Workflow > Export (API) and import that file instead"
        )
    if len(source) > MAX_WORKFLOW_NODES:
        raise WorkflowError(f"workflow has {len(source)} nodes; the limit is {MAX_WORKFLOW_NODES}")
    # Measured on the PARSED document, not only on a string: the API route
    # takes a dict (FastAPI already parsed the body) and the CLI parses the
    # file before posting it, so a size check that only ran for `str | bytes`
    # never ran at all in production. A three-node workflow whose inputs are
    # megabytes of text passes the node count and is then written into the
    # templates directory, where the backend re-reads it on every render.
    refusal = jsondoc.refuse_reason(source, MAX_WORKFLOW_BYTES)
    if refusal == "size":
        raise WorkflowError(
            f"workflow is larger than {MAX_WORKFLOW_BYTES // 1024} KiB — "
            "that is not a ComfyUI graph"
        )
    if refusal == "depth":
        raise WorkflowError("workflow is nested too deeply — that is not a ComfyUI graph")
    return source


def class_types(workflow: dict) -> list[str]:
    """Every class_type the workflow names, sorted and deduplicated.

    A node without a usable class_type is a malformed document rather than a
    node to allow or deny, so it fails here instead of passing the allowlist
    by having nothing to check.
    """
    found: set[str] = set()
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            raise WorkflowError(f"node {node_id!r} is not an object")
        class_type = node.get("class_type")
        if not isinstance(class_type, str) or not CLASS_TYPE_PATTERN.fullmatch(class_type):
            raise WorkflowError(f"node {node_id!r} has no usable class_type")
        found.add(class_type)
    return sorted(found)


def review(workflow: dict, allowlist: Allowlist) -> WorkflowReview:
    """Judge a parsed workflow against the allowlist. Never raises for policy
    reasons — the verdict is data, so a caller can show it before deciding."""
    types = class_types(workflow)
    required: set[str] = set()
    missing: set[str] = set()
    unknown: list[str] = []
    for class_type in types:
        # Through the allowlist's own rule rather than a second copy of it —
        # this is the decision about whether third-party Python may run, and
        # it should have exactly one implementation.
        match allowlist.verdict(class_type):
            case "unknown", _:
                unknown.append(class_type)
            case "needs-grant", pack if pack is not None:
                missing.add(pack.id)
            case "allowed", pack if pack is not None:
                required.add(pack.id)

    body = json.dumps(workflow)
    placeholders = [token for token in PLACEHOLDERS if token in body]
    warnings: list[str] = []
    if not placeholders:
        warnings.append(
            "this workflow has no %%PLACEHOLDER%% tokens, so every render will produce the "
            "same output — substitute at least %%PROMPT%% and %%SEED%% to drive it from a node"
        )
    return WorkflowReview(
        class_types=types,
        packs_required=sorted(required),
        packs_missing=sorted(missing),
        unknown_nodes=unknown,
        placeholders=placeholders,
        warnings=warnings,
    )


def rejection(review_result: WorkflowReview, allowlist: Allowlist) -> str:
    """The message for a review that did not pass, naming the fix."""
    parts: list[str] = []
    if review_result.packs_missing:
        for pack_id in review_result.packs_missing:
            pack = next((p for p in allowlist.packs if p.id == pack_id), None)
            label = f"{pack.name} ({pack.repo})" if pack else pack_id
            parts.append(f"needs the node pack {label}, which is not enabled on this engine")
    if review_result.unknown_nodes:
        parts.append(
            "uses nodes LocalCut AI does not recognise: "
            + ", ".join(review_result.unknown_nodes)
            + " — these are not stock ComfyUI nodes and are not in any catalogued pack"
        )
    return "; ".join(parts) or "workflow was rejected"


def templates_dir(data_dir: Path) -> Path:
    """Where imported workflows live — the directory the ComfyUI backend
    already prefers over its packaged templates."""
    return data_dir / "comfy-templates"


def packaged_names() -> frozenset[str]:
    """Stems of the workflow templates this build ships.

    Listing a package directory is not guaranteed on every loader a frozen
    build can end up with, and this feeds a warning rather than a decision —
    so a loader that cannot enumerate costs the note, never the import.
    """
    try:
        directory = importlib.resources.files("localcut_engine.comfy_templates")
        return frozenset(
            entry.name.removesuffix(".json")
            for entry in directory.iterdir()
            if entry.name.endswith(".json")
        )
    except (OSError, NotADirectoryError, TypeError):
        return frozenset()


def shadow_warning(name: str) -> str | None:
    """The note for an import that takes over a packaged template's name.

    `_template_path` in the ComfyUI backend prefers the data dir over its own
    package, so importing under a packaged stem replaces that render for every
    project on this engine — not just the one the operator had in mind. That is
    the override mechanism working as designed, and `clip_default` is a name
    someone reaches for by accident. Worse, the override is invisible after the
    fact: an output's identity is hashed from params, seed, model and inputs,
    never from the template that produced it, so the cache does not turn over
    and old and new artifacts sit side by side under one node id.
    """
    if name in packaged_names():
        return (
            f"{name!r} is the name of a workflow LocalCut AI ships, so this import replaces it "
            "for every project on this engine. Already-rendered outputs keep their cached "
            "artifacts; only new renders use the imported graph. Import under a different name "
            "if you meant to add a workflow rather than replace one."
        )
    return None


def store(data_dir: Path, name: str, workflow: dict) -> Path:
    """Write an approved workflow as `<name>.json`. Returns its path."""
    if not NAME_PATTERN.fullmatch(name or ""):
        raise WorkflowError(
            "name must be lowercase letters, digits, dashes or underscores "
            "(it becomes the template filename)"
        )
    directory = templates_dir(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    # The project store's writer rather than a second hand-rolled rename: an
    # imported workflow can shadow a packaged template, so a truncated write
    # here is re-read by the backend on every render of every project on this
    # engine. That is what the fsync and the replace-retry are for.
    _write_atomic(path, json.dumps(workflow, indent=2))
    return path


def installed(data_dir: Path) -> list[dict[str, Any]]:
    """Imported workflows, newest name-sorted, with what each can be driven by."""
    directory = templates_dir(data_dir)
    if not directory.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            body = path.read_text(encoding="utf-8")
            workflow = json.loads(body)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # A file we cannot read is still worth listing: it is on disk, it
            # shadows a packaged template of the same name, and hiding it
            # would make that shadowing invisible.
            rows.append({"name": path.stem, "nodes": 0, "placeholders": [], "readable": False})
            continue
        rows.append(
            {
                "name": path.stem,
                "nodes": len(workflow) if isinstance(workflow, dict) else 0,
                "placeholders": [token for token in PLACEHOLDERS if token in body],
                "readable": True,
            }
        )
    return rows


def remove(data_dir: Path, name: str) -> bool:
    """Delete an imported workflow. True if it was there."""
    if not NAME_PATTERN.fullmatch(name or ""):
        raise WorkflowError("not a workflow name")
    path = templates_dir(data_dir) / f"{name}.json"
    if not path.is_file():
        return False
    path.unlink()
    return True
