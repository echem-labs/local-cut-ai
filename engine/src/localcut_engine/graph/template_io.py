"""Story Graphs as portable templates.

A template is a project's *structure* without its history: the nodes, their
params and wiring, and the presets a new project needs to start from. No
artifacts, no job rows, no pins, no absolute paths — everything that makes a
project this project rather than a shape you can reuse.

This is the format doc 08 says the marketplace is waiting on, which is why
the validation here assumes the document is HOSTILE. A template that arrives
over the network is untrusted input with the same reach as a graph patch: it
names node kinds, wires ports, and sets the model each node renders on. So
`from_template` re-validates everything the patch path validates and refuses
anything it cannot make safe, rather than repairing it quietly — a template
that half-imports is worse than one that is rejected with a reason.

What deliberately does NOT travel:

- **Asset nodes.** An uploaded image or voice sample lives in the project's
  own `assets/` keyed by sha256, and the bytes are not in the document. A
  template carrying an asset node would import as a node pointing at a file
  that does not exist, and the scene conditioned on it would render nothing
  with no error. Export drops them (and the edges that reach them, so the
  generated keyframe is wired back in), and records how many were dropped so
  the person exporting is told rather than surprised.
- **Pins and frozen hashes.** A pin freezes one artifact. There is no artifact
  here, so a pin would freeze against a hash that will never exist.
- **Server-owned params.** `voice_consent` is the affirmation the upload route
  stamps; a document that could set it would forge consent for a cloned voice.
  `sha256` is the asset identity. Both are stripped on the way in AND the way
  out, so neither direction is a smuggling route.
"""

from __future__ import annotations

import json
import math
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from .. import __version__, jsondoc
from ..aspects import EXPORT_RESOLUTIONS
from .model import (
    GRAPH_VERSION,
    VOICE_REF_PORT,
    Edge,
    Node,
    NodeKind,
    StoryGraph,
    migrate_graph,
)
from .patch import TRANSIENT_PARAMS, stored_params

# The template wire format. Same contract as GRAPH_VERSION: a document from a
# newer engine is refused rather than silently reduced by pydantic's
# extra="ignore" — for a template that would mean importing a graph missing
# whatever the newer build added, which renders as something other than what
# the author published.
TEMPLATE_VERSION = 1

# Caps. A template is untrusted input that becomes a project directory, so
# every unbounded dimension gets a ceiling: a document with 100k nodes would
# otherwise be accepted and then make every board build O(100k).
MAX_NODES = 500
MAX_EDGES = 2000
MAX_DOCUMENT_BYTES = 1 << 20  # 1 MiB of JSON is a very large story graph

# Assets cannot travel (see the module docstring), so a node of this kind is
# dropped on export and refused on import.
_UNPORTABLE_KINDS = frozenset({NodeKind.ASSET})

# The presets are project fields, not graph structure, and `mode` in
# particular is not decoration: it selects which screen the desktop renders
# (Project.tsx switches on a `tool:` prefix and shows a one-node Quick Tool
# shell instead of the workspace) and whether a rendered screenplay expands
# into scenes at all (ProjectService._on_job_done returns early for a tool
# session). An unbounded string here would let a document written by a
# stranger decide both, so it is checked against the same values the engine
# itself can set — /projects for the workspace modes, /tools for the kinds.
PORTABLE_MODES = frozenset({"prompt", "beginner", "advanced", "flowchart"})
TOOL_KINDS = frozenset({"script", "thumbnail", "voiceover", "image", "music", "clip"})


class TemplateError(ValueError):
    """A template that cannot be imported, with a reason a user can act on."""


class GraphTemplate(BaseModel):
    """The document itself. Field order is the order a human reads it in."""

    template_version: int = TEMPLATE_VERSION
    # The graph version the nodes were written against, carried so a future
    # migration knows what it is looking at.
    graph_version: int = GRAPH_VERSION
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    # Presets a new project needs before its first render.
    mode: str = Field(default="prompt", max_length=40)
    aspect: str | None = None
    duration_s: float | None = None
    nodes: dict[str, Node] = Field(default_factory=dict)
    edges: list[Edge] = Field(default_factory=list)
    # How many asset nodes were left behind on export. Zero for a template
    # that never had any; non-zero is a note for whoever imports it.
    dropped_assets: int = 0
    # Informational only — never trusted, never compared against.
    created_with: str = __version__


def _portable_node(node: Node) -> Node:
    """A node with everything project-specific removed."""
    return Node(
        id=node.id,
        kind=node.kind,
        params=stored_params(node.params, drop=TRANSIENT_PARAMS),
        seed=node.seed,
        model=node.model,
        # Pins freeze one artifact; there is no artifact in a template.
        pinned=False,
        frozen_hash=None,
    )


def to_template(
    graph: StoryGraph,
    *,
    name: str,
    description: str = "",
    mode: str = "prompt",
    aspect: str | None = None,
    duration_s: float | None = None,
) -> GraphTemplate:
    """A project's graph as a reusable template.

    Asset nodes and every edge touching one are dropped: dropping the edge as
    well is what matters, because a clip whose `keyframe` port was rewired to
    an uploaded image has its generated keyframe sitting orphaned. Removing
    the edge puts that keyframe back in the render path, so the template
    describes a project that can actually produce every scene.
    """
    dropped = {nid for nid, node in graph.nodes.items() if node.kind in _UNPORTABLE_KINDS}
    nodes = {nid: _portable_node(node) for nid, node in graph.nodes.items() if nid not in dropped}
    edges = [
        Edge(src=e.src, dst=e.dst, port=e.port)
        for e in graph.edges
        if e.src not in dropped and e.dst not in dropped
    ]
    return GraphTemplate(
        # The version these nodes were ACTUALLY written against, not this
        # build's — a project on disk may still be at an older one, and a
        # document that overstated it would tell a future migration to skip
        # the step that fixes it.
        graph_version=graph.version,
        name=name[:120],
        description=description[:2000],
        mode=mode,
        aspect=aspect,
        duration_s=duration_s,
        nodes=nodes,
        edges=edges,
        dropped_assets=len(dropped),
    )


def cloud_models(template: GraphTemplate) -> list[str]:
    """Every `cloud:*` model the template pins, deduplicated and sorted.

    Rendering one of these spends the importer's money on the author's choice
    of provider. That is legitimate — a template built around Veo is a
    template built around Veo — but it must be visible BEFORE the project is
    created, not discovered on the first bill. Callers surface this; nothing
    here blocks on it.
    """
    return sorted(
        {
            node.model
            for node in template.nodes.values()
            if node.model and node.model.startswith("cloud:")
        }
    )


def from_template(document: Any) -> GraphTemplate:
    """Validate an untrusted template document into a GraphTemplate.

    Raises TemplateError with a reason for anything that cannot be imported.
    Nothing here repairs a bad document: a template that silently imports as
    a different graph than it describes is the one outcome worse than a
    rejection, because the person who published it and the person who ran it
    disagree about what it does.
    """
    if isinstance(document, (str, bytes)):
        if len(document) > MAX_DOCUMENT_BYTES:
            raise TemplateError(
                f"template is larger than {MAX_DOCUMENT_BYTES // 1024} KiB — "
                "that is not a story graph"
            )
        try:
            document = json.loads(document)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise TemplateError(f"not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise TemplateError("a template is a JSON object")

    # Version first, before pydantic can drop unknown fields: see the note on
    # TEMPLATE_VERSION. `version` may be absent (a hand-written document) but
    # must be an int when present.
    raw_version = document.get("template_version", TEMPLATE_VERSION)
    if not isinstance(raw_version, int) or isinstance(raw_version, bool):
        raise TemplateError("template_version must be a whole number")
    if raw_version > TEMPLATE_VERSION:
        raise TemplateError(
            f"this template was written by a newer version of LocalCut AI "
            f"(format {raw_version}, this build reads {TEMPLATE_VERSION}) — update to import it"
        )

    # The NODES carry their own version, and it is the one that decides
    # whether this build understands them. `build_graph` stamps GRAPH_VERSION
    # on what it writes, so a newer document accepted here would be recorded
    # as a graph this build wrote — the silent reduction TEMPLATE_VERSION
    # exists to prevent, one field over. Same contract project/store.py
    # enforces when it opens a project directory.
    raw_graph_version = document.get("graph_version", GRAPH_VERSION)
    if not isinstance(raw_graph_version, int) or isinstance(raw_graph_version, bool):
        raise TemplateError("graph_version must be a whole number")
    if raw_graph_version > GRAPH_VERSION:
        raise TemplateError(
            f"this template's graph was written by a newer version of LocalCut AI "
            f"(graph {raw_graph_version}, this build reads {GRAPH_VERSION}) — update to import it"
        )

    # Cheap structural caps BEFORE pydantic builds every Node: validating
    # 100k nodes to then reject them is the same amount of work as accepting
    # them, and this is a route an unauthenticated-adjacent client reaches.
    nodes = document.get("nodes")
    edges = document.get("edges")
    if not isinstance(nodes, dict) or not nodes:
        raise TemplateError("template has no nodes")
    if len(nodes) > MAX_NODES:
        raise TemplateError(f"template has {len(nodes)} nodes; the limit is {MAX_NODES}")
    if edges is not None and (not isinstance(edges, list) or len(edges) > MAX_EDGES):
        raise TemplateError(f"template has more than {MAX_EDGES} edges")
    refusal = jsondoc.refuse_reason(document, MAX_DOCUMENT_BYTES)
    if refusal == "size":
        raise TemplateError(
            f"template is larger than {MAX_DOCUMENT_BYTES // 1024} KiB — that is not a story graph"
        )
    if refusal == "depth":
        raise TemplateError("template is nested too deeply — that is not a story graph")

    try:
        template = GraphTemplate.model_validate(document)
    except ValidationError as exc:
        raise TemplateError(_first_reason(exc)) from exc

    # The dict key is the addressable node id everywhere else in the engine;
    # a document whose key and `id` disagree would import one node under the
    # other's name and wire the edges to whichever the reader trusted.
    mismatched = sorted(nid for nid, node in template.nodes.items() if node.id != nid)
    if mismatched:
        raise TemplateError(f"node id does not match its key: {', '.join(mismatched)}")

    # Presets, checked exactly as the routes that set the same fields check
    # them. /projects refuses an aspect outside the export table because an
    # unknown one renders as the default silently; skipping that here would
    # make a template the one way to get a project whose stated aspect and
    # rendered aspect disagree.
    if not _portable_mode(template.mode):
        raise TemplateError(
            f"unknown project mode {template.mode!r} — a template may carry "
            f"{', '.join(sorted(PORTABLE_MODES))}, or tool:<kind>"
        )
    if template.aspect is not None and template.aspect not in EXPORT_RESOLUTIONS:
        raise TemplateError(
            f"unsupported aspect {template.aspect!r} — "
            f"one of: {', '.join(sorted(EXPORT_RESOLUTIONS))}"
        )
    # Deliberately NOT the create route's 5-1200s target bounds: this field is
    # the assembled cut length, recomputed from the clips at every assembly,
    # and a three-second Quick Tool cut is legitimately below them. What is
    # never legitimate is a value that is not a number of seconds — json.loads
    # accepts NaN and Infinity, and either poisons the length arithmetic and
    # the project tile that reports it.
    if template.duration_s is not None and not (
        math.isfinite(template.duration_s) and template.duration_s >= 0
    ):
        raise TemplateError("duration must be a non-negative number of seconds")

    unportable = sorted(
        nid for nid, node in template.nodes.items() if node.kind in _UNPORTABLE_KINDS
    )
    if unportable:
        raise TemplateError(
            f"template contains uploaded assets ({', '.join(unportable)}), whose files are "
            "not part of the document — re-export it from a project without conditioning assets"
        )

    dangling = sorted(
        {e.src for e in template.edges if e.src not in template.nodes}
        | {e.dst for e in template.edges if e.dst not in template.nodes}
    )
    if dangling:
        raise TemplateError(f"edges reference nodes that are not in the template: {dangling}")

    # One edge per input port — the invariant the `connect` patch op keeps by
    # displacing whatever held the port. Nothing downstream re-checks it: the
    # compiler folds a node's inputs into a `{port: hash}` dict, so a second
    # edge on one port vanishes from the output identity while still sitting
    # in the graph, and which of the two survives depends on list order.
    held: set[tuple[str, str]] = set()
    doubled: set[str] = set()
    for edge in template.edges:
        if (edge.dst, edge.port) in held:
            doubled.add(f"{edge.dst}.{edge.port}")
        held.add((edge.dst, edge.port))
    if doubled:
        raise TemplateError(
            "more than one edge feeds the same input: "
            f"{', '.join(sorted(doubled))} — an input port holds one connection"
        )

    # The voice_ref port is the consent chokepoint (see graph/patch.py, and
    # backends/chatterbox.py, which trusts the graph rather than re-checking).
    # Only a consented voice-sample ASSET may feed it — and an asset can never
    # travel in a template, so a voice_ref edge here is never legitimate
    # however it was produced. Export already drops it with the asset it came
    # from; refuse it on the way in so the second untrusted-document route
    # re-establishes the same invariant the patch route does.
    voice_refs = sorted({e.dst for e in template.edges if e.port == VOICE_REF_PORT})
    if voice_refs:
        raise TemplateError(
            f"template wires the {VOICE_REF_PORT!r} port of {', '.join(voice_refs)} — voice "
            "cloning needs a consented voice sample, and samples are not part of a template"
        )

    # Reserved params are stripped rather than rejected: unlike the checks
    # above, their presence is not evidence of a broken template — it is
    # exactly what a forged one looks like, and dropping them is what the
    # patch path does with the same keys. Nulls go with them, for the reason
    # stored_params gives: a template is the other route params arrive from
    # outside, and a null it plants is a value no later edit can clear.
    # Transient params ride along for a different reason: a hand-written
    # template carrying someone else's feedback would replay it on the
    # importer's first render.
    for node in template.nodes.values():
        node.params = stored_params(node.params, drop=TRANSIENT_PARAMS)
        node.pinned = False
        node.frozen_hash = None

    # Last, because it is the only O(nodes+edges) check: a cycle makes
    # output_hash recurse forever, so it must never reach a project on disk.
    try:
        build_graph(template).topological_order()
    except ValueError as exc:
        raise TemplateError(str(exc)) from exc

    return template


def build_graph(template: GraphTemplate) -> StoryGraph:
    """The StoryGraph a validated template describes.

    Migrated on the way in, because a template is a document this build did
    not write: the importer enqueues against the graph it returns, so a
    document carrying an older behaviour version (or none) would render its
    narration at one address and be re-addressed by the first load
    afterwards, orphaning the audio the import just paid for.
    """
    return migrate_graph(
        StoryGraph(
            version=GRAPH_VERSION,
            nodes={nid: node.model_copy(deep=True) for nid, node in template.nodes.items()},
            edges=[e.model_copy() for e in template.edges],
        )
    )


def _portable_mode(mode: str) -> bool:
    """May a template carry this project mode?"""
    if mode in PORTABLE_MODES:
        return True
    return mode.startswith("tool:") and mode.removeprefix("tool:") in TOOL_KINDS


def _first_reason(exc: ValidationError) -> str:
    """One actionable line out of pydantic's error list.

    The full list is a wall of nested locations; the first error is almost
    always the cause and the rest are its consequences.
    """
    errors = exc.errors()
    if not errors:
        return "template is not valid"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ())) or "template"
    return f"{location}: {first.get('msg', 'is not valid')}"
