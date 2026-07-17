"""End-to-end on the mock backend: one prompt → script → expanded graph →
all scene/audio/assembly jobs done → export artifact exists. This is the
Phase-0 spine minus real models.
"""

import asyncio

import pytest

from localcut_engine.backends.base import BackendRegistry
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.patch import PatchOp
from localcut_engine.jobs.models import JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService


@pytest.fixture
async def rig(tmp_path):
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)
    backends = BackendRegistry()
    backends.register(MockBackend())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=events,
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
        on_job_done=service.on_job_done,
    )
    service.scheduler = scheduler
    scheduler.start()
    yield store, queue, service
    await scheduler.stop()


async def wait_for(predicate, timeout=15.0, interval=0.05):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(interval)


async def test_prompt_to_export(rig):
    store, queue, service = rig
    project = service.create_from_prompt("the secret life of tide pools", target_duration_s=24)

    def export_done() -> bool:
        board = service.scene_board(project.id)
        export = board["aux"].get("export")
        return bool(export and export["artifact_hash"])

    await wait_for(export_done)

    board = service.scene_board(project.id)
    assert board["scenes"], "screenplay expansion produced no scenes"
    for scene in board["scenes"]:
        assert scene["clip"]["status"] in ("draft", "final")
        assert scene["keyframe"]["artifact_hash"]
    assert not [j for j in queue.list(project.id) if j.status is JobStatus.FAILED]

    export_hash = board["aux"]["export"]["artifact_hash"]
    assert store.resolve_artifact(project.id, export_hash).exists()


async def test_regenerate_only_dirties_one_scene(rig):
    store, queue, service = rig
    project = service.create_from_prompt("desert wildlife at night", target_duration_s=24)

    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    jobs_before = len(queue.list(project.id, 1000))

    board = service.scene_board(project.id)
    first_scene = board["scenes"][0]["scene_id"]
    service.regenerate(project.id, f"{first_scene}.clip")

    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    new_jobs = queue.list(project.id, 1000)[: len(queue.list(project.id, 1000)) - jobs_before]
    new_node_ids = {j.spec.node_id for j in new_jobs}
    # Only the regenerated clip + downstream assembly re-ran; other scenes cached.
    assert f"{first_scene}.clip" in new_node_ids
    assert not any(n.endswith(".keyframe") for n in new_node_ids)
    other_clips = {
        f"{s['scene_id']}.clip" for s in board["scenes"] if s["scene_id"] != first_scene
    }
    assert not (new_node_ids & other_clips)


async def test_finalize_enqueues_over_active_draft(tmp_path):
    """Quality is excluded from the content hash, so the in-flight dedupe
    must key on (hash, quality) — or finalize silently ships drafts."""
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)  # no scheduler: jobs stay queued
    project = service.create_from_prompt("tide pools", target_duration_s=24)

    assert len(queue.list(project.id, 100)) == 1  # draft script queued
    assert service.finalize(project.id) == 1  # final not deduped away by the draft
    qualities = {(j.spec.node_id, j.spec.quality) for j in queue.list(project.id, 100)}
    assert qualities == {("script", "draft"), ("script", "final")}
    # Same-quality re-enqueue is still deduped.
    graph = store.load_graph(project.id)
    assert service._enqueue_dirty(project.id, graph) == 0


async def test_cancel_project_stops_inflight_jobs(tmp_path):
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)  # no scheduler: jobs stay queued
    p1 = service.create_from_prompt("one")
    p2 = service.create_from_prompt("two")

    assert service.delete(p1.id)
    assert store.get(p1.id) is None
    assert all(j.status is JobStatus.CANCELLED for j in queue.list(p1.id, 100))
    assert all(j.status is JobStatus.QUEUED for j in queue.list(p2.id, 100))


async def test_script_regenerate_applies_new_screenplay(rig):
    """The re-run's screenplay must land in the scene nodes — not re-render
    the old content while the new script is discarded."""
    store, queue, service = rig
    project = service.create_from_prompt("tide pools at noon", target_duration_s=24)

    def export_hash():
        return service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")

    await wait_for(lambda: bool(export_hash()))
    board = service.scene_board(project.id)
    old_text = board["scenes"][0]["narration"]["params"]["text"]

    # A new prompt yields a different mock screenplay on the script re-run.
    service.patch(
        project.id,
        [PatchOp(op="set_params", node_id="script", params={"prompt": "volcanoes at dawn"})],
    )
    await wait_for(
        lambda: service.scene_board(project.id)["scenes"][0]["narration"]["params"]["text"]
        != old_text
    )
    board = service.scene_board(project.id)
    assert "volcanoes at dawn" in board["scenes"][0]["narration"]["params"]["text"]


async def test_script_tool_promotes_to_full_project(rig):
    """Quick Tool session → full project: the generated screenplay seeds the
    new project's script node as a cached artifact (no LLM re-run)."""
    store, queue, service = rig
    tool = service.create_tool("script", {"prompt": "octopus hearts", "aspect": "9:16"})
    assert tool.mode == "tool:script"

    await wait_for(
        lambda: any(
            j.spec.node_id == "script" and j.status is JobStatus.DONE
            for j in queue.list(tool.id, 10)
        )
    )
    promoted = service.promote_tool(tool.id)
    assert promoted.id != tool.id and promoted.mode == "prompt"

    await wait_for(
        lambda: bool(
            service.scene_board(promoted.id)["aux"].get("export", {}).get("artifact_hash")
        )
    )
    # The script arrived pre-cached: the promoted project never ran an LLM job.
    assert not [j for j in queue.list(promoted.id, 1000) if j.spec.node_id == "script"]
    assert service.scene_board(promoted.id)["scenes"]


async def test_beginner_mode_gates_stages_until_approved(rig):
    store, queue, service = rig
    project = service.create_from_prompt(
        "volcano documentary", target_duration_s=24, mode="beginner"
    )

    def kinds_run() -> set[str]:
        return {j.spec.kind.value for j in queue.list(project.id, 1000)}

    # Script runs and expands, but nothing past the first checkpoint.
    await wait_for(lambda: "script" in kinds_run())
    await wait_for(lambda: bool(service.scene_board(project.id)["scenes"]))
    assert kinds_run() == {"script"}

    service.approve(project.id, "script")
    await wait_for(lambda: "keyframe" in kinds_run() and "narration" in kinds_run())
    assert "clip" not in kinds_run()  # storyboard not approved yet

    service.approve(project.id, "storyboard")
    await wait_for(
        lambda: bool(
            service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")
        )
    )
    assert store.get(project.id).approvals == ["script", "storyboard"]


async def test_queue_recovers_interrupted_jobs(tmp_path):
    queue = JobQueue(tmp_path / "q.db")
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    job = Job(
        project_id="p1",
        spec=JobSpec(
            node_id="n1", kind=NodeKind.CLIP, output_hash="abc", params={},
            model=None, seed=0, input_hashes={},
        ),
        status=JobStatus.RENDERING,
    )
    queue.put(job)
    queue.close()

    recovered = JobQueue(tmp_path / "q.db")
    assert recovered.get(job.id).status is JobStatus.QUEUED
    recovered.close()


async def test_pin_freezes_output_across_upstream_edits(rig):
    """Pin semantics: an upstream edit re-renders everything except pinned
    nodes, and downstream jobs consume the pinned node's frozen artifact."""
    from localcut_engine.graph.patch import PatchOp

    store, queue, service = rig
    project = service.create_from_prompt("coral reefs after dark", target_duration_s=24)

    def export_hash():
        return service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")

    await wait_for(lambda: bool(export_hash()))
    board = service.scene_board(project.id)
    frozen_kf = board["scenes"][0]["keyframe"]["artifact_hash"]
    kf_jobs_before = len(
        [j for j in queue.list(project.id, 1000) if j.spec.node_id == "s1.keyframe"]
    )

    service.patch(project.id, [PatchOp(op="pin", node_id="s1.keyframe")])
    first_export = export_hash()
    service.patch(
        project.id,
        [PatchOp(op="set_params", node_id="script", params={"style_preset": "noir"})],
    )
    await wait_for(lambda: export_hash() not in (None, first_export))

    board = service.scene_board(project.id)
    kf_jobs_after = len(
        [j for j in queue.list(project.id, 1000) if j.spec.node_id == "s1.keyframe"]
    )
    assert kf_jobs_after == kf_jobs_before, "pinned keyframe re-rendered"
    assert board["scenes"][0]["keyframe"]["artifact_hash"] == frozen_kf
    # The clip downstream of the pin re-rendered and still completed, i.e.
    # it resolved its keyframe input to the frozen artifact.
    assert board["scenes"][0]["clip"]["status"] in ("draft", "final")
    assert not [j for j in queue.list(project.id, 1000) if j.status is JobStatus.FAILED]
