"""Undo/redo and save points over graph snapshots.

The design premise (doc 10): graphs are small JSON and artifacts are
content-addressed, so a whole-graph snapshot per mutation is cheaper than
patch-inverse bookkeeping, and restoring one re-references hashes whose
renders are still cached — undo is a metadata operation.

The restore path is also a route that can write an edge without going
op-by-op through apply_patch, so it must re-establish the patch
chokepoint's gates (cycles, voice consent) — the tampered-file tests here
are the proof.
"""

import json

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.editor import Edit, EditPlan
from localcut_engine.graph.patch import PatchOp
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import (
    HISTORY_VERSION,
    SAVEPOINT_LIMIT,
    UNDO_LIMIT,
    GraphHistory,
    HistoryTooNew,
    ProjectStore,
    Snapshot,
)
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ConflictError, ProjectService


def _service(tmp_path) -> tuple[ProjectService, str]:
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)
    return service, project.id


def _prompt(service: ProjectService, project_id: str) -> str:
    return service.store.load_graph(project_id).nodes["s1.keyframe"].params["prompt"]


def _set_prompt(service: ProjectService, project_id: str, value: str) -> None:
    service.patch(
        project_id,
        [PatchOp(op="set_params", node_id="s1.keyframe", params={"prompt": value})],
    )


def test_a_patch_is_undoable_and_an_undo_redoable(tmp_path):
    service, project_id = _service(tmp_path)
    original = _prompt(service, project_id)

    _set_prompt(service, project_id, "a red door")
    info = service.history_info(project_id)
    assert info["undo_depth"] == 1
    assert info["undo_top"]["kind"] == "patch"

    info = service.undo(project_id)
    assert _prompt(service, project_id) == original
    assert (info["undo_depth"], info["redo_depth"]) == (0, 1)
    assert info["redo_top"]["kind"] == "patch"

    info = service.redo(project_id)
    assert _prompt(service, project_id) == "a red door"
    assert (info["undo_depth"], info["redo_depth"]) == (1, 0)


def test_a_new_edit_forks_history_and_clears_redo(tmp_path):
    service, project_id = _service(tmp_path)
    _set_prompt(service, project_id, "a red door")
    service.undo(project_id)
    assert service.history_info(project_id)["redo_depth"] == 1

    _set_prompt(service, project_id, "a blue door")
    info = service.history_info(project_id)
    assert info["redo_depth"] == 0
    with pytest.raises(ConflictError):
        service.redo(project_id)


def test_a_patch_that_changes_nothing_burns_no_undo_step(tmp_path):
    service, project_id = _service(tmp_path)
    value = _prompt(service, project_id)
    _set_prompt(service, project_id, value)
    assert service.history_info(project_id)["undo_depth"] == 0


def test_undo_on_a_fresh_project_is_a_conflict_not_a_crash(tmp_path):
    service, project_id = _service(tmp_path)
    with pytest.raises(ConflictError):
        service.undo(project_id)
    with pytest.raises(ConflictError):
        service.redo(project_id)


def test_the_undo_stack_is_bounded(tmp_path):
    service, project_id = _service(tmp_path)
    for i in range(UNDO_LIMIT + 5):
        _set_prompt(service, project_id, f"prompt {i}")
    assert service.history_info(project_id)["undo_depth"] == UNDO_LIMIT


def test_regenerate_is_undoable(tmp_path):
    service, project_id = _service(tmp_path)
    seed = service.store.load_graph(project_id).nodes["s1.clip"].seed

    service.regenerate(project_id, "s1.clip")
    assert service.store.load_graph(project_id).nodes["s1.clip"].seed == seed + 1
    assert service.history_info(project_id)["undo_top"] == {
        "kind": "regenerate",
        "summary": None,
        "node_id": "s1.clip",
    }

    service.undo(project_id)
    assert service.store.load_graph(project_id).nodes["s1.clip"].seed == seed


def test_an_nl_edit_is_undoable_under_its_summary(tmp_path):
    service, project_id = _service(tmp_path)
    original = _prompt(service, project_id)
    plan = EditPlan(
        summary="Redder door",
        edits=[Edit(action="update", node_id="s1.keyframe", params={"prompt": "a red door"})],
    )

    service.apply_edit_plan(project_id, plan, "project")
    assert service.history_info(project_id)["undo_top"] == {
        "kind": "edit",
        "summary": "Redder door",
        "node_id": None,
    }

    service.undo(project_id)
    assert _prompt(service, project_id) == original


def test_savepoint_lifecycle(tmp_path):
    service, project_id = _service(tmp_path)
    original = _prompt(service, project_id)

    info = service.create_savepoint(project_id, "  before experiments  ")
    (savepoint,) = info["savepoints"]
    assert savepoint["label"] == "before experiments"

    _set_prompt(service, project_id, "a red door")
    info = service.restore_savepoint(project_id, savepoint["id"])
    assert _prompt(service, project_id) == original
    # Restoring is itself an undoable mutation, so Ctrl+Z walks back out.
    assert info["undo_top"]["kind"] == "restore"
    assert info["undo_top"]["summary"] == "before experiments"
    service.undo(project_id)
    assert _prompt(service, project_id) == "a red door"

    service.delete_savepoint(project_id, savepoint["id"])
    assert service.history_info(project_id)["savepoints"] == []
    with pytest.raises(KeyError):
        service.restore_savepoint(project_id, savepoint["id"])
    with pytest.raises(KeyError):
        service.delete_savepoint(project_id, savepoint["id"])


def test_restoring_the_current_state_records_no_undo_step(tmp_path):
    service, project_id = _service(tmp_path)
    info = service.create_savepoint(project_id, "here")
    info = service.restore_savepoint(project_id, info["savepoints"][0]["id"])
    assert info["undo_depth"] == 0


def test_savepoints_are_capped_with_a_reason(tmp_path):
    service, project_id = _service(tmp_path)
    for i in range(SAVEPOINT_LIMIT):
        service.create_savepoint(project_id, f"sp {i}")
    with pytest.raises(ValueError, match="save points"):
        service.create_savepoint(project_id, "one too many")


def test_a_tampered_snapshot_cannot_smuggle_an_unconsented_voice_wire(tmp_path):
    """history.json is engine-written but plain JSON on disk: a snapshot is
    a whole graph, so restoring one blindly would be a consent bypass. The
    restore gate re-checks what the connect op enforces."""
    service, project_id = _service(tmp_path)
    dump = service.store.load_graph(project_id).model_dump(mode="json")
    dump["edges"].append({"src": "s1.keyframe", "dst": "s1.narration", "port": "voice_ref"})
    service.store.save_history(
        project_id,
        GraphHistory(undo=[Snapshot(kind="patch", at=0.0, graph=dump)]),
    )
    with pytest.raises(ValueError, match="consented"):
        service.undo(project_id)


def test_a_tampered_snapshot_cannot_persist_a_cycle(tmp_path):
    service, project_id = _service(tmp_path)
    dump = service.store.load_graph(project_id).model_dump(mode="json")
    dump["edges"].append({"src": "s1.clip", "dst": "s1.keyframe", "port": "loop"})
    service.store.save_history(
        project_id,
        GraphHistory(undo=[Snapshot(kind="patch", at=0.0, graph=dump)]),
    )
    with pytest.raises(ValueError):
        service.undo(project_id)
    # The refused restore left the working graph untouched.
    service.store.load_graph(project_id).topological_order()


def test_history_from_a_newer_build_is_refused_not_reduced(tmp_path):
    service, project_id = _service(tmp_path)
    path = service.store.project_dir(project_id) / "history.json"
    path.write_text(json.dumps({"version": HISTORY_VERSION + 1, "undo": []}), encoding="utf-8")
    with pytest.raises(HistoryTooNew):
        service.history_info(project_id)


def test_unreadable_history_resets_instead_of_bricking_edits(tmp_path):
    service, project_id = _service(tmp_path)
    path = service.store.project_dir(project_id) / "history.json"
    path.write_text("not json", encoding="utf-8")
    assert service.history_info(project_id)["undo_depth"] == 0
    # The next mutation records normally over the reset file.
    _set_prompt(service, project_id, "recovered")
    assert service.history_info(project_id)["undo_depth"] == 1


def test_a_refused_cloud_spend_leaves_the_project_exactly_as_it_was(tmp_path):
    """The rule is "an agent cannot CHOOSE cloud", and choosing is the write.

    The gate lives at the queue because that is where the money is committed
    — three client-side gates leaked in turn before it moved there. But every
    mutating path saved the graph BEFORE calling it, so a refused caller got
    its 403 with the `cloud:*` model already persisted on the node. Nothing
    was queued, which is what the message says; what it does not say is that
    the next render the USER starts from the app spends. The refusal has to
    be a no-op, not a failed queue over a completed write.
    """
    from localcut_engine.service import CLOUD_SPEND_ALLOWED, CloudSpendRefused

    service, project_id = _service(tmp_path)
    _set_prompt(service, project_id, "a lighthouse")
    before_graph = service.store.load_graph(project_id).model_dump(mode="json")
    before_history = service.store.load_history(project_id).model_dump(mode="json")

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        with pytest.raises(CloudSpendRefused):
            service.patch(
                project_id,
                [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")],
            )
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    assert service.store.load_graph(project_id).nodes["s1.clip"].model != "cloud:kling-2.5"
    assert service.store.load_graph(project_id).model_dump(mode="json") == before_graph
    # And the refusal did not consume an undo step for a change that never happened.
    assert service.store.load_history(project_id).model_dump(mode="json") == before_history


def test_a_refused_undo_does_not_spend_the_history_step(tmp_path):
    """Undo restores a whole snapshot, which is how the rule was broken the
    third time: the model comes back without the caller naming one. Refusing
    after the stacks were rewritten left the snapshot both applied and popped
    — the change landed AND there was no way back to it."""
    from localcut_engine.service import CLOUD_SPEND_ALLOWED, CloudSpendRefused

    service, project_id = _service(tmp_path)
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="local:ltx-video")])
    before_graph = service.store.load_graph(project_id).model_dump(mode="json")
    before_depth = service.history_info(project_id)["undo_depth"]

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        with pytest.raises(CloudSpendRefused):
            service.undo(project_id)
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    assert service.store.load_graph(project_id).model_dump(mode="json") == before_graph
    assert service.history_info(project_id)["undo_depth"] == before_depth
