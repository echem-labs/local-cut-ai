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
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from .. import __version__
from .model import GRAPH_VERSION, Edge, Node, NodeKind, StoryGraph
from .patch import RESERVED_PARAMS

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
        params={k: v for k, v in node.params.items() if k not in RESERVED_PARAMS},
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

    # Reserved params are stripped rather than rejected: unlike the checks
    # above, their presence is not evidence of a broken template — it is
    # exactly what a forged one looks like, and dropping them is what the
    # patch path does with the same keys.
    for node in template.nodes.values():
        node.params = {k: v for k, v in node.params.items() if k not in RESERVED_PARAMS}
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
    """The StoryGraph a validated template describes."""
    return StoryGraph(
        version=GRAPH_VERSION,
        nodes={nid: node.model_copy(deep=True) for nid, node in template.nodes.items()},
        edges=[e.model_copy() for e in template.edges],
    )


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
