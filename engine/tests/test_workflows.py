"""Workflow template filling: LTX dimension/frame constraints and prompt
escaping — pure functions, no ComfyUI needed."""

import json
import pathlib

import pytest

from localcut_engine.backends.comfyui import ComfyUIBackend
from localcut_engine.backends.kokoro import pick_voice
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind


def spec_for(kind: NodeKind, params: dict, seed: int = 7) -> JobSpec:
    return JobSpec(
        node_id="n", kind=kind, output_hash="a" * 64,
        params=params, model=None, seed=seed, input_hashes={},
    )


def test_clip_workflow_respects_ltx_constraints():
    backend = ComfyUIBackend()
    spec = spec_for(
        NodeKind.CLIP,
        {"prompt": 'a "quoted" prompt\nwith newline', "motion": "slow push-in",
         "aspect": "9:16", "duration_s": 4.5},
    )
    workflow = backend._fill_workflow(spec, keyframe_name="kf.png")
    i2v = workflow["img_to_video"]["inputs"]
    assert i2v["width"] % 32 == 0 and i2v["height"] % 32 == 0
    assert (i2v["length"] - 1) % 8 == 0  # LTX frame constraint
    assert workflow["load_keyframe"]["inputs"]["image"] == "kf.png"
    assert "slow push-in" in workflow["positive"]["inputs"]["text"]
    assert workflow["sampler"]["inputs"]["seed"] == 7


def test_oom_ladder_scale_keeps_dimensions_valid():
    backend = ComfyUIBackend()
    spec = spec_for(
        NodeKind.CLIP,
        {"prompt": "x", "aspect": "9:16", "duration_s": 5, "resolution_scale": 0.5},
    )
    workflow = backend._fill_workflow(spec, keyframe_name="kf.png")
    i2v = workflow["img_to_video"]["inputs"]
    assert i2v["width"] % 32 == 0 and i2v["height"] % 32 == 0
    assert i2v["width"] < 448


def test_keyframe_workflow_uses_image_resolution():
    backend = ComfyUIBackend()
    workflow = backend._fill_workflow(
        spec_for(NodeKind.KEYFRAME, {"prompt": "octopus", "aspect": "9:16"}), None
    )
    latent = workflow["latent"]["inputs"]
    assert (latent["width"], latent["height"]) == (768, 1344)


def test_music_workflow_gets_brief_and_seconds():
    backend = ComfyUIBackend(kinds="keyframe,thumbnail,clip,music")
    workflow = backend._fill_workflow(
        spec_for(NodeKind.MUSIC, {"brief": "lofi upbeat", "target_duration_s": 32}), None
    )
    assert workflow["latent"]["inputs"]["seconds"] == 32.0
    assert "lofi upbeat" in workflow["positive"]["inputs"]["tags"]
    assert json.dumps(workflow)  # valid JSON throughout


def test_voice_picker():
    assert pick_voice("energetic male narrator") == "am_michael"
    assert pick_voice("calm female voice") == "af_sarah"
    assert pick_voice("deep female voice") == "af_sarah"  # gender outranks tone
    assert pick_voice("deep gravelly narrator") == "am_onyx"


def test_all_packaged_templates_are_valid_json():
    import importlib.resources

    from localcut_engine.backends.comfyui import PLACEHOLDERS

    templates = pathlib.Path(str(importlib.resources.files("localcut_engine.comfy_templates")))
    names = {p.name for p in templates.glob("*.json")}
    assert {"keyframe_default.json", "thumbnail_default.json",
            "clip_default.json", "music_default.json"} <= names
    for path in templates.glob("*.json"):
        text = path.read_text()
        # Substitute via the same table the backend exports, so templates and
        # _fill_workflow cannot drift apart silently.
        for token in PLACEHOLDERS:
            text = text.replace(f'"{token}"', "0").replace(token, "x")
        workflow = json.loads(text)
        for node in workflow.values():
            assert "class_type" in node, f"{path.name}: non-node entry"


def test_prompt_containing_placeholder_tokens_stays_literal():
    """User text must never be re-substituted by later placeholders."""
    backend = ComfyUIBackend()
    spec = spec_for(
        NodeKind.CLIP,
        {"prompt": "render %%KEYFRAME%% and %%SEED%% literally", "motion": "pan",
         "aspect": "9:16", "duration_s": 4},
    )
    workflow = backend._fill_workflow(spec, keyframe_name="server-kf.png")
    text = workflow["positive"]["inputs"]["text"]
    assert "%%KEYFRAME%%" in text and "%%SEED%%" in text
    assert "server-kf.png" not in text
    assert workflow["load_keyframe"]["inputs"]["image"] == "server-kf.png"


def test_zero_duration_rejected():
    from localcut_engine.backends.base import GenerationError

    backend = ComfyUIBackend()
    spec = spec_for(NodeKind.CLIP, {"prompt": "x", "aspect": "9:16", "duration_s": 0})
    with pytest.raises(GenerationError, match="invalid duration"):
        backend._fill_workflow(spec, keyframe_name="kf.png")


def test_scene_ids_are_canonicalized_on_expansion():
    """LLM-emitted ids (arbitrary shapes, duplicates) must not leak into
    node ids or ordering."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    screenplay = Screenplay(
        title="t",
        scenes=[
            Scene(id="scene10", duration_s=4, narration="a", visual="v1"),
            Scene(id="scene2", duration_s=4, narration="b", visual="v2"),
            Scene(id="scene2", duration_s=4, narration="c", visual="v3"),  # duplicate
        ],
    )
    graph = prompt_template_graph("topic")
    expand_screenplay(graph, screenplay)
    assert {n for n in graph.nodes if n.endswith(".clip")} == {
        "s1.clip", "s2.clip", "s3.clip",
    }
    # Narration order preserved: s1 is the first scene as authored.
    assert graph.nodes["s1.narration"].params["text"] == "a"
