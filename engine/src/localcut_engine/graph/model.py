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


# Port-name conventions shared by the template builder and the backends.
# One-sided renames would silently misroute artifacts, so both sides import
# these instead of re-typing the strings.
SCENE_AUDIO_SUFFIX = ".audio"
MUSIC_PORT = "music"
KEYFRAME_PORT = "keyframe"
TIMING_PORT = "timing"
DEFAULT_PORT = "default"
CAPTIONS_PORT = "captions"
# A consented voice-sample asset wired into a narration node — the TTS
# backend clones this speaker instead of using a stock voice.
VOICE_REF_PORT = "voice_ref"

# Input ports whose artifacts are optional for assembly: their absence
# degrades the output (no music bed, no burned captions) instead of failing
# the job — and when the input later succeeds, its consumers re-render.
# TIMING_PORT is listed for graphs expanded before the narration→clip edge
# was dropped: no backend reads it, so it must never block a clip render.
OPTIONAL_PORTS = {MUSIC_PORT, TIMING_PORT, CAPTIONS_PORT}

# Part of every timeline node's hash: bumping it invalidates cached EDLs
# whenever their schema changes (v3: artifact paths relative to generated/;
# v4: per-segment start/duration timing, overlays, trims, transitions;
# v5: segments carry `srcs` — the sequential takes of a split scene).
EDL_VERSION = 5

# Part of every narration node's hash, for the same reason EDL_VERSION is
# part of the timeline's: bumping it invalidates cached narration audio when
# what the backend synthesizes changes for params that did not (v2: the
# espeak language is derived from the voice, so a British voice is read with
# British phonemes — the audio differs while text/voice/speed are identical,
# and without this the existence cache would serve the earlier wav forever).
NARRATION_VERSION = 2

# Part of every export node's hash, for the reason EDL_VERSION is part of the
# timeline's: what the assembly encodes changed while format/preset/aspect/
# captions did not (v2: the crossfade audio mix is restamped before the
# encoder, and a crossfade that follows a cut normalizes its timebases —
# without this the existence cache serves the earlier mp4 forever and the fix
# never reaches a project that already rendered one).
EXPORT_VERSION = 2

# The project.json wire format. Distinct from EDL_VERSION (which only
# invalidates a cached artifact hash) and from the app version in
# manifest.json (which is written and never read).
#
# Bump ONLY on a change an older engine would mis-handle by dropping it:
# every model here uses pydantic's default extra="ignore", so an older build
# opening a newer project silently discards the fields it doesn't know — and
# the next action that touches the graph (any patch, regenerate, approve, or
# job completion) writes the reduced object back over the user's work, with
# no error and nothing to detect it against afterwards.
#
# The compatibility contract, enforced in project/store.py:
#   - graph_version > GRAPH_VERSION  → refuse to open. Upgrade the engine.
#   - graph_version <= GRAPH_VERSION → open, migrate forward, rewrite.
#   - absent                         → a pre-versioning project; treated as
#                                      version 1, which is what it is.
# This matters most in the documented remote-engine topology, where laptop
# and GPU box are separate installs on separate update schedules.
GRAPH_VERSION = 1

# Node ids must stay addressable through the API's path params — the same
# pattern guards both places.
NODE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"


def scene_sort_key(scene_id: str) -> tuple:
    """Numeric-aware ordering for canonical scene ids ('s1', 's2', …)."""
    tail = scene_id[1:]
    return (not tail.isdigit(), int(tail) if tail.isdigit() else 0, scene_id)


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


# Params that describe how an artifact is PRESENTED, not how it is generated.
# They are deliberately excluded from the output hash: including one means a
# change no backend can even observe still re-renders the artifact.
#
# `onscreen_text` is the case this exists for. Titles are burned at assembly
# from the timeline node's `overlays`, and no clip backend reads the clip's
# copy — yet it sat in the clip's params, so re-running the script with a
# reworded title re-rendered the video. Ignoring it here (rather than only
# dropping it from newly built graphs) keeps graphs already on disk hashing
# the same as fresh ones, so there is exactly one re-render, not two.
PRESENTATION_PARAMS = frozenset({"onscreen_text"})


def normalize_params(params: dict[str, Any]) -> dict[str, Any]:
    """A param dict reduced to what actually identifies the output.

    Two normalizations, both about the same failure — an edit that changes
    nothing still re-renders:

    1. Presentation-only keys are dropped (see PRESENTATION_PARAMS).
    2. Integral floats collapse to int, so `5` and `5.0` hash the same. The
       Inspector sends whatever JSON.stringify produced (a whole number
       serializes as `5`), while the LLM edit path coerces through float()
       and sends `5.0`. The values are equal, but the serialized payloads
       were not — so each edit through the other path invalidated the cache
       and re-rendered work that was already correct.

    Applied recursively: nested dicts (timeline `trims`) and lists carry the
    same numbers through the same two paths.
    """

    def clean(value: Any) -> Any:
        if isinstance(value, bool):
            return value  # bool is an int subclass — must not become 0/1
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    return {k: clean(v) for k, v in params.items() if k not in PRESENTATION_PARAMS}


class Node(BaseModel):
    id: str = Field(pattern=NODE_ID_PATTERN)
    kind: NodeKind
    params: dict[str, Any] = Field(default_factory=dict)
    seed: int = 0
    model: str | None = None  # e.g. "local:wan2.2-i2v-14b-fp8" or "cloud:veo-3.1-fast"
    pinned: bool = False  # locked from regeneration
    # Output identity captured at pin time; lives on the node so pins hold
    # regardless of how much job history the project accumulates.
    frozen_hash: str | None = None

    def fingerprint_payload(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "params": normalize_params(self.params),
            "seed": self.seed,
            "model": self.model,
        }


class Edge(BaseModel):
    src: str  # upstream node id
    dst: str  # downstream node id
    port: str = "default"  # named input on the destination node


class StoryGraph(BaseModel):
    # Written on every save; absent in projects created before versioning
    # (they are version 1 by definition). See GRAPH_VERSION for the contract.
    version: int = GRAPH_VERSION
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


#: The behaviour versions folded into a node's content address, by kind. A
#: version here is not configuration the user or a backend reads: it exists
#: so that a change to how a kind is produced re-addresses artifacts whose
#: params did not move.
_PARAM_VERSIONS: dict[NodeKind, tuple[str, int]] = {
    NodeKind.TIMELINE: ("edl_version", EDL_VERSION),
    NodeKind.NARRATION: ("narration_version", NARRATION_VERSION),
    NodeKind.EXPORT: ("export_version", EXPORT_VERSION),
}


def migrate_params(kind: NodeKind, params: dict[str, Any]) -> dict[str, Any]:
    """`params` with this build's behaviour version stamped on, in place."""
    versioned = _PARAM_VERSIONS.get(kind)
    if versioned is not None:
        key, value = versioned
        if params.get(key) != value:
            params[key] = value
    return params


def migrate_graph(graph: StoryGraph) -> StoryGraph:
    """Stamp this build's behaviour versions onto every node, in place.

    The stamp is part of the node's content address, so applying it is what
    stops an artifact produced by a build with different behaviour from
    being served as current. That artifact is still on disk, so this has to
    run at every route a graph enters the engine by — a load, a restore, a
    template import — and beside every op that replaces a node's params
    wholesale. A route that skips it lands the node back on the older
    address, finds the older artifact cached, and queues no job to replace
    it, while the next load stamps it again and moves the node to an address
    nothing has rendered.
    """
    for node in graph.nodes.values():
        migrate_params(node.kind, node.params)
    return graph
