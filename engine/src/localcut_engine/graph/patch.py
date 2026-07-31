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


def stored_params(params: dict[str, Any], *, drop: frozenset[str] = frozenset()) -> dict[str, Any]:
    """Params as a node may hold them: no server-owned keys, and no nulls.

    A stored null is not an absent key. Every reader treats it as a value,
    and each one fails differently: `params.get("captions", "burn")` returns
    None, so the export stops burning captions it was asked for;
    `str(params.get("prompt", ""))` returns the string "None", so a keyframe
    renders that word and `unready_nodes` reads the node as written;
    `int(params.get("target_duration_s", 60))` raises. It also hashes
    differently from the same node without the key, so the artifact already
    rendered for that state can never be a cache hit again.

    `set_params` states the rule in its own terms because a merge has to
    REMOVE the key a null clears rather than filter it. Every route that
    replaces a node's params wholesale comes through here — the `add_node`
    and `select_take` ops, and template import and export, which is the
    same list as RESERVED_PARAMS above and for the same reason: params
    arriving from outside are covered on every path at once, or on one.
    """
    return {
        key: value
        for key, value in params.items()
        if key not in RESERVED_PARAMS and key not in drop and value is not None
    }


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
                # null REMOVES the key rather than storing None. "Back to the
                # default" has to land on the same params — and so the same
                # output hash — as never having set the value at all, or the
                # artifact already rendered for that state can never be a
                # cache hit again. An export switched to 30 fps and back to
                # Auto re-encoded the whole video against a hash carrying
                # `{"fps": None}`, which no earlier render could match; this
                # is the failure normalize_params exists to prevent, one
                # level up. Reading None as absent at every READER would be
                # the wrong fix: params.get("captions", "burn") returns None
                # for a stored null, and None is not "burn".
                #
                # Only keys THIS op cleared are dropped: a null already on
                # the node is left alone, so an unrelated edit never moves a
                # node's hash as a side effect of tidying it.
                cleared = {key for key, value in incoming.items() if value is None}
                node.params = {
                    key: value
                    for key, value in {**node.params, **incoming}.items()
                    if key not in cleared
                }
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
                # Same discipline as set_params: a client must not be able to
                # smuggle a server-owned flag (e.g. voice_consent) in on a
                # freshly added node, nor a null that no later edit can clear.
                op.node.params = stored_params(op.node.params)
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
                #
                # `stored_params` is the one thing that may differ from the
                # record, and only for a take written before that rule
                # existed: a null in it is dropped, so the node lands one hash
                # away from the recorded artifact and re-renders once. That is
                # the right way round — restoring the null would put back a
                # value that silently turns captions off and that no later
                # edit can clear.
                node.params = stored_params(op.params)
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
