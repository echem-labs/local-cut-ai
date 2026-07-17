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
QUALITY_SENSITIVE_KINDS = {NodeKind.CLIP, NodeKind.TIMELINE, NodeKind.EXPORT}


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

    for node_id in order:
        node = graph.nodes[node_id]
        if node.kind not in EXECUTABLE_KINDS:
            continue
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
