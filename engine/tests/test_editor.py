"""Natural-language editing: the whitelisted view the LLM sees, and the
compiler that turns its untrusted edit plan into validated PatchOps."""

import pytest

from localcut_engine.graph.editor import (
    EditPlan,
    compile_edits,
    graph_view,
    parse_edit_plan,
)
from localcut_engine.graph.patch import apply_patch
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.schema import Scene, Screenplay


def make_graph(scenes: int = 3):
    graph = prompt_template_graph("volcano documentary", aspect="9:16")
    screenplay = Screenplay(
        title="Volcanoes",
        scenes=[
            Scene(
                id=f"s{i}",
                duration_s=5.0,
                narration=f"Narration {i}.",
                visual=f"visual {i}",
                motion="slow pan",
                onscreen_text="BOOM" if i == 1 else None,
            )
            for i in range(1, scenes + 1)
        ],
    )
    return expand_screenplay(graph, screenplay)


def plan(*edits: dict) -> EditPlan:
    return EditPlan.model_validate({"summary": "test", "edits": list(edits)})


# -- the view ---------------------------------------------------------------


def test_view_shows_only_whitelisted_params_and_no_script_node():
    view = graph_view(make_graph())
    node_ids = {n["node_id"] for s in view["scenes"] for n in s["nodes"]}
    assert "s1.keyframe" in node_ids and "s2.narration" in node_ids
    keyframe = next(n for s in view["scenes"] for n in s["nodes"] if n["node_id"] == "s1.keyframe")
    assert set(keyframe["params"]) == {"prompt"}  # aspect is not editable
    assert "script" not in node_ids  # narrative restructuring = re-script
    assert view["brief"]["prompt"] == "volcano documentary"
    assert view["timeline"]["node_id"] == "timeline"


def test_view_scene_scope_is_just_that_scene():
    view = graph_view(make_graph(), scope="s2")
    assert [s["scene_id"] for s in view["scenes"]] == ["s2"]
    assert "timeline" not in view and "brief" not in view
    with pytest.raises(KeyError):
        graph_view(make_graph(), scope="s9")


def test_view_marks_pinned_nodes():
    graph = make_graph()
    graph.nodes["s1.clip"].pinned = True
    view = graph_view(graph, scope="s1")
    clip = next(n for s in view["scenes"] for n in s["nodes"] if n["node_id"] == "s1.clip")
    assert clip["pinned"] is True


# -- compiling updates ------------------------------------------------------


def test_update_compiles_to_set_params():
    graph = make_graph()
    ops, warnings = compile_edits(
        graph,
        plan({"action": "update", "node_id": "s2.keyframe", "params": {"prompt": "at night"}}),
    )
    assert warnings == []
    assert len(ops) == 1 and ops[0].op == "set_params" and ops[0].node_id == "s2.keyframe"
    dirty = apply_patch(graph, ops)
    assert graph.nodes["s2.keyframe"].params["prompt"] == "at night"
    assert "s2.clip" in dirty and "timeline" in dirty  # downstream cone


def test_update_filters_foreign_keys_pinned_nodes_and_unknown_nodes():
    graph = make_graph()
    graph.nodes["s1.clip"].pinned = True
    ops, warnings = compile_edits(
        graph,
        plan(
            {"action": "update", "node_id": "s2.keyframe", "params": {"seed": 7, "prompt": "x"}},
            {"action": "update", "node_id": "s1.clip", "params": {"prompt": "y"}},
            {"action": "update", "node_id": "ghost", "params": {"prompt": "z"}},
        ),
    )
    assert len(ops) == 1  # only the legal half of the first edit
    assert ops[0].params == {"prompt": "x"}
    assert any("not editable" in w for w in warnings)
    assert any("pinned" in w for w in warnings)
    assert any("unknown node" in w for w in warnings)


def test_scene_scope_rejects_edits_outside_the_scene():
    ops, warnings = compile_edits(
        make_graph(),
        plan(
            {"action": "update", "node_id": "s2.narration", "params": {"text": "New line."}},
            {"action": "update", "node_id": "music", "params": {"brief": "lo-fi"}},
        ),
        scope="s2",
    )
    assert [op.node_id for op in ops] == ["s2.narration"]
    assert any("outside" in w for w in warnings)


def test_value_sanitizers_clamp_and_validate():
    graph = make_graph()
    ops, warnings = compile_edits(
        graph,
        plan(
            {"action": "update", "node_id": "s1.clip", "params": {"duration_s": 99}},
            {
                "action": "update",
                "node_id": "timeline",
                "params": {
                    "transitions": {"s1": "wipe", "s2": "crossfade", "s9": "cut"},
                    "order": ["s2", "s1", "s2", "ghost"],
                    "overlays": {"s1": None},
                },
            },
            {"action": "update", "node_id": "export", "params": {"captions": "vaporize"}},
        ),
    )
    by_node = {op.node_id: op.params for op in ops}
    assert by_node["s1.clip"]["duration_s"] == 15.0  # clamped
    assert by_node["timeline"]["transitions"] == {"s2": "crossfade"}
    assert by_node["timeline"]["order"] == ["s2", "s1"]  # deduped, unknowns dropped
    assert by_node["timeline"]["overlays"] == {"s1": None}  # None clears a title
    assert "export" not in by_node  # bad caption mode → no op at all
    assert any("must be one of" in w for w in warnings)


# -- removing scenes --------------------------------------------------------


def test_remove_scene_drops_members_and_scrubs_timeline():
    graph = make_graph()
    graph.nodes["timeline"].params["transitions"] = {"s2": "crossfade", "s3": "dip"}
    graph.nodes["timeline"].params["order"] = ["s3", "s2", "s1"]
    ops, warnings = compile_edits(graph, plan({"action": "remove_scene", "scene_id": "s2"}))
    assert warnings == []
    apply_patch(graph, ops)
    assert not any(n.startswith("s2.") for n in graph.nodes)
    assert not any(e.src.startswith("s2.") or e.dst.startswith("s2.") for e in graph.edges)
    timeline = graph.nodes["timeline"].params
    assert timeline["order"] == ["s3", "s1"]
    assert timeline["transitions"] == {"s3": "dip"}
    assert "s2" not in timeline["overlays"]


def test_remove_scene_wins_over_updates_to_it_and_respects_reorder():
    graph = make_graph()
    ops, warnings = compile_edits(
        graph,
        plan(
            {"action": "update", "node_id": "s3.narration", "params": {"text": "gone"}},
            {"action": "update", "node_id": "timeline", "params": {"order": ["s3", "s2", "s1"]}},
            {"action": "remove_scene", "scene_id": "s3"},
        ),
    )
    assert any("being removed" in w for w in warnings)
    apply_patch(graph, ops)
    # The plan's own reorder applied, then the removed scene was scrubbed.
    assert graph.nodes["timeline"].params["order"] == ["s2", "s1"]


def test_cannot_remove_the_last_scene_or_remove_at_scene_scope():
    graph = make_graph(scenes=1)
    ops, warnings = compile_edits(graph, plan({"action": "remove_scene", "scene_id": "s1"}))
    assert ops == [] and any("only remaining scene" in w for w in warnings)

    ops, warnings = compile_edits(
        make_graph(), plan({"action": "remove_scene", "scene_id": "s1"}), scope="s1"
    )
    assert ops == [] and any("project scope" in w for w in warnings)


# -- parsing ----------------------------------------------------------------


def test_parse_strips_fences_and_rejects_garbage():
    fenced = '```json\n{"summary": "ok", "edits": []}\n```'
    assert parse_edit_plan(fenced).summary == "ok"
    with pytest.raises(ValueError):
        parse_edit_plan("I made the edits you asked for!")
    with pytest.raises(ValueError):
        parse_edit_plan('{"edits": [{"action": "drop_table"}]}')


def test_audio_direction_params_sanitize():
    graph = make_graph()
    ops, warnings = compile_edits(
        graph,
        plan(
            {"action": "update", "node_id": "s1.narration", "params": {"speed": 3.0}},
            {
                "action": "update",
                "node_id": "timeline",
                "params": {"ducking": "false", "beat_align": True, "order": "everything"},
            },
        ),
    )
    by_node = {op.node_id: op.params for op in ops}
    assert by_node["s1.narration"]["speed"] == 1.5  # clamped to the audible range
    assert by_node["timeline"]["ducking"] is False  # string form coerced
    assert by_node["timeline"]["beat_align"] is True
    assert "order" not in by_node["timeline"]  # not a list → dropped
    assert any("not a list" in w for w in warnings)
