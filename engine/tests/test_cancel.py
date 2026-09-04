"""Cancelling and deleting have to stop the work, not just the bookkeeping.

The queue row was the whole of it: `cancel` wrote CANCELLED and returned,
while the backend rendered the job to completion. On a real clip that is
minutes of GPU held by something the user stopped, with the tray reading
idle — and because this queue is serial, nothing behind it could start.
Deleting a scene had the mirror problem: its queued jobs were not the ones a
re-plan superseded, so the deleted scene rendered in full while the timeline
waited behind it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from conftest import make_spec

from localcut_engine.backends.base import BackendRegistry, ExecutionBackend, ExecutionContext
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import KEYFRAME_PORT, Node, NodeKind, StoryGraph
from localcut_engine.jobs.models import Job, JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService


class BlockingBackend(ExecutionBackend):
    """Renders forever until cancelled — a stand-in for a real clip."""

    name = "blocking"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.completed = 0
        self.interrupted = 0

    def supports(self, kind: NodeKind) -> bool:
        del kind
        return True

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        self.started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            self.interrupted += 1
            raise
        self.completed += 1
        out = ctx.output_dir / f"{spec.output_hash}.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"done")
        return out


async def wait_for(predicate, timeout=10.0, interval=0.02):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(interval)


@pytest.fixture
async def rig(tmp_path):
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)
    backends = BackendRegistry()
    blocking = BlockingBackend()
    backends.register(blocking)
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
    yield store, queue, service, scheduler, blocking
    await scheduler.stop()


async def test_cancelling_the_running_job_interrupts_the_backend(rig):
    """The row flipping to CANCELLED is not the point — stopping the GPU is."""
    _store, queue, _service, scheduler, blocking = rig
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="a" * 64)))
    scheduler.notify()
    await wait_for(blocking.started.is_set)

    assert queue.cancel(job.id) is True
    assert scheduler.cancel_running(job.id) is True

    await wait_for(lambda: blocking.interrupted == 1)
    # The render stopped where it stood: nothing was published, and the row
    # is not resurrected to DONE behind the cancel.
    assert blocking.completed == 0
    assert queue.get(job.id).status is JobStatus.CANCELLED


async def test_the_queue_keeps_moving_after_a_cancel(rig):
    """Cancelling one job must not take the scheduler down with it — the
    render runs as its own task precisely so the loop survives it."""
    _store, queue, _service, scheduler, blocking = rig
    first = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="a" * 64)))
    second = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="b" * 64)))
    scheduler.notify()
    await wait_for(blocking.started.is_set)

    blocking.started.clear()
    queue.cancel(first.id)
    scheduler.cancel_running(first.id)

    # The second job is picked up rather than waiting behind a cancelled one.
    await wait_for(blocking.started.is_set)
    assert queue.get(second.id).status is JobStatus.RENDERING


async def test_cancelling_a_queued_job_does_not_touch_the_running_one(rig):
    """`cancel_running` is aimed, not a blanket stop."""
    _store, queue, _service, scheduler, blocking = rig
    running = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="a" * 64)))
    waiting = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="b" * 64)))
    scheduler.notify()
    await wait_for(blocking.started.is_set)

    assert scheduler.cancel_running(waiting.id) is False
    await asyncio.sleep(0.1)
    assert blocking.interrupted == 0
    assert queue.get(running.id).status is JobStatus.RENDERING


def _scene_graph() -> StoryGraph:
    graph = StoryGraph()
    graph.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "x"}))
    return graph


async def test_a_deleted_scenes_queued_jobs_are_superseded(tmp_path):
    """A node that has left the graph cannot be rendered into anything the
    project references, and the timeline waits behind it in the FIFO."""
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)
    backends = BackendRegistry()
    backends.register(MockBackend())

    project = store.create(title="t", graph=_scene_graph(), mode="prompt")
    graph = store.load_graph(project.id)
    graph.add_node(Node(id="s9.clip", kind=NodeKind.CLIP, params={"prompt": "gone soon"}))
    store.save_graph(project.id, graph)

    stale = queue.put(
        Job(project_id=project.id, spec=make_spec(NodeKind.CLIP, output_hash="c" * 64))
    )
    stale.spec.node_id = "s9.clip"
    queue._write(stale)
    assert queue.get(stale.id).status is JobStatus.QUEUED

    # The scene goes; the plan that follows describes a graph without it.
    graph = store.load_graph(project.id)
    graph.nodes.pop("s9.clip")
    graph.edges = [e for e in graph.edges if "s9.clip" not in (e.src, e.dst)]
    store.save_graph(project.id, graph)
    service._enqueue_dirty(project.id, graph)

    assert queue.get(stale.id).status is JobStatus.CANCELLED


async def test_a_cancel_that_lost_the_race_does_not_pin_the_card(tmp_path):
    """A cancel can land after the render already published its artifact.

    The file at that hash is complete and trusted, so the card has to read
    from it. Reporting `cancelled` over it pinned the node there for good: a
    re-plan sees a node that is not dirty and enqueues nothing, so Render
    does nothing, and the only way out is Regenerate — which throws the good
    render away.
    """
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)

    graph = _scene_graph()
    # Wired, not bare: an unfed clip reports `blocked` on its own merits and
    # would say nothing about the cancel.
    graph.add_node(Node(id="s1.keyframe", kind=NodeKind.KEYFRAME, params={"prompt": "still"}))
    graph.add_node(Node(id="s1.clip", kind=NodeKind.CLIP, params={"prompt": "a hummingbird"}))
    graph.connect("s1.keyframe", "s1.clip", port=KEYFRAME_PORT)
    project = store.create(title="t", graph=graph, mode="prompt")

    graph = store.load_graph(project.id)
    keyframe_hash = graph.output_hash("s1.keyframe")
    out_hash = graph.output_hash("s1.clip")

    # The render finished and published before the cancel was written.
    generated = store.generated_dir(project.id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{keyframe_hash}.png").write_bytes(b"a still")
    (generated / f"{out_hash}.mp4").write_bytes(b"a real render")

    job = queue.put(Job(project_id=project.id, spec=make_spec(NodeKind.CLIP, output_hash=out_hash)))
    job.spec.node_id = "s1.clip"
    job.status = JobStatus.CANCELLED
    queue._write(job)

    board = service.scene_board(project.id)
    states = {
        node["node_id"]: node
        for scene in board["scenes"]
        for node in (scene["clip"],)
        if node is not None
    }
    clip = states["s1.clip"]
    assert clip["status"] == "draft", "a cancelled job with a landed artifact must read from it"
    assert clip["artifact_hash"] == out_hash
