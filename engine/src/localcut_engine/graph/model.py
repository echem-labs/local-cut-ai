"""The Story Graph — one internal representation, many views.

Every project is a DAG of typed nodes with parameters and edges. The four
UI modes are editors of this graph at different zoom levels. Each node's
output is content-addressed by (kind, params, seed, model, input hashes),
which is what makes node-level caching and dirty-subgraph re-execution
fall out naturally.
"""

from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class NodeKind(StrEnum):
    SCRIPT = "script"
    SCENE = "scene"
    KEYFRAME = "keyframe"
    CLIP = "clip"
    NARRATION = "narration"
    MUSIC = "music"
    CAPTIONS = "captions"
    ASSET = "asset"
    TIMELINE = "timeline"
    EXPORT = "export"
    THUMBNAIL = "thumbnail"


class Node(BaseModel):
    id: str
    kind: NodeKind
    params: dict[str, Any] = Field(default_factory=dict)
    seed: int = 0
    model: str | None = None  # e.g. "local:wan2.2-i2v-14b-fp8" or "cloud:veo-3.1-fast"
    pinned: bool = False  # locked from regeneration

    def fingerprint_payload(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "params": self.params,
            "seed": self.seed,
            "model": self.model,
        }


class Edge(BaseModel):
    src: str  # upstream node id
    dst: str  # downstream node id
    port: str = "default"  # named input on the destination node


class StoryGraph(BaseModel):
    nodes: dict[str, Node] = Field(default_factory=dict)
    edges: list[Edge] = Field(default_factory=list)

    def add_node(self, node: Node) -> Node:
        if node.id in self.nodes:
            raise ValueError(f"duplicate node id: {node.id}")
        self.nodes[node.id] = node
        return node

    def connect(self, src: str, dst: str, port: str = "default") -> None:
        for node_id in (src, dst):
            if node_id not in self.nodes:
                raise KeyError(f"unknown node: {node_id}")
        self.edges.append(Edge(src=src, dst=dst, port=port))

    def inputs_of(self, node_id: str) -> list[Edge]:
        return [e for e in self.edges if e.dst == node_id]

    def downstream_of(self, node_id: str) -> set[str]:
        """Transitive closure of nodes below node_id (the dirty cone)."""
        out: set[str] = set()
        frontier = [node_id]
        while frontier:
            current = frontier.pop()
            for e in self.edges:
                if e.src == current and e.dst not in out:
                    out.add(e.dst)
                    frontier.append(e.dst)
        return out

    def topological_order(self) -> list[str]:
        indegree = {node_id: 0 for node_id in self.nodes}
        for e in self.edges:
            indegree[e.dst] += 1
        ready = sorted(n for n, d in indegree.items() if d == 0)
        order: list[str] = []
        while ready:
            current = ready.pop(0)
            order.append(current)
            for e in self.edges:
                if e.src == current:
                    indegree[e.dst] -= 1
                    if indegree[e.dst] == 0:
                        ready.append(e.dst)
            ready.sort()
        if len(order) != len(self.nodes):
            raise ValueError("story graph contains a cycle")
        return order

    def output_hash(self, node_id: str, memo: dict[str, str] | None = None) -> str:
        """Content address of a node's output: params + seed + model + input hashes."""
        memo = memo if memo is not None else {}
        if node_id in memo:
            return memo[node_id]
        node = self.nodes[node_id]
        payload = node.fingerprint_payload()
        payload["inputs"] = sorted(
            (e.port, self.output_hash(e.src, memo)) for e in self.inputs_of(node_id)
        )
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode()
        ).hexdigest()
        memo[node_id] = digest
        return digest
