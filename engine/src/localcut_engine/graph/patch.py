"""Graph patches — every edit, including LLM natural-language edits, is a
graph mutation. A patch is a list of small ops so an LLM can emit
it as JSON and the same codepath serves the inspector UI.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from .model import VOICE_REF_PORT, Node, NodeKind, StoryGraph


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
                node.params = {**node.params, **(op.params or {})}
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
                continue
            case "add_node":
                if op.node is None:
                    raise ValueError("add_node requires a node")
                graph.add_node(op.node)
            case "remove_node":
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
