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
    pinned_satisfied: set[str] | None = None,
) -> CompiledPlan:
    """Compile the graph into jobs for every node not satisfied by the cache.

    ``pinned_satisfied`` holds ids of pinned nodes that already have *any*
    prior artifact — those never re-execute, even if an upstream change
    would otherwise dirty them (a pinned node with no artifact at all still
    has to render once).
    """
    cache_hashes = cache_hashes or set()
    pinned_satisfied = pinned_satisfied or set()
    memo: dict[str, str] = {}
    order = graph.topological_order()
    jobs: list[JobSpec] = []
    cached: list[str] = []

    for node_id in order:
        node = graph.nodes[node_id]
        if node.kind not in EXECUTABLE_KINDS:
            continue
        out_hash = graph.output_hash(node_id, memo)
        if out_hash in cache_hashes or (node.pinned and node_id in pinned_satisfied):
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
