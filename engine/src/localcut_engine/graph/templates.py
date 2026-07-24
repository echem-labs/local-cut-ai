"""Template graphs — prompt-only mode instantiates these.

Two-stage: the initial graph carries just the Script node; once the LLM
returns a structured screenplay, `expand_screenplay` turns each scene
into its subgraph (keyframe → clip, narration) plus shared music,
captions, timeline and export nodes.
"""

from __future__ import annotations

import math

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


def tool_graph(tool: str, params: dict) -> StoryGraph:
    """Quick Tools are micro-projects: a tiny template graph (usually one
    node; the clip tool carries its keyframe conditioning), same engine,
    same caching. Outputs export directly or promote into a full project."""
    graph = StoryGraph()
    match tool:
        case "script":
            graph.add_node(
                Node(
                    id="script",
                    kind=NodeKind.SCRIPT,
                    params={
                        "prompt": str(params.get("prompt", "")),
                        "target_duration_s": int(params.get("target_duration_s", 60)),
                        "aspect": str(params.get("aspect", "9:16")),
                        "style_preset": str(params.get("style_preset", "cinematic")),
                    },
                )
            )
        case "thumbnail":
            graph.add_node(
                Node(
                    id="thumbnail",
                    kind=NodeKind.THUMBNAIL,
                    params={
                        "prompt": str(params.get("prompt", "")),
                        "aspect": str(params.get("aspect", "16:9")),
                    },
                )
            )
        case "voiceover":
            graph.add_node(
                Node(
                    id="voiceover",
                    kind=NodeKind.NARRATION,
                    params={
                        "text": str(params.get("text", "")),
                        "voice": str(params.get("voice", "narrator")),
                    },
                )
            )
        case "image":
            graph.add_node(
                Node(
                    id="image",
                    kind=NodeKind.KEYFRAME,
                    params={
                        "prompt": str(params.get("prompt", "")),
                        "aspect": str(params.get("aspect", "16:9")),
                    },
                )
            )
        case "music":
            graph.add_node(
                Node(
                    id="music",
                    kind=NodeKind.MUSIC,
                    params={
                        "brief": str(params.get("prompt", "")),
                        # The standalone tool honours the length the user
                        # asked for (unlike the assembly bed, which loops and
                        # so caps at MAX_MUSIC_S) — but not past what the
                        # generator will accept, or the job just fails.
                        "target_duration_s": min(
                            int(params.get("target_duration_s", 60)), GENERATOR_MAX_MUSIC_S
                        ),
                    },
                )
            )
        case "clip":
            # I2V needs a source frame: the tool is keyframe → clip, so a
            # standalone clip gets the same conditioning quality as a scene.
            graph.add_node(
                Node(
                    id="keyframe",
                    kind=NodeKind.KEYFRAME,
                    params={
                        "prompt": str(params.get("prompt", "")),
                        "aspect": str(params.get("aspect", "16:9")),
                    },
                )
            )
            graph.add_node(
                Node(
                    id="clip",
                    kind=NodeKind.CLIP,
                    params={
                        "prompt": str(params.get("prompt", "")),
                        "motion": str(params.get("motion") or "slow cinematic camera move"),
                        "duration_s": float(params.get("duration_s", 5.0)),
                        "aspect": str(params.get("aspect", "16:9")),
                        "mode": "i2v",
                    },
                )
            )
            graph.connect("keyframe", "clip", port=KEYFRAME_PORT)
        case _:
            raise ValueError(f"unknown quick tool: {tool!r}")
    return graph


# Local video models top out at short takes; a scene whose narration runs
# longer splits into sequential takes on the same approved keyframe rather
# than stretching one clip into silent slow-mo (assembly enforces the ±15%
# retime bound on whatever length actually renders).
MAX_CLIP_S = 8.0

# Music is a loopable bed, not a full score: cap what we ask the generator
# for. ACE-Step's own node refuses more than 1000s, and a multi-minute
# request is a slow, VRAM-hungry way to produce something assembly would
# have looped anyway.
MAX_MUSIC_S = 180

# The generator's own ceiling. Assembly never approaches it (MAX_MUSIC_S is
# far lower), but the standalone music tool passes the user's length through
# and must still land inside what ACE-Step will accept.
GENERATOR_MAX_MUSIC_S = 1000


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
    # Prefix-based: a split scene owns clip takes beyond the fixed member set.
    members = {n for n in graph.nodes if n.startswith(f"{scene_id}.")}
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

    # Timeline edit state (reorder/trims/transitions) is user work, like
    # seeds and pins: a script re-run must not wipe it. Carry it over,
    # dropping references to scenes the new screenplay no longer has.
    scene_ids = {scene.id for scene in screenplay.scenes}
    old_timeline = node.params if (node := graph.nodes.get("timeline")) else {}
    timeline_params = {
        "aspect": aspect,
        # edl_version is part of the node hash: bumping it invalidates
        # cached timeline artifacts when the EDL schema changes. Overlays
        # live here (not on clip nodes) because they are presentation-time
        # data the assembly consumes — editing a title must not re-render
        # the clip. They are content-derived, so the new screenplay wins.
        "edl_version": EDL_VERSION,
        "overlays": {
            scene.id: scene.onscreen_text for scene in screenplay.scenes if scene.onscreen_text
        },
    }
    if order := [s for s in (old_timeline.get("order") or []) if s in scene_ids]:
        timeline_params["order"] = order
    for edits_key in ("trims", "transitions"):
        if edits := {
            s: v for s, v in (old_timeline.get(edits_key) or {}).items() if s in scene_ids
        }:
            timeline_params[edits_key] = edits
    for flag in ("ducking", "beat_align"):  # audio choices are user state too
        if flag in old_timeline:
            timeline_params[flag] = old_timeline[flag]
    _ensure_node(graph, "timeline", NodeKind.TIMELINE, params=timeline_params)

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
        # What feeds this scene's keyframe port: the generated keyframe by
        # default, or a user asset the scene was conditioned on. Conditioning
        # is a scene-level choice, so a scene that later splits into takes
        # animates every take from the same source, not take 1 alone.
        conditioned = next(
            (
                e.src
                for e in graph.edges
                if e.dst == clip_id and e.port == KEYFRAME_PORT and e.src != kf_id
            ),
            None,
        )
        kf_source = conditioned or kf_id
        takes = max(1, math.ceil(scene.duration_s / MAX_CLIP_S))
        take_s = round(scene.duration_s / takes, 3)
        for take in range(1, takes + 1):
            take_id = clip_id if take == 1 else f"{clip_id}{take}"
            params = {
                "prompt": scene.visual,
                # Later takes vary the camera direction: same approved
                # keyframe, visibly distinct motion — not a copy of take 1.
                "motion": scene.motion
                if take == 1
                else f"{scene.motion}, continuing shot, alternate take {take}",
                "duration_s": take_s if takes > 1 else scene.duration_s,
                "aspect": aspect,
                "mode": "i2v",  # I2V from the approved keyframe
                "onscreen_text": scene.onscreen_text,
            }
            if takes > 1:
                params["take"] = take  # single-take params stay hash-stable
            _ensure_node(graph, take_id, NodeKind.CLIP, params=params)
            # User conditioning is user state: a clip whose keyframe port was
            # rewired to an uploaded asset keeps that source across re-runs,
            # and new takes of a conditioned scene draw from the same asset.
            if not any(e.dst == take_id and e.port == KEYFRAME_PORT for e in graph.edges):
                _ensure_edge(graph, kf_source, take_id, port=KEYFRAME_PORT)
            _ensure_edge(
                graph,
                take_id,
                "timeline",
                port=scene.id if take == 1 else f"{scene.id}.p{take}",
            )
        # Takes beyond the new count (narration shortened on re-script).
        for stale_take in [
            n
            for n in list(graph.nodes)
            if n.startswith(clip_id)
            and n != clip_id
            and n.removeprefix(clip_id).isdigit()
            and int(n.removeprefix(clip_id)) > takes
        ]:
            graph.edges = [e for e in graph.edges if stale_take not in (e.src, e.dst)]
            graph.nodes.pop(stale_take)

        # Speech speed has no screenplay source — it exists only because the
        # user set it. Like seeds, pins and timeline edits, it has to survive
        # a re-expansion; otherwise the node hash reverts to the pre-edit
        # value, the cached pre-edit audio is served, and the Inspector
        # quietly shows 1.0 again.
        narration_params: dict = {"text": scene.narration, "voice": screenplay.style.voice}
        if (existing := graph.nodes.get(narr_id)) and "speed" in existing.params:
            narration_params["speed"] = existing.params["speed"]
        _ensure_node(graph, narr_id, NodeKind.NARRATION, params=narration_params)
        _ensure_edge(graph, "script", kf_id)
        _ensure_edge(graph, "script", narr_id)
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
            # The bed loops to fill the program (assembly passes -stream_loop),
            # so generating a full-length track buys nothing and costs a lot:
            # a long request is slow, VRAM-hungry, and past MAX_MUSIC_S the
            # local generator rejects it outright.
            "target_duration_s": min(screenplay.target_duration_s, MAX_MUSIC_S),
        },
    )
    _ensure_edge(graph, "script", "music")
    _ensure_edge(graph, "music", "timeline", port=MUSIC_PORT)

    _ensure_node(
        graph,
        "captions",
        NodeKind.CAPTIONS,
        params={
            "style": "word-timed",
            # Ground truth for the align backend: caption text comes from the
            # script verbatim; the audio only contributes word timing (free
            # transcription mishears homophones and drops punctuation).
            "texts": {scene.id: scene.narration for scene in screenplay.scenes},
        },
    )
    _ensure_edge(graph, "timeline", "captions")

    old_export = node.params if (node := graph.nodes.get("export")) else {}
    _ensure_node(
        graph,
        "export",
        NodeKind.EXPORT,
        params={
            "format": "mp4",
            "preset": "youtube",
            "aspect": aspect,
            # The burn/sidecar choice is the user's, not the screenplay's —
            # it survives re-expansion.
            "captions": old_export.get("captions", "burn"),
        },
    )
    _ensure_edge(graph, "timeline", "export")
    _ensure_edge(graph, "captions", "export", port=CAPTIONS_PORT)
    return graph
