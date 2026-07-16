"""Template graphs — prompt-only mode instantiates these.

Two-stage: the initial graph carries just the Script node; once the LLM
returns a structured screenplay, `expand_screenplay` turns each scene
into its subgraph (keyframe → clip, narration) plus shared music,
captions, timeline and export nodes.
"""

from __future__ import annotations

from ..schema import Screenplay
from .model import Node, NodeKind, StoryGraph


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


def expand_screenplay(graph: StoryGraph, screenplay: Screenplay) -> StoryGraph:
    """Add per-scene subgraphs and the assembly chain below the script node."""
    if "script" not in graph.nodes:
        raise KeyError("template graph has no script node")

    timeline = graph.add_node(
        Node(id="timeline", kind=NodeKind.TIMELINE, params={"aspect": screenplay.aspect})
    )

    for scene in screenplay.scenes:
        kf_id = f"{scene.id}.keyframe"
        clip_id = f"{scene.id}.clip"
        narr_id = f"{scene.id}.narration"

        graph.add_node(
            Node(
                id=kf_id,
                kind=NodeKind.KEYFRAME,
                params={
                    "prompt": f"{scene.visual}, {screenplay.style.visual}",
                    "aspect": screenplay.aspect,
                },
            )
        )
        graph.add_node(
            Node(
                id=clip_id,
                kind=NodeKind.CLIP,
                params={
                    "prompt": scene.visual,
                    "motion": scene.motion,
                    "duration_s": scene.duration_s,
                    "aspect": screenplay.aspect,
                    "mode": "i2v",  # I2V from the approved keyframe
                    "onscreen_text": scene.onscreen_text,
                },
            )
        )
        graph.add_node(
            Node(
                id=narr_id,
                kind=NodeKind.NARRATION,
                params={"text": scene.narration, "voice": screenplay.style.voice},
            )
        )
        graph.connect("script", kf_id)
        graph.connect(kf_id, clip_id, port="keyframe")
        graph.connect("script", narr_id)
        # Narration duration drives scene duration (not vice versa).
        graph.connect(narr_id, clip_id, port="timing")
        graph.connect(clip_id, timeline.id, port=scene.id)
        graph.connect(narr_id, timeline.id, port=f"{scene.id}.audio")

    graph.add_node(
        Node(
            id="music",
            kind=NodeKind.MUSIC,
            params={
                "brief": screenplay.style.music,
                "target_duration_s": screenplay.target_duration_s,
            },
        )
    )
    graph.connect("script", "music")
    graph.connect("music", "timeline", port="music")

    graph.add_node(Node(id="captions", kind=NodeKind.CAPTIONS, params={"style": "word-timed"}))
    graph.connect("timeline", "captions")

    graph.add_node(
        Node(
            id="export",
            kind=NodeKind.EXPORT,
            params={"format": "mp4", "preset": "youtube", "aspect": screenplay.aspect},
        )
    )
    graph.connect("timeline", "export")
    graph.connect("captions", "export", port="captions")
    return graph
