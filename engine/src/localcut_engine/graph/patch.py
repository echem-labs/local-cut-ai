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
    ]
    node_id: str
    params: dict[str, Any] | None = None
    seed: int | None = None
    model: str | None = None
    node: Node | None = None
    # connect/disconnect: node_id is the destination; `src` the upstream node
    # (connect only), `port` the input being rewired.
    src: str | None = None
    port: str | None = None


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
            case "disconnect":
                if op.port is None:
                    raise ValueError("disconnect requires a port")
                graph.edges = [
                    e for e in graph.edges if not (e.dst == op.node_id and e.port == op.port)
                ]
        dirty.add(op.node_id)
        dirty |= graph.downstream_of(op.node_id)
    return dirty
