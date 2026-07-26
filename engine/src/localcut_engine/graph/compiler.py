"""Graph compiler: Story Graph → ordered job specs.

Only dirty nodes re-execute: a node whose output hash already exists in
the project's artifact cache is skipped, so changing scene 3's prompt
re-renders scene 3 and downstream assembly — never scenes 1–2.
"""

from __future__ import annotations

from pydantic import BaseModel

from .model import NodeKind, StoryGraph

# Node kinds that require an execution job (assets are user-provided).
EXECUTABLE_KINDS = {
    NodeKind.SCRIPT,
    NodeKind.SCENE,
    NodeKind.KEYFRAME,
    NodeKind.CLIP,
    NodeKind.NARRATION,
    NodeKind.MUSIC,
    NodeKind.CAPTIONS,
    NodeKind.TIMELINE,
    NodeKind.EXPORT,
    NodeKind.THUMBNAIL,
}

# Kinds whose output differs between draft and final quality: finalize
# re-renders these even when a draft artifact is cached.
#
# Every *generated* kind belongs here, not just the video ones. The ComfyUI
# backend scales sampler steps by quality for keyframes, thumbnails and music
# exactly as it does for clips, so leaving them out meant a "final" export
# was assembled from draft-quality stills, a draft thumbnail and draft music —
# the one thing finalize exists to prevent. SCRIPT and CAPTIONS stay out on
# purpose: their output is text, identical at either tier, and re-running the
# script would re-roll the screenplay the user already approved.
QUALITY_SENSITIVE_KINDS = {
    NodeKind.KEYFRAME,
    NodeKind.THUMBNAIL,
    NodeKind.CLIP,
    NodeKind.MUSIC,
    NodeKind.TIMELINE,
    NodeKind.EXPORT,
}


class JobSpec(BaseModel):
    node_id: str
    kind: NodeKind
    output_hash: str
    params: dict
    model: str | None
    seed: int
    input_hashes: dict[str, str]  # port -> upstream output hash
    quality: str = "draft"  # draft | final


class CompiledPlan(BaseModel):
    jobs: list[JobSpec]
    cached: list[str]  # node ids satisfied from cache
    order: list[str]


# Kinds that are worth rendering even with nothing downstream: the user asked
# for them directly and views them through the artifact routes. Everything
# else exists only to feed something else.
_TERMINAL_KINDS = {
    NodeKind.SCRIPT,
    NodeKind.EXPORT,
    NodeKind.TIMELINE,
    NodeKind.THUMBNAIL,
    NodeKind.NARRATION,
    NodeKind.MUSIC,
    NodeKind.CAPTIONS,
    NodeKind.CLIP,
}


def orphaned_nodes(graph: StoryGraph) -> set[str]:
    """Nodes that feed nothing and are not themselves a deliverable.

    Public because the scene board needs the same answer: these nodes are
    never enqueued, so a board that does not know about them shows the tile
    as `queued` forever, waiting on work that will never be created.

    The case this exists for: conditioning a scene on an uploaded image
    rewires the clip's keyframe port to the asset, which leaves the generated
    keyframe node in the graph with no outgoing edge. It is an input to
    nothing, but it was still compiled and rendered — a full image generation
    per conditioned scene, every time, for a picture nobody will ever see.

    Deliberately narrow: only non-terminal kinds with no outgoing edge at
    all. A clip is never orphaned (it is the thing being made), and a node
    whose only consumer is itself orphaned still renders — one hop, not a
    transitive sweep, because a partially-wired graph mid-edit must not have
    its whole subtree silently stop rendering.
    """
    has_consumer = {e.src for e in graph.edges}
    return {
        node_id
        for node_id, node in graph.nodes.items()
        if node.kind in EXECUTABLE_KINDS
        and node.kind not in _TERMINAL_KINDS
        and node_id not in has_consumer
    }


def compile_graph(
    graph: StoryGraph,
    cache_hashes: set[str] | None = None,
    quality: str = "draft",
    frozen: dict[str, str] | None = None,
) -> CompiledPlan:
    """Compile the graph into jobs for every node not satisfied by the cache.

    ``frozen`` maps pinned node ids to the output hash of their existing
    artifact. Pinning freezes a node's output *identity*: the node never
    re-executes, and downstream nodes hash (and resolve inputs) against the
    frozen artifact rather than what the current graph would produce — so
    an upstream edit re-renders everything around a pinned node but never
    the pinned node itself. A pinned node with no artifact yet is simply
    not frozen and renders once.
    """
    cache_hashes = cache_hashes or set()
    frozen = frozen or {}
    # Seeding the memo makes output_hash() return the frozen hash for these
    # nodes, which transparently propagates into all downstream hashes.
    memo: dict[str, str] = dict(frozen)
    order = graph.topological_order()
    jobs: list[JobSpec] = []
    cached: list[str] = []
    orphans = orphaned_nodes(graph)

    for node_id in order:
        node = graph.nodes[node_id]
        if node.kind not in EXECUTABLE_KINDS:
            continue
        if node_id in orphans:
            continue  # nothing consumes it — see orphaned_nodes
        if node.pinned and node_id in frozen:
            cached.append(node_id)
            continue
        out_hash = graph.output_hash(node_id, memo)
        if out_hash in cache_hashes:
            cached.append(node_id)
            continue
        jobs.append(
            JobSpec(
                node_id=node_id,
                kind=node.kind,
                output_hash=out_hash,
                params=node.params,
                model=node.model,
                seed=node.seed,
                input_hashes={e.port: memo[e.src] for e in graph.inputs_of(node_id)},
                quality=quality,
            )
        )
    return CompiledPlan(jobs=jobs, cached=cached, order=order)
