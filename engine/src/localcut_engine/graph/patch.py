"""Graph patches — every edit, including LLM natural-language edits, is a
graph mutation. A patch is a list of small ops so an LLM can emit
it as JSON and the same codepath serves the inspector UI.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from .model import Node, StoryGraph


class PatchOp(BaseModel):
    op: Literal["set_params", "set_seed", "set_model", "pin", "unpin", "add_node", "remove_node"]
    node_id: str
    params: dict[str, Any] | None = None
    seed: int | None = None
    model: str | None = None
    node: Node | None = None


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
                graph.nodes[op.node_id].pinned = True
                continue  # pinning dirties nothing
            case "unpin":
                graph.nodes[op.node_id].pinned = False
                continue
            case "add_node":
                if op.node is None:
                    raise ValueError("add_node requires a node")
                graph.add_node(op.node)
            case "remove_node":
                dirty |= graph.downstream_of(op.node_id)
                graph.edges = [
                    e for e in graph.edges if op.node_id not in (e.src, e.dst)
                ]
                graph.nodes.pop(op.node_id, None)
                continue
        dirty.add(op.node_id)
        dirty |= graph.downstream_of(op.node_id)
    return dirty
