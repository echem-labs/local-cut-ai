from localcut_engine.graph.compiler import compile_graph
from localcut_engine.graph.model import Node, NodeKind, StoryGraph
from localcut_engine.graph.patch import PatchOp, apply_patch
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.backends.mock import mock_screenplay

import pytest


def small_graph() -> StoryGraph:
    g = StoryGraph()
    g.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "octopus"}))
    g.add_node(Node(id="kf", kind=NodeKind.KEYFRAME, params={"prompt": "eye"}))
    g.add_node(Node(id="clip", kind=NodeKind.CLIP, params={"motion": "push"}))
    g.connect("script", "kf")
    g.connect("kf", "clip", port="keyframe")
    return g


def test_output_hash_stable_and_input_sensitive():
    g = small_graph()
    h1 = g.output_hash("clip")
    assert h1 == small_graph().output_hash("clip")
    g.nodes["script"].params["prompt"] = "changed"
    assert g.output_hash("clip") != h1  # upstream change propagates


def test_seed_changes_hash_but_not_siblings():
    g = small_graph()
    kf_before = g.output_hash("kf")
    g.nodes["clip"].seed = 7
    assert g.output_hash("kf") == kf_before


def test_topological_order_and_cycle_detection():
    g = small_graph()
    order = g.topological_order()
    assert order.index("script") < order.index("kf") < order.index("clip")
    g.edges.append(type(g.edges[0])(src="clip", dst="script"))
    with pytest.raises(ValueError, match="cycle"):
        g.topological_order()


def test_compile_skips_cached_nodes():
    g = small_graph()
    memo: dict[str, str] = {}
    cached = {g.output_hash("script", memo), g.output_hash("kf", memo)}
    plan = compile_graph(g, cached)
    assert [j.node_id for j in plan.jobs] == ["clip"]
    assert set(plan.cached) == {"script", "kf"}


def test_pinned_node_not_recompiled_even_when_dirty():
    g = small_graph()
    frozen_hash = g.output_hash("kf")  # artifact rendered before the edit
    g.nodes["kf"].pinned = True
    g.nodes["script"].params["prompt"] = "new prompt"  # dirties kf's hash
    plan = compile_graph(g, cache_hashes=set(), frozen={"kf": frozen_hash})
    assert "kf" not in [j.node_id for j in plan.jobs]
    # Downstream hashes against the frozen artifact, not the would-be new
    # keyframe — so its input actually resolves to a file that exists.
    clip_job = next(j for j in plan.jobs if j.node_id == "clip")
    assert clip_job.input_hashes["keyframe"] == frozen_hash


def test_unfrozen_pinned_node_renders_once():
    g = small_graph()
    g.nodes["kf"].pinned = True  # pinned before it ever rendered
    plan = compile_graph(g, cache_hashes=set(), frozen={})
    assert "kf" in [j.node_id for j in plan.jobs]


def test_patch_dirties_downstream_cone():
    g = small_graph()
    dirty = apply_patch(g, [PatchOp(op="set_params", node_id="kf", params={"prompt": "x"})])
    assert dirty == {"kf", "clip"}
    assert g.nodes["kf"].params["prompt"] == "x"


def test_pin_dirties_nothing():
    g = small_graph()
    assert apply_patch(g, [PatchOp(op="pin", node_id="kf")]) == set()
    assert g.nodes["kf"].pinned


def test_pin_snapshots_output_identity_on_the_node():
    """The freeze must not depend on job history (which is windowed): the
    hash is captured on the node at pin time and cleared on unpin."""
    g = small_graph()
    expected = g.output_hash("kf")
    apply_patch(g, [PatchOp(op="pin", node_id="kf")])
    assert g.nodes["kf"].frozen_hash == expected
    # An upstream edit must not move the snapshot.
    apply_patch(g, [PatchOp(op="set_params", node_id="script", params={"prompt": "new"})])
    assert g.nodes["kf"].frozen_hash == expected
    apply_patch(g, [PatchOp(op="unpin", node_id="kf")])
    assert g.nodes["kf"].frozen_hash is None


def test_node_ids_are_constrained():
    """Patch bodies must not smuggle in ids the API's path params reject."""
    with pytest.raises(ValueError):
        Node(id=".leading-dot", kind=NodeKind.CLIP)
    with pytest.raises(ValueError):
        Node(id="a" * 200, kind=NodeKind.CLIP)


def test_template_expansion_builds_full_pipeline():
    g = prompt_template_graph("why octopuses have three hearts", target_duration_s=40)
    screenplay = mock_screenplay("why octopuses have three hearts", 40, "9:16", seed=0)
    expand_screenplay(g, screenplay)
    assert "timeline" in g.nodes and "export" in g.nodes and "music" in g.nodes
    scene_clips = [n for n in g.nodes if n.endswith(".clip")]
    assert len(scene_clips) == len(screenplay.scenes) >= 2
    order = g.topological_order()
    assert order.index("timeline") < order.index("export")
