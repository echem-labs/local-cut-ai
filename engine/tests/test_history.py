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


def test_refusing_earlier_does_not_refuse_more(tmp_path):
    """Moving the gate in front of the write must change WHEN a patch is
    refused, never WHICH patches are refused.

    An op that dirties nothing — pinning — plans no jobs, so it never reached
    the check at the queue: `_enqueue_dirty` runs only `if dirty`. Hoisting
    the check without that guard denies an agent an edit that cannot bill
    anyone, on the sole ground that some unrelated node in the project sits
    on a cloud model the user chose themselves.
    """
    from localcut_engine.service import CLOUD_SPEND_ALLOWED

    service, project_id = _service(tmp_path)
    # The user, in the app, puts a clip on a cloud model. Entirely permitted.
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        # A different node, an op with no render behind it.
        assert service.patch(project_id, [PatchOp(op="pin", node_id="s1.keyframe")]) == set()
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    assert service.store.load_graph(project_id).nodes["s1.keyframe"].pinned


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


def test_every_mutating_route_refuses_before_it_writes(tmp_path):
    """The rule names an outcome, so it cannot be a list of four methods.

    `patch`, `undo/redo` and `restore_savepoint` were hoisted in front of
    their writes; the routes below were not, and each one wrote first and
    refused at the queue afterwards. Each is a different way for a refused
    caller to leave a `cloud:*` render staged for the user to pay for:

      - `regenerate` bumps the seed, which is exactly what makes the node
        uncached, and parks the displaced identity in takes.json;
      - `apply_edit_plan` (the `/edit/apply` route, and the MCP editor --
        the surface an agent host actually drives) rewrites params and
        consumes an undo step;
      - `approve` opens a beginner checkpoint, and there is no un-approve,
        so the gate stays open for the user's next action to spend through.
    """
    from localcut_engine.service import CLOUD_SPEND_ALLOWED, CloudSpendRefused

    service, project_id = _service(tmp_path)
    # The user, in the app, chooses a cloud model. Entirely permitted.
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])
    before_graph = service.store.load_graph(project_id).model_dump(mode="json")
    before_takes = service.store.load_takes(project_id).model_dump(mode="json")
    before_history = service.store.load_history(project_id).model_dump(mode="json")
    before_meta = service.store.get(project_id).model_dump(mode="json")

    plan = EditPlan(
        summary="colder",
        edits=[Edit(action="update", node_id="s1.keyframe", params={"prompt": "a cold shore"})],
    )
    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        for call in (
            lambda: service.regenerate(project_id, "s1.clip"),
            lambda: service.apply_edit_plan(project_id, plan, scope="project"),
            lambda: service.approve(project_id, "script"),
        ):
            with pytest.raises(CloudSpendRefused):
                call()
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    assert service.store.load_graph(project_id).model_dump(mode="json") == before_graph
    assert service.store.load_takes(project_id).model_dump(mode="json") == before_takes
    assert service.store.load_history(project_id).model_dump(mode="json") == before_history
    # The approval in particular: it is the one write with no way back.
    assert service.store.get(project_id).model_dump(mode="json") == before_meta


def test_a_refused_import_does_not_leave_the_project_behind(tmp_path):
    """A template may legitimately carry the author's cloud models, so
    importing one IS the choice to spend on them -- and the refusal used to
    arrive after `store.create`, leaving a fully-formed project in the
    user's list while the 403 said nothing was changed. One click renders
    it.

    Duplicating a cloud project is the same choice by another name.
    """
    from localcut_engine.graph.template_io import from_template, to_template
    from localcut_engine.service import CLOUD_SPEND_ALLOWED, CloudSpendRefused

    service, project_id = _service(tmp_path)
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])
    document = to_template(service.store.load_graph(project_id), name="Cloudy")
    before = {p.id for p in service.store.list()}

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        with pytest.raises(CloudSpendRefused):
            service.create_from_template(from_template(document.model_dump(mode="json")))
        with pytest.raises(CloudSpendRefused):
            service.duplicate(project_id)
        # And a plain local prompt project is still creatable: refusing
        # earlier must not refuse more.
        local = service.create_from_prompt("a quiet harbour")
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    assert {p.id for p in service.store.list()} - before == {local.id}


def test_a_cloud_model_the_plan_cannot_see_is_still_a_choice(tmp_path):
    """The gate asks the PLANNER what would bill, and the planner answers a
    narrower question than the rule does.

    `compile_graph` emits no job for a node inside a blocked scene's cone
    (`unready_nodes`) and none for a node already satisfied from cache, so
    `plan.jobs` is empty and the write went through. Both land a `cloud:*`
    model on the graph, which is the thing the rule forbids: the guarantee
    is "an agent cannot CHOOSE cloud", and the user pays the moment they
    write the scene or edit anything upstream.

    `select_take` is the sharper of the two -- takes exist precisely so that
    switching back is a cache hit, so the restored identity is never in the
    plan by construction.
    """
    from localcut_engine.service import CLOUD_SPEND_ALLOWED, CloudSpendRefused

    service, project_id = _service(tmp_path)

    # 1. A node whose scene nobody has written: blocked, so never planned.
    service.patch(project_id, [PatchOp(op="add_scene", params={})])
    assert service.scene_board(project_id)["scenes"][-1]["clip"]["status"] == "blocked"

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        with pytest.raises(CloudSpendRefused):
            service.patch(
                project_id,
                [PatchOp(op="set_model", node_id="s2.clip", model="cloud:kling-2.5")],
            )
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)
    assert service.store.load_graph(project_id).nodes["s2.clip"].model is None

    # 2. A take recorded on a cloud model, whose artifact is on disk: the
    #    restore is a cache hit, so it plans nothing at all.
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])
    graph = service.store.load_graph(project_id)
    generated = service.store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{graph.output_hash('s1.clip')}.mp4").write_bytes(b"x")
    service.regenerate(project_id, "s1.clip")
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="local:ltx-video")])
    take = next(
        t
        for t in service.store.load_takes(project_id).takes["s1.clip"]
        if t.model.startswith("cloud:")
    )

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        with pytest.raises(CloudSpendRefused):
            service.patch(
                project_id,
                [PatchOp(op="select_take", node_id="s1.clip", take=take.output_hash)],
            )
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)
    assert service.store.load_graph(project_id).nodes["s1.clip"].model == "local:ltx-video"


def test_duplicating_a_pinned_cloud_project_is_not_a_spend(tmp_path):
    """Refusing earlier must not refuse more -- `duplicate` included.

    A pin freezes a node's output identity, and the frozen artifact travels
    with the copy, so `_enqueue_dirty` marks the node cached and enqueues
    nothing. The pre-write gate compiled the same graph WITHOUT the frozen
    memo, so the pinned node re-hashed live, missed the copied cache, and was
    planned as a billable job -- along with every node downstream of it,
    whose hashes all move once the pin stops resolving. A copy that bills
    nobody was refused 403.
    """
    from localcut_engine.service import CLOUD_SPEND_ALLOWED

    service, project_id = _service(tmp_path)
    # The user, in the app, renders a cloud clip and pins it.
    service.patch(project_id, [PatchOp(op="set_model", node_id="s1.clip", model="cloud:kling-2.5")])
    service.patch(project_id, [PatchOp(op="pin", node_id="s1.clip")])
    frozen_hash = service.store.load_graph(project_id).nodes["s1.clip"].frozen_hash
    generated = service.store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{frozen_hash}.mp4").write_bytes(b"x")
    # ...then edits upstream, which is the whole reason to pin.
    _set_prompt(service, project_id, "a colder shore")

    token = CLOUD_SPEND_ALLOWED.set(False)
    try:
        copy = service.duplicate(project_id)
    finally:
        CLOUD_SPEND_ALLOWED.reset(token)

    # And the copy really does enqueue nothing for the pinned node -- the
    # claim the gate has to agree with.
    assert copy.id != project_id
    assert "s1.clip" not in {job.spec.node_id for job in service.queue.list(copy.id, 1000)}


def test_undo_does_not_replant_a_null_the_migration_removed(tmp_path):
    """`_ensure_node` makes expansion the migration for a graph written
    before the no-nulls rule -- but history.json is the one place the
    migration cannot reach, and a restore replaces every node's params
    wholesale from it.

    One Ctrl+Z therefore put `{"captions": None}` back on the export, which
    stops ffmpeg burning the captions it was asked for (`params.get(
    "captions", "burn")` returns None) and lands the node on a hash no
    cached export can match.
    """
    service, project_id = _service(tmp_path)
    _set_prompt(service, project_id, "a lighthouse")

    # A snapshot from before the rule existed: reach into the recorded
    # history the way an older build would have written it.
    history = service.store.load_history(project_id)
    history.undo[-1].graph["nodes"]["export"]["params"]["captions"] = None
    history.undo[-1].graph["nodes"]["export"]["params"]["fps"] = None
    service.store.save_history(project_id, history)

    service.undo(project_id)

    export = service.store.load_graph(project_id).nodes["export"].params
    assert "captions" not in export
    assert "fps" not in export
    assert export.get("captions", "burn") == "burn"  # ffmpeg.py's own expression
