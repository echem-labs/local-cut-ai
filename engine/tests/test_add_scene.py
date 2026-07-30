"""The add_scene patch op. Scenes used to exist only via script expansion,
so "+ add a scene" had no engine path at all. The op compiles, inside the
service, into the same primitive ops every other edit uses — apply_patch's
cycle check and consent gate cover the new subgraph for free — and the
screenplay stays the source of truth: like a scene the NL editor removed,
an added scene lives until the script itself re-renders.
"""

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.patch import PatchOp
from localcut_engine.graph.templates import MAX_CLIP_S, expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


def _service(tmp_path, scenes: int = 1) -> tuple[ProjectService, str]:
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


def _add(service, project_id, **kwargs) -> set[str]:
    op = PatchOp(
        op="add_scene",
        params={k: v for k, v in kwargs.items() if k != "after"},
        after=kwargs.get("after"),
    )
    return service.patch(project_id, [op])


def test_add_scene_builds_the_full_member_subgraph(tmp_path):
    service, pid = _service(tmp_path)
    dirty = _add(
        service, pid, prompt="a lighthouse at dusk", narration="the light turns", duration_s=6
    )

    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.keyframe"].params["prompt"] == "a lighthouse at dusk"
    assert graph.nodes["s2.clip"].params["duration_s"] == 6.0
    assert graph.nodes["s2.narration"].params["text"] == "the light turns"
    # Same aspect as the rest of the pipeline, not a hardcoded default.
    assert (
        graph.nodes["s2.keyframe"].params["aspect"] == graph.nodes["s1.keyframe"].params["aspect"]
    )
    edges = {(e.src, e.dst, e.port) for e in graph.edges}
    assert ("script", "s2.keyframe", "default") in edges
    assert ("script", "s2.narration", "default") in edges
    assert ("s2.keyframe", "s2.clip", "keyframe") in edges
    assert ("s2.clip", "timeline", "s2") in edges
    assert ("s2.narration", "timeline", "s2.audio") in edges
    assert graph.nodes["timeline"].params["order"] == ["s1", "s2"]
    # The captions ground truth follows the narration set (patch syncs it).
    assert graph.nodes["captions"].params["texts"]["s2"] == "the light turns"
    assert {"s2.keyframe", "s2.clip", "s2.narration"} <= dirty
    # The board grows a card for it.
    board = service.scene_board(pid)
    assert [card["scene_id"] for card in board["scenes"]] == ["s1", "s2"]


def test_add_scene_inserts_after_a_named_scene(tmp_path):
    service, pid = _service(tmp_path, scenes=2)
    _add(service, pid, prompt="x", after="s1")
    order = service.store.load_graph(pid).nodes["timeline"].params["order"]
    assert order == ["s1", "s3", "s2"]


def test_add_scene_skips_ids_with_leftover_timeline_state(tmp_path):
    """Trims/transitions are keyed by scene id and survive a scene's
    removal — a recycled id would inherit a removed scene's edits."""
    service, pid = _service(tmp_path, scenes=2)
    service.patch(
        pid,
        [PatchOp(op="set_params", node_id="timeline", params={"trims": {"s2": {"in": 1.0}}})],
    )
    for member in ("s2.keyframe", "s2.clip", "s2.narration"):
        service.patch(pid, [PatchOp(op="remove_node", node_id=member)])

    _add(service, pid, prompt="x")
    graph = service.store.load_graph(pid)
    assert "s3.clip" in graph.nodes and "s2.clip" not in graph.nodes


def test_two_adds_in_one_patch_do_not_collide(tmp_path):
    service, pid = _service(tmp_path)
    service.patch(pid, [PatchOp(op="add_scene", params={"prompt": "a"}), PatchOp(op="add_scene")])
    graph = service.store.load_graph(pid)
    assert "s2.clip" in graph.nodes and "s3.clip" in graph.nodes
    assert graph.nodes["timeline"].params["order"] == ["s1", "s2", "s3"]


def test_add_scene_duration_stays_a_single_clip(tmp_path):
    """Past MAX_CLIP_S a scene splits into sequential takes, which is
    expansion's construction, not a patch op's — the op clamps instead."""
    service, pid = _service(tmp_path)
    _add(service, pid, duration_s=30)
    assert service.store.load_graph(pid).nodes["s2.clip"].params["duration_s"] == MAX_CLIP_S


def test_add_scene_requires_a_timeline(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    project = store.create(title="t", graph=prompt_template_graph("p"))
    with pytest.raises(ValueError, match="timeline"):
        service.patch(project.id, [PatchOp(op="add_scene")])


def test_add_scene_with_unknown_after_is_refused(tmp_path):
    service, pid = _service(tmp_path)
    with pytest.raises(ValueError, match="unknown scene"):
        _add(service, pid, after="s9")


def test_added_scene_speaks_with_the_project_voice(tmp_path):
    service, pid = _service(tmp_path)
    _add(service, pid, narration="hello")
    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.narration"].params.get("voice") == graph.nodes[
        "s1.narration"
    ].params.get("voice")


def test_add_scene_is_undoable(tmp_path):
    service, pid = _service(tmp_path)
    _add(service, pid, prompt="x")
    service.undo(pid)
    graph = service.store.load_graph(pid)
    assert "s2.clip" not in graph.nodes
    assert [card["scene_id"] for card in service.scene_board(pid)["scenes"]] == ["s1"]


def test_a_scene_with_nothing_written_in_it_renders_nothing(tmp_path):
    """The desktop's "+ add a scene" card sends the op with no params at all,
    because the whole point is that you write the prompt afterwards. That
    queued a narration with empty text -- which both TTS backends refuse
    outright -- so the tile went red seconds after it appeared, before the
    user had typed anything, and the keyframe burned a full image generation
    on an empty prompt. Nothing in the new scene may reach the queue, and the
    board has to say why rather than spin on `queued` for work that will
    never be created."""
    service, pid = _service(tmp_path)
    before = {job.spec.node_id for job in service.queue.list(pid)}

    _add(service, pid)  # exactly what the desktop sends: no prompt, no narration

    queued = {job.spec.node_id for job in service.queue.list(pid)} - before
    assert not {"s2.keyframe", "s2.clip", "s2.narration"} & queued, (
        f"an unwritten scene reached the queue: {sorted(queued)}"
    )

    board = service.scene_board(pid)
    card = next(c for c in board["scenes"] if c["scene_id"] == "s2")
    assert card["keyframe"]["status"] == "blocked"
    assert card["narration"]["status"] == "blocked"
    assert card["clip"]["status"] == "blocked"


def test_writing_the_scene_lets_it_render(tmp_path):
    """The other half: `blocked` is a state the user leaves by typing, not a
    permanent refusal. Filling in the prompt and the narration has to put the
    whole scene -- and the assembly the cone had stopped -- back in the queue."""
    service, pid = _service(tmp_path)
    _add(service, pid)
    service.patch(
        pid,
        [
            PatchOp(op="set_params", node_id="s2.keyframe", params={"prompt": "a lighthouse"}),
            PatchOp(op="set_params", node_id="s2.narration", params={"text": "the light turns"}),
        ],
    )

    board = service.scene_board(pid)
    card = next(c for c in board["scenes"] if c["scene_id"] == "s2")
    assert card["keyframe"]["status"] != "blocked"
    assert card["narration"]["status"] != "blocked"
    assert board["aux"]["export"]["status"] != "blocked"
