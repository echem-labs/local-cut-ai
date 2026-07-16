"""End-to-end on the mock backend: one prompt → script → expanded graph →
all scene/audio/assembly jobs done → export artifact exists. This is the
Phase-0 spine minus real models.
"""

import asyncio

import pytest

from localcut_engine.backends.base import BackendRegistry
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
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
