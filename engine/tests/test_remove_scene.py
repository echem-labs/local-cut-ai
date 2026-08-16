"""The remove_scene patch op — add_scene's mirror.

A scene could be added from the board and removed only by asking the LLM
editor in words, which is a strange asymmetry for the most ordinary edit
there is. The op compiles inside the service into the same primitives the
NL editor's own removal produces (a remove_node per member, plus the
timeline's references scrubbed), so the two routes cannot drift into one
being safer than the other — which is what the shared `scrub_removed`
is for.
"""

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.patch import PatchOp
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


def _service(tmp_path, scenes: int = 3) -> tuple[ProjectService, str]:
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[
            Scene(id=f"s{i}", duration_s=4.0, narration=f"line {i}", visual="v", motion="m")
            for i in range(1, scenes + 1)
        ],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)
    return service, project.id


def _remove(service, project_id, scene_id: str) -> set[str]:
    return service.patch(project_id, [PatchOp(op="remove_scene", node_id=scene_id)])


def test_remove_scene_takes_every_member_and_its_edges(tmp_path):
    service, pid = _service(tmp_path)
    _remove(service, pid, "s2")

    graph = service.store.load_graph(pid)
    assert not [n for n in graph.nodes if n.startswith("s2.")]
    # No edge may outlive the nodes it joined — a dangling one breaks
    # topological_order for every later edit, not just this scene's.
    assert not [e for e in graph.edges if e.src.startswith("s2.") or e.dst.startswith("s2.")]
    # The scenes either side are untouched.
    assert graph.nodes["s1.clip"] and graph.nodes["s3.clip"]
    assert [card["scene_id"] for card in service.scene_board(pid)["scenes"]] == ["s1", "s3"]


def test_remove_scene_scrubs_the_timeline_that_still_names_it(tmp_path):
    service, pid = _service(tmp_path)
    service.patch(
        pid,
        [
            PatchOp(
                op="set_params",
                node_id="timeline",
                params={
                    "order": ["s1", "s2", "s3"],
                    "trims": {"s2": {"in_s": 0.5}, "s3": {"in_s": 0.25}},
                    "overlays": {"s2": "a title"},
                },
            )
        ],
    )

    _remove(service, pid, "s2")

    timeline = service.store.load_graph(pid).nodes["timeline"].params
    assert timeline["order"] == ["s1", "s3"]
    assert "s2" not in timeline["trims"]
    assert "s2" not in timeline["overlays"]
    # Only the removed scene's references go — the others are user work.
    assert timeline["trims"]["s3"] == {"in_s": 0.25}


def test_remove_scene_refuses_the_last_one(tmp_path):
    service, pid = _service(tmp_path, scenes=1)
    with pytest.raises(ValueError, match="only scene"):
        _remove(service, pid, "s1")
    assert service.store.load_graph(pid).nodes["s1.clip"]


def test_two_removals_in_one_patch_cannot_empty_the_project(tmp_path):
    """Each op is compiled against the unmutated graph, so without the
    running `removed` set both checks see the other's scene still there."""
    service, pid = _service(tmp_path, scenes=2)
    with pytest.raises(ValueError, match="only scene"):
        service.patch(
            pid,
            [PatchOp(op="remove_scene", node_id="s1"), PatchOp(op="remove_scene", node_id="s2")],
        )
    graph = service.store.load_graph(pid)
    assert graph.nodes["s1.clip"] and graph.nodes["s2.clip"]


def test_removing_two_scenes_scrubs_both_from_the_timeline(tmp_path):
    service, pid = _service(tmp_path, scenes=3)
    service.patch(
        pid,
        [PatchOp(op="set_params", node_id="timeline", params={"order": ["s1", "s2", "s3"]})],
    )
    service.patch(
        pid,
        [PatchOp(op="remove_scene", node_id="s1"), PatchOp(op="remove_scene", node_id="s2")],
    )
    graph = service.store.load_graph(pid)
    # The second scrub is computed from every scene removed so far, so it
    # is a superset of the first rather than a replacement that revives s1.
    assert graph.nodes["timeline"].params["order"] == ["s3"]


def test_remove_scene_refuses_a_pinned_scene(tmp_path):
    service, pid = _service(tmp_path)
    service.patch(pid, [PatchOp(op="pin", node_id="s2.clip")])
    with pytest.raises(ValueError, match="pinned"):
        _remove(service, pid, "s2")
    assert service.store.load_graph(pid).nodes["s2.clip"]


def test_remove_scene_refuses_while_the_timeline_is_pinned(tmp_path):
    """A pinned timeline serves a frozen EDL: the nodes would go and the cut
    would keep playing them."""
    service, pid = _service(tmp_path)
    service.patch(pid, [PatchOp(op="pin", node_id="timeline")])
    with pytest.raises(ValueError, match="timeline is pinned"):
        _remove(service, pid, "s2")
    assert service.store.load_graph(pid).nodes["s2.clip"]


def test_remove_scene_refuses_an_unknown_scene(tmp_path):
    service, pid = _service(tmp_path)
    with pytest.raises(KeyError):
        _remove(service, pid, "s9")


def test_remove_scene_is_undoable(tmp_path):
    """It goes through `patch`, so it lands in history like any other edit —
    which is what makes deleting a scene a one-keystroke mistake to fix."""
    service, pid = _service(tmp_path)
    service.patch(
        pid, [PatchOp(op="set_params", node_id="timeline", params={"order": ["s1", "s2", "s3"]})]
    )
    _remove(service, pid, "s2")
    service.undo(pid)
    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.clip"]
    # The cut comes back with it, not just the nodes.
    assert graph.nodes["timeline"].params["order"] == ["s1", "s2", "s3"]
