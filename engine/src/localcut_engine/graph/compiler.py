"""Graph compiler: Story Graph → ordered job specs.

Only dirty nodes re-execute: a node whose output hash already exists in
the project's artifact cache is skipped, so changing scene 3's prompt
re-renders scene 3 and downstream assembly — never scenes 1–2.
"""

from __future__ import annotations

from pydantic import BaseModel

from .model import KEYFRAME_PORT, NodeKind, StoryGraph

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
    # A graph with no deliverable of its own is a Quick Tool micro-project:
    # its single node IS the output. The `image` tool is a bare KEYFRAME with
    # no edges, so without this it read as orphaned, compiled to zero jobs,
    # and the session reported itself settled with no artifact and no error.
    if not any(node.kind in _TERMINAL_KINDS for node in graph.nodes.values()):
        return set()
    has_consumer = {e.src for e in graph.edges}
    return {
        node_id
        for node_id, node in graph.nodes.items()
        if node.kind in EXECUTABLE_KINDS
        and node.kind not in _TERMINAL_KINDS
        and node_id not in has_consumer
    }


# The param holding a node's own content. Empty, there is nothing to render
# *from* — not a slow render or a bad one, no input at all.
_CONTENT_PARAM = {
    NodeKind.KEYFRAME: "prompt",
    NodeKind.NARRATION: "text",
}

# The input a node cannot run without. Absent, the backend raises on arrival
# rather than producing something lesser — which is the difference between
# this and OPTIONAL_PORTS, whose absence merely degrades the output (no bed,
# no burned captions).
#
# A clip is the case: every clip backend conditions on a still, and the
# ffmpeg one says so outright ("still clip needs a keyframe input"). Until
# U4 nothing could put an unwired clip in a graph — the template builder
# wires what it makes — so the queue was the only thing that ever found out.
# Add node can, and did: the node went red before the user could wire it.
_REQUIRED_PORT = {
    NodeKind.CLIP: KEYFRAME_PORT,
}


def unready_nodes(graph: StoryGraph) -> set[str]:
    """Nodes whose content is still empty, plus everything downstream.

    Public for the same reason `orphaned_nodes` is: these are never enqueued,
    so a board that does not know about them shows the tile as `queued`
    forever, waiting for work that will never be created.

    The case this exists for: `add_scene` mints a scene whose prompt and
    narration the user has not written yet — which is the whole point of the
    card, you fill it in afterwards. Enqueued as-is, the narration failed on
    arrival (both TTS backends raise "narration node has no text" outright)
    and the keyframe burned a full image generation on an empty prompt. The
    tile went red seconds after it appeared, before anyone had typed.

    Unlike `orphaned_nodes` this IS a transitive sweep, because the failure
    propagates: a clip whose keyframe never rendered has no input artifact to
    read and would fail the moment it ran. The cone reaching the export is
    correct too — a video cannot be assembled around a scene nobody wrote.
    Today that same graph reached the queue and failed there instead; the
    only thing lost is the wasted render and a red tile blaming the engine
    for a prompt the user has not written.
    """
    empty = {
        node_id
        for node_id, node in graph.nodes.items()
        if (param := _CONTENT_PARAM.get(node.kind)) is not None
        and not str(node.params.get(param, "")).strip()
    }
    # Missing a required INPUT is the same state as missing content: there is
    # nothing to render from. It arrives by a different route — U4's Add node
    # puts an unwired node on the canvas on purpose — and it needs the same
    # answer, including the transitive sweep, since a consumer of a node that
    # never renders has no artifact to read either.
    unwired = {
        node_id
        for node_id, node in graph.nodes.items()
        if (port := _REQUIRED_PORT.get(node.kind)) is not None
        and not any(edge.port == port for edge in graph.inputs_of(node_id))
    }
    blocked = empty | unwired
    return (
        blocked.union(*(graph.downstream_of(node_id) for node_id in blocked)) if blocked else set()
    )


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
    unready = unready_nodes(graph)

    for node_id in order:
        node = graph.nodes[node_id]
        if node.kind not in EXECUTABLE_KINDS:
            continue
        if node_id in orphans:
            continue  # nothing consumes it — see orphaned_nodes
        if node_id in unready:
            continue  # nothing to render from yet — see unready_nodes
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
