"""Graph patches — every edit, including LLM natural-language edits, is a
graph mutation. A patch is a list of small ops so an LLM can emit
it as JSON and the same codepath serves the inspector UI.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from .model import VOICE_REF_PORT, Node, NodeKind, StoryGraph

# Params the server owns and a client patch may never set — otherwise the
# consent affirmation stamped by the asset-upload route (voice_consent) could
# be forged onto any node, defeating the voice_ref guard below.
#
# Public because template import is a second route by which node params
# arrive from outside, and it has to strip exactly the same keys. One
# definition, so a param added here is covered on both paths at once.
RESERVED_PARAMS = frozenset({"voice_consent", "sha256"})

# Params that describe one completed instruction rather than the node's
# configuration. They have to live in params — a re-ask that ignored them
# would hash identical to the render it is meant to replace and be served
# from cache — but they must not behave like configuration afterwards:
#
#   - `regenerate` clears them, or "give me a different take" would replay
#     the last revision against a draft that is now a version stale;
#   - a template drops them, being structure rather than history;
#   - the board does not echo them, because nothing reads them and
#     base_screenplay is kilobytes on an endpoint polled through a render.
#
# They stay in the saved graph so the job that was enqueued for them can
# still be identified by its output hash.
TRANSIENT_PARAMS = frozenset({"feedback", "base_screenplay"})

# By id, not by kind: expand_screenplay looks the node up as graph.nodes[...],
# so this string is the contract the rebuild depends on, and a script-kind
# node under any other id is not the one it will find.
SCRIPT_NODE_ID = "script"


class PatchOp(BaseModel):
    op: Literal[
        "set_params",
        "set_seed",
        "set_model",
        "pin",
        "unpin",
        "add_node",
        "remove_node",
        "connect",
        "disconnect",
        "select_take",
        "add_scene",
    ]
    # add_scene allocates its own ids, so it is the one op with no target.
    node_id: str = ""
    params: dict[str, Any] | None = None
    seed: int | None = None
    model: str | None = None
    node: Node | None = None
    # connect/disconnect: node_id is the destination; `src` the upstream node
    # (connect only), `port` the input being rewired.
    src: str | None = None
    port: str | None = None
    # select_take: the output hash of the recorded take to switch back to.
    # The service resolves it against takes.json into the full identity
    # (params/seed/model) before apply_patch sees the op.
    take: str | None = None
    # add_scene: the scene id to insert after (None appends at the end).
    after: str | None = None


def check_restorable(graph: StoryGraph) -> None:
    """Gate for graphs that arrive whole rather than op-by-op — history
    snapshots and save points being restored. A restore is another route
    that can write an edge, so it has to re-establish what the `connect`
    op guarantees below: no cycles (output_hash would recurse forever),
    and voice_ref fed only by a consented voice-sample asset. Snapshots
    are engine-written, but the file they live in is plain JSON on disk;
    trusting it would make editing history.json a consent bypass."""
    graph.topological_order()  # raises ValueError on a cycle
    for edge in graph.edges:
        if edge.port != VOICE_REF_PORT:
            continue
        src = graph.nodes.get(edge.src)
        if src is None or src.kind is not NodeKind.ASSET or not src.params.get("voice_consent"):
            raise ValueError("voice_ref accepts only a consented voice-sample asset")


def apply_patch(graph: StoryGraph, ops: list[PatchOp]) -> set[str]:
    """Apply ops in order; returns the set of dirtied node ids (each touched
    node plus its downstream cone), which the caller re-compiles."""
    dirty: set[str] = set()
    for op in ops:
        match op.op:
            case "set_params":
                node = graph.nodes[op.node_id]
                # Client patches never touch server-owned params (e.g. the
                # consent flag): drop them so the value on the node is only
                # ever what the server itself stamped.
                incoming = {k: v for k, v in (op.params or {}).items() if k not in RESERVED_PARAMS}
                node.params = {**node.params, **incoming}
            case "set_seed":
                graph.nodes[op.node_id].seed = op.seed if op.seed is not None else 0
            case "set_model":
                graph.nodes[op.node_id].model = op.model
            case "pin":
                node = graph.nodes[op.node_id]
                node.pinned = True
                # Snapshot the output identity now (seeding already-frozen
                # pins so chained pins compose): the freeze must survive any
                # amount of job history and upstream edits.
                memo = {
                    nid: n.frozen_hash
                    for nid, n in graph.nodes.items()
                    if n.pinned and n.frozen_hash
                }
                node.frozen_hash = graph.output_hash(op.node_id, memo)
                continue  # pinning dirties nothing
            case "unpin":
                node = graph.nodes[op.node_id]
                node.pinned = False
                node.frozen_hash = None
                # Unlike pinning (which freezes at the current output),
                # unpinning CAN change a node's effective output: it stops
                # resolving to the frozen artifact. Fall through to dirty the
                # node and its downstream cone — otherwise a graph edited
                # upstream while this node was pinned never re-renders on unpin.
            case "add_node":
                if op.node is None:
                    raise ValueError("add_node requires a node")
                # Same reserved-param discipline as set_params: a client must
                # not be able to smuggle a server-owned flag (e.g.
                # voice_consent) in on a freshly added node either.
                op.node.params = {
                    k: v for k, v in op.node.params.items() if k not in RESERVED_PARAMS
                }
                graph.add_node(op.node)
            case "remove_node":
                # The script node is the one removal with no way back, and it
                # is one-way twice over.
                #
                # Every other pipeline node — timeline, export, captions,
                # music, and the scene subgraphs themselves — is rebuilt by
                # expand_screenplay the next time the script renders, because
                # _ensure_node is idempotent on purpose. So deleting one of
                # those is recoverable. But that repair runs FROM the script
                # node and expand_screenplay raises without one, so removing
                # the script does not merely delete a node: it deletes the
                # mechanism that made every other deletion recoverable. And
                # nothing in the app adds a node back — the LLM editor's whole
                # vocabulary is update and remove_scene.
                if op.node_id == SCRIPT_NODE_ID and op.node_id in graph.nodes:
                    raise ValueError(
                        f"{SCRIPT_NODE_ID!r} cannot be removed — the rest of the pipeline is "
                        "rebuilt from it, and nothing can add it back"
                    )
                dirty |= graph.downstream_of(op.node_id)
                graph.edges = [e for e in graph.edges if op.node_id not in (e.src, e.dst)]
                graph.nodes.pop(op.node_id, None)
                continue
            case "connect":
                # Replace semantics: an input port holds one edge, so wiring
                # an asset into a clip's keyframe port displaces the
                # generated keyframe in the same op.
                if op.src is None or op.port is None:
                    raise ValueError("connect requires src and port")
                # A cycle would make output_hash (and topological_order)
                # recurse forever; reject it here so a bad wire can never be
                # persisted, rather than 500-looping every later read.
                if op.src == op.node_id or op.src in graph.downstream_of(op.node_id):
                    raise ValueError(f"connect {op.src}->{op.node_id} would create a cycle")
                # The voice_ref port is the consent chokepoint: only a
                # consented voice-sample asset may feed a cloning backend, so
                # an image (or any un-affirmed node) can never be wired in.
                if op.port == VOICE_REF_PORT:
                    src_node = graph.nodes.get(op.src)
                    if (
                        src_node is None
                        or src_node.kind is not NodeKind.ASSET
                        or not src_node.params.get("voice_consent")
                    ):
                        raise ValueError("voice_ref accepts only a consented voice-sample asset")
                graph.edges = [
                    e for e in graph.edges if not (e.dst == op.node_id and e.port == op.port)
                ]
                graph.connect(op.src, op.node_id, port=op.port)
            case "select_take":
                node = graph.nodes[op.node_id]
                # Assets carry server-stamped params (sha256, voice_consent)
                # and scripts rebuild the whole pipeline; neither is a node
                # whose identity may be swapped wholesale from a record.
                if node.kind in (NodeKind.ASSET, NodeKind.SCRIPT):
                    raise ValueError(f"{node.kind.value} nodes do not have takes")
                if op.params is None:
                    raise ValueError("select_take requires a resolved take")
                # Wholesale replacement, not a merge: the point of selecting a
                # take is landing on EXACTLY the recorded identity, so its
                # output hash resolves to the artifact already on disk. A
                # merge would keep params added since and miss the cache.
                node.params = {k: v for k, v in op.params.items() if k not in RESERVED_PARAMS}
                node.seed = op.seed if op.seed is not None else 0
                node.model = op.model
            case "add_scene":
                # Needs id allocation and multi-node construction against
                # scene conventions this module does not know — the service
                # compiles it into add_node/connect/set_params ops first.
                raise ValueError("add_scene must be resolved by the project service")
            case "disconnect":
                if op.port is None:
                    raise ValueError("disconnect requires a port")
                # Same "unknown node" answer every other op gives. Without it
                # a disconnect naming a node that is not there succeeded
                # silently and reported the phantom id back as dirty, so a
                # caller working from a stale graph got a 200 for an edit
                # that changed nothing.
                if op.node_id not in graph.nodes:
                    raise KeyError(op.node_id)
                graph.edges = [
                    e for e in graph.edges if not (e.dst == op.node_id and e.port == op.port)
                ]
        dirty.add(op.node_id)
        dirty |= graph.downstream_of(op.node_id)
    return dirty
