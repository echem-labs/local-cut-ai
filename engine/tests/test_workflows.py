"""Workflow template filling: LTX dimension/frame constraints and prompt
escaping — pure functions, no ComfyUI needed."""

import json
import pathlib

import pytest
from conftest import make_spec

from localcut_engine.backends.comfyui import ComfyUIBackend
from localcut_engine.backends.kokoro import pick_voice
from localcut_engine.graph.model import NodeKind


def test_clip_workflow_respects_ltx_constraints():
    backend = ComfyUIBackend()
    spec = make_spec(
        NodeKind.CLIP,
        {
            "prompt": 'a "quoted" prompt\nwith newline',
            "motion": "slow push-in",
            "aspect": "9:16",
            "duration_s": 4.5,
        },
        seed=7,
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
    spec = make_spec(
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
        make_spec(NodeKind.KEYFRAME, {"prompt": "octopus", "aspect": "9:16"}), None
    )
    latent = workflow["latent"]["inputs"]
    assert (latent["width"], latent["height"]) == (768, 1344)


def test_music_workflow_gets_brief_and_seconds():
    backend = ComfyUIBackend(kinds="keyframe,thumbnail,clip,music")
    workflow = backend._fill_workflow(
        make_spec(NodeKind.MUSIC, {"brief": "lofi upbeat", "target_duration_s": 32}), None
    )
    assert workflow["latent"]["inputs"]["seconds"] == 32.0
    assert "lofi upbeat" in workflow["positive"]["inputs"]["tags"]
    assert json.dumps(workflow)  # valid JSON throughout


def test_final_quality_scales_steps_and_resolution():
    """Draft→final ladder: same graph, one quality parameter."""
    backend = ComfyUIBackend()
    params = {"prompt": "x", "aspect": "9:16", "duration_s": 4}
    draft = backend._fill_workflow(make_spec(NodeKind.CLIP, params), keyframe_name="kf.png")
    final = backend._fill_workflow(
        make_spec(NodeKind.CLIP, params, quality="final"), keyframe_name="kf.png"
    )
    d, f = draft["img_to_video"]["inputs"], final["img_to_video"]["inputs"]
    assert f["width"] > d["width"] and f["width"] % 32 == 0
    assert final["sampler"]["inputs"]["steps"] > draft["sampler"]["inputs"]["steps"]
    # Images already render at delivery resolution — only steps scale.
    kf_draft = backend._fill_workflow(make_spec(NodeKind.KEYFRAME, params), None)
    kf_final = backend._fill_workflow(make_spec(NodeKind.KEYFRAME, params, quality="final"), None)
    assert kf_final["latent"]["inputs"]["width"] == kf_draft["latent"]["inputs"]["width"]
    assert kf_final["sampler"]["inputs"]["steps"] > kf_draft["sampler"]["inputs"]["steps"]


def test_model_switches_workflow_template():
    """Model switching is a template swap fed by the manifest: a clip whose
    model is the Wan entry renders through the Wan workflow (16 fps frame
    rule, two-stage sampler handover), everything else keeps the default."""
    backend = ComfyUIBackend(model_templates={"wan2.2-i2v-14b-fp8": "wan22_i2v.json"})
    params = {"prompt": "x", "motion": "pan", "aspect": "9:16", "duration_s": 5}
    spec = make_spec(
        NodeKind.CLIP, params, model="local:wan2.2-i2v-14b-fp8", quality="final", seed=3
    )
    assert backend._template_path(spec).name == "wan22_i2v.json"
    workflow = backend._fill_workflow(spec, keyframe_name="kf.png")
    i2v = workflow["img_to_video"]["inputs"]
    assert i2v["length"] == 81  # 5 s at 16 fps, 4n+1
    assert i2v["width"] % 32 == 0 and i2v["height"] % 32 == 0
    high, low = workflow["sampler_high"]["inputs"], workflow["sampler_low"]["inputs"]
    assert high["end_at_step"] == low["start_at_step"] > 0  # mid-schedule handover
    assert high["steps"] == low["steps"]
    assert workflow["sampler_high"]["inputs"]["noise_seed"] == 3
    assert workflow["create_video"]["inputs"]["fps"] == 16

    # Unlisted (or absent) models keep the kind's default template.
    assert backend._template_path(make_spec(NodeKind.CLIP, params)).name == "clip_default.json"
    assert (
        backend._template_path(
            make_spec(NodeKind.CLIP, params, model="local:some-other-model")
        ).name
        == "clip_default.json"
    )


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
    assert {
        "keyframe_default.json",
        "thumbnail_default.json",
        "clip_default.json",
        "music_default.json",
    } <= names
    for path in templates.glob("*.json"):
        text = path.read_text()
        # Substitute via the same table the backend exports, so templates and
        # _fill_workflow cannot drift apart silently.
        for token in PLACEHOLDERS:
            text = text.replace(f'"{token}"', "0").replace(token, "x")
        workflow = json.loads(text)
        for node in workflow.values():
            assert "class_type" in node, f"{path.name}: non-node entry"


def test_manifest_template_references_exist():
    """Every comfy_graph_template named in the default manifest must ship as
    a packaged template — a dangling reference fails every job for that
    model with 'missing workflow template'."""
    import importlib.resources

    from localcut_engine.config import EngineConfig
    from localcut_engine.manifest.loader import load_manifest

    packaged = {
        p.name
        for p in pathlib.Path(
            str(importlib.resources.files("localcut_engine.comfy_templates"))
        ).glob("*.json")
    }
    manifest = load_manifest(EngineConfig(data_dir=pathlib.Path("/nonexistent")))
    dangling = {
        m.id: m.comfy_graph_template
        for m in manifest.models
        if m.comfy_graph_template and m.comfy_graph_template not in packaged
    }
    assert dangling == {}


def test_prompt_containing_placeholder_tokens_stays_literal():
    """User text must never be re-substituted by later placeholders."""
    backend = ComfyUIBackend()
    spec = make_spec(
        NodeKind.CLIP,
        {
            "prompt": "render %%KEYFRAME%% and %%SEED%% literally",
            "motion": "pan",
            "aspect": "9:16",
            "duration_s": 4,
        },
    )
    workflow = backend._fill_workflow(spec, keyframe_name="server-kf.png")
    text = workflow["positive"]["inputs"]["text"]
    assert "%%KEYFRAME%%" in text and "%%SEED%%" in text
    assert "server-kf.png" not in text
    assert workflow["load_keyframe"]["inputs"]["image"] == "server-kf.png"


def test_zero_duration_rejected():
    from localcut_engine.backends.base import GenerationError

    backend = ComfyUIBackend()
    spec = make_spec(NodeKind.CLIP, {"prompt": "x", "aspect": "9:16", "duration_s": 0})
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
        "s1.clip",
        "s2.clip",
        "s3.clip",
    }
    # Narration order preserved: s1 is the first scene as authored.
    assert graph.nodes["s1.narration"].params["text"] == "a"


def test_reexpansion_applies_new_screenplay():
    """A regenerated script must actually land: params updated in place,
    surplus scenes dropped, user state (seed/pin) preserved."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("topic")
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="one", visual="v1"),
                Scene(id="b", duration_s=4, narration="two", visual="v2"),
            ],
        ),
    )
    graph.nodes["s1.keyframe"].seed = 99  # user state must survive re-runs
    graph.nodes["s1.clip"].pinned = True

    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="x", duration_s=4, narration="uno", visual="w1"),
            ],
        ),
    )
    assert graph.nodes["s1.narration"].params["text"] == "uno"
    assert graph.nodes["s1.keyframe"].params["prompt"].startswith("w1")
    assert graph.nodes["s1.keyframe"].seed == 99
    assert graph.nodes["s1.clip"].pinned
    assert "s2.clip" not in graph.nodes
    assert not any("s2" in (e.src.split(".")[0], e.dst.split(".")[0]) for e in graph.edges)


def test_reexpansion_preserves_timeline_and_export_edit_state():
    """Reorder/trims/transitions and the burn/sidecar choice are user work:
    a script re-run refreshes derived params but must not wipe them (edits
    referencing dropped scenes do get pruned)."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("topic")
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="one", visual="v1"),
                Scene(id="b", duration_s=4, narration="two", visual="v2"),
            ],
        ),
    )
    graph.nodes["timeline"].params.update(
        order=["s2", "s1"],
        trims={"s1": {"in": 0.5}, "s2": {"in": 0.2}},
        transitions={"s1": "crossfade"},
    )
    graph.nodes["export"].params["captions"] = "sidecar"

    # Same scene count: everything survives verbatim.
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="uno", visual="w1"),
                Scene(id="b", duration_s=4, narration="dos", visual="w2"),
            ],
        ),
    )
    timeline = graph.nodes["timeline"].params
    assert timeline["order"] == ["s2", "s1"]
    assert timeline["trims"] == {"s1": {"in": 0.5}, "s2": {"in": 0.2}}
    assert timeline["transitions"] == {"s1": "crossfade"}
    assert graph.nodes["export"].params["captions"] == "sidecar"

    # Scene s2 dropped: its edit-state references are pruned with it.
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="only", visual="w1"),
            ],
        ),
    )
    timeline = graph.nodes["timeline"].params
    assert timeline["order"] == ["s1"]
    assert timeline["trims"] == {"s1": {"in": 0.5}}
    assert timeline["transitions"] == {"s1": "crossfade"}


def test_long_scene_splits_into_sequential_takes():
    """Narration past the clip-length ceiling splits the scene into takes on
    the same keyframe — no single stretched clip. Re-scripting shorter drops
    the surplus takes."""
    from localcut_engine.graph.model import KEYFRAME_PORT
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("topic")
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=20, narration="long", visual="v1", motion="pan"),
                Scene(id="b", duration_s=4, narration="short", visual="v2"),
            ],
        ),
    )
    takes = sorted(n for n in graph.nodes if n.startswith("s1.clip"))
    assert takes == ["s1.clip", "s1.clip2", "s1.clip3"]
    for take_id in takes:
        node = graph.nodes[take_id]
        assert node.params["duration_s"] == pytest.approx(20 / 3, abs=0.01)
        # Every take conditions on the same approved keyframe.
        assert any(
            e.src == "s1.keyframe" and e.dst == take_id and e.port == KEYFRAME_PORT
            for e in graph.edges
        )
    # Later takes are distinct shots, not copies of take 1.
    assert graph.nodes["s1.clip"].params["motion"] != graph.nodes["s1.clip2"].params["motion"]
    ports = {e.port for e in graph.edges if e.dst == "timeline" and e.src.startswith("s1.clip")}
    assert ports == {"s1", "s1.p2", "s1.p3"}
    # Short scenes keep the hash-stable single-take shape (no take marker).
    assert "take" not in graph.nodes["s2.clip"].params
    assert "s2.clip2" not in graph.nodes

    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="short now", visual="v1"),
            ],
        ),
    )
    assert "s1.clip2" not in graph.nodes and "s1.clip3" not in graph.nodes
    assert not any("clip2" in (e.src, e.dst) or "clip3" in (e.src, e.dst) for e in graph.edges)


def test_expansion_uses_requested_aspect_over_llm_echo():
    """The user's aspect is authoritative; the LLM echo (or its 16:9 schema
    default when omitted) must not override it."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("topic", aspect="9:16")
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[
                Scene(id="a", duration_s=4, narration="n", visual="v", onscreen_text="HOOK!"),
            ],
        ),
    )  # screenplay.aspect defaults to "16:9"
    assert graph.nodes["s1.keyframe"].params["aspect"] == "9:16"
    assert graph.nodes["s1.clip"].params["aspect"] == "9:16"
    assert graph.nodes["export"].params["aspect"] == "9:16"
    # On-screen text is presentation data: it rides on the timeline node so
    # title edits never re-render clips.
    assert graph.nodes["timeline"].params["overlays"] == {"s1": "HOOK!"}
