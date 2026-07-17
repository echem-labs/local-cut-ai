"""Template graphs — prompt-only mode instantiates these.

Two-stage: the initial graph carries just the Script node; once the LLM
returns a structured screenplay, `expand_screenplay` turns each scene
into its subgraph (keyframe → clip, narration) plus shared music,
captions, timeline and export nodes.
"""

from __future__ import annotations

from ..schema import Screenplay
from .model import (
    EDL_VERSION,
    KEYFRAME_PORT,
    MUSIC_PORT,
    SCENE_AUDIO_SUFFIX,
    CAPTIONS_PORT,
    TIMING_PORT,
    Node,
    NodeKind,
    StoryGraph,
)


def prompt_template_graph(
    prompt: str,
    *,
    target_duration_s: int = 60,
    aspect: str = "9:16",
    style_preset: str = "cinematic",
) -> StoryGraph:
    graph = StoryGraph()
    graph.add_node(
        Node(
            id="script",
            kind=NodeKind.SCRIPT,
            params={
                "prompt": prompt,
                "target_duration_s": target_duration_s,
                "aspect": aspect,
                "style_preset": style_preset,
            },
        )
    )
    return graph


def _ensure_node(graph: StoryGraph, node_id: str, kind: NodeKind, params: dict) -> Node:
    """Add the node, or refresh its derived params in place — seed, pin and
    frozen_hash are user state and survive re-expansion."""
    node = graph.nodes.get(node_id)
    if node is None:
        return graph.add_node(Node(id=node_id, kind=kind, params=params))
    node.params = params
    return node


def _ensure_edge(graph: StoryGraph, src: str, dst: str, port: str = "default") -> None:
    if not any(e.src == src and e.dst == dst and e.port == port for e in graph.edges):
        graph.connect(src, dst, port=port)


def _remove_scene(graph: StoryGraph, scene_id: str) -> None:
    members = {f"{scene_id}.keyframe", f"{scene_id}.clip", f"{scene_id}.narration"}
    graph.edges = [e for e in graph.edges if e.src not in members and e.dst not in members]
    for node_id in members:
        graph.nodes.pop(node_id, None)


def expand_screenplay(graph: StoryGraph, screenplay: Screenplay) -> StoryGraph:
    """Materialize the screenplay below the script node: per-scene subgraphs
    plus shared music, captions, timeline and export.

    Idempotent: re-running (script regenerated or edited) updates existing
    nodes' derived params in place, adds new scenes, and drops scenes the
    new screenplay no longer has — so a script change actually lands instead
    of the pipeline re-rendering stale scene params.
    """
    if "script" not in graph.nodes:
        raise KeyError("template graph has no script node")

    # LLM-emitted scene ids are untrusted (arbitrary shapes, duplicates).
    # Canonicalize to s1..sN in screenplay order — node ids, sort order and
    # port names all rely on this shape.
    for index, scene in enumerate(screenplay.scenes):
        scene.id = f"s{index + 1}"

    # The aspect the user asked for is authoritative; the LLM's echo of it
    # is only a fallback (models drop or mangle the field).
    aspect = graph.nodes["script"].params.get("aspect") or screenplay.aspect

    _ensure_node(
        graph,
        "timeline",
        NodeKind.TIMELINE,
        # edl_version is part of the node hash: bumping it invalidates
        # cached timeline artifacts when the EDL schema changes.
        params={"aspect": aspect, "edl_version": EDL_VERSION},
    )

    for scene in screenplay.scenes:
        kf_id = f"{scene.id}.keyframe"
        clip_id = f"{scene.id}.clip"
        narr_id = f"{scene.id}.narration"

        _ensure_node(
            graph,
            kf_id,
            NodeKind.KEYFRAME,
            params={
                "prompt": f"{scene.visual}, {screenplay.style.visual}",
                "aspect": aspect,
            },
        )
        _ensure_node(
            graph,
            clip_id,
            NodeKind.CLIP,
            params={
                "prompt": scene.visual,
                "motion": scene.motion,
                "duration_s": scene.duration_s,
                "aspect": aspect,
                "mode": "i2v",  # I2V from the approved keyframe
                "onscreen_text": scene.onscreen_text,
            },
        )
        _ensure_node(
            graph,
            narr_id,
            NodeKind.NARRATION,
            params={"text": scene.narration, "voice": screenplay.style.voice},
        )
        _ensure_edge(graph, "script", kf_id)
        _ensure_edge(graph, kf_id, clip_id, port=KEYFRAME_PORT)
        _ensure_edge(graph, "script", narr_id)
        _ensure_edge(graph, clip_id, "timeline", port=scene.id)
        _ensure_edge(graph, narr_id, "timeline", port=f"{scene.id}{SCENE_AUDIO_SUFFIX}")

    # Scenes the new screenplay no longer has (and legacy narration→clip
    # timing edges, which nothing reads and which block clip renders).
    wanted = {scene.id for scene in screenplay.scenes}
    stale = {
        n.split(".")[0]
        for n in graph.nodes
        if "." in n and n.split(".")[0] not in wanted and n.split(".")[0][0] == "s"
    }
    for scene_id in stale:
        _remove_scene(graph, scene_id)
    graph.edges = [e for e in graph.edges if e.port != TIMING_PORT]

    _ensure_node(
        graph,
        "music",
        NodeKind.MUSIC,
        params={
            "brief": screenplay.style.music,
            "target_duration_s": screenplay.target_duration_s,
        },
    )
    _ensure_edge(graph, "script", "music")
    _ensure_edge(graph, "music", "timeline", port=MUSIC_PORT)

    _ensure_node(graph, "captions", NodeKind.CAPTIONS, params={"style": "word-timed"})
    _ensure_edge(graph, "timeline", "captions")

    _ensure_node(
        graph,
        "export",
        NodeKind.EXPORT,
        params={"format": "mp4", "preset": "youtube", "aspect": aspect},
    )
    _ensure_edge(graph, "timeline", "export")
    _ensure_edge(graph, "captions", "export", port=CAPTIONS_PORT)
    return graph
