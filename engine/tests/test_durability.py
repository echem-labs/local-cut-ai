"""Durability: the job queue's claim, artifact-path portability, the project
format version, project deletion under a live render, and shutdown."""

import asyncio
import json
import shutil

import pytest

from conftest import make_spec
from localcut_engine.backends.base import BackendRegistry, ExecutionBackend
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.model import GRAPH_VERSION, Node, NodeKind, StoryGraph
from localcut_engine.jobs.models import Job, JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler, _relative_artifact
from localcut_engine.project.store import ProjectStore, ProjectTooNew, ProjectUnreadable
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


def _seed_graph() -> StoryGraph:
    graph = StoryGraph()
    graph.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "x"}))
    return graph


# -- DUR-2: the claim is atomic ---------------------------------------------


def test_claim_is_atomic_so_two_schedulers_cannot_pop_one_job(tmp_path):
    """A plain SELECT that leaves the row QUEUED lets two schedulers against
    one database pop the same job and render it twice. The desktop app's
    single-instance lock closes the common path, but a headless engine or an
    explicit second --port still reaches it."""
    db = tmp_path / "queue.db"
    one, two = JobQueue(db), JobQueue(db)
    job = one.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))

    claimed = one.claim_next()
    assert claimed.id == job.id and claimed.status is JobStatus.RENDERING
    # The second scheduler must find nothing — not the same row again.
    assert two.claim_next() is None
    assert two.get(job.id).status is JobStatus.RENDERING
    one.close()
    two.close()


def test_a_poisoned_row_does_not_wedge_the_claim(tmp_path):
    """An unreadable payload must fail in place and let the next job through,
    not block the queue forever."""
    queue = JobQueue(tmp_path / "queue.db")
    good = queue.put(
        Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64), created_at=2.0)
    )
    queue._db.execute(
        "INSERT INTO jobs(id, project_id, status, created_at, payload) VALUES(?,?,?,?,?)",
        ("bad00bad00bad", "p", JobStatus.QUEUED, 1.0, "{not json"),
    )
    queue._db.commit()

    assert queue.claim_next().id == good.id
    assert queue.status_of("bad00bad00bad") == JobStatus.FAILED
    # And the unreadable row must not take the whole listing down with it —
    # /jobs (and the board behind it) would 500 forever.
    assert [j.id for j in queue.list("p")] == [good.id]
    assert queue.get("bad00bad00bad") is None
    queue.close()


# -- DUR-6: artifact paths are portable --------------------------------------


def test_artifact_paths_survive_a_moved_data_dir(tmp_path):
    """Job.artifact is recorded relative to generated/. An absolute path
    breaks on a moved data dir, a reinstall under another account, or a
    backup restored onto a new machine: the artifact is still present under
    its hash, but the recorded path is not, so tool promotion reports "the
    script has not finished generating yet" forever."""
    store = ProjectStore(tmp_path / "old")
    project = store.create(title="t", graph=_seed_graph())
    generated = store.generated_dir(project.id)
    generated.mkdir(parents=True, exist_ok=True)
    artifact = generated / ("f" * 64 + ".mp4")
    artifact.write_bytes(b"video")

    relative = _relative_artifact(artifact, generated)
    assert relative == "f" * 64 + ".mp4"
    assert store.resolve_job_artifact(project.id, relative) == artifact

    # Move the whole data dir: the relative record still resolves.
    shutil.move(str(tmp_path / "old"), str(tmp_path / "new"))
    relocated = ProjectStore(tmp_path / "new")
    assert relocated.resolve_job_artifact(project.id, relative) is not None

    # A stale ABSOLUTE record from an older build still resolves by basename.
    stale = str(tmp_path / "gone" / ("f" * 64 + ".mp4"))
    assert relocated.resolve_job_artifact(project.id, stale) is not None

    assert relocated.resolve_job_artifact(project.id, None) is None
    assert relocated.resolve_job_artifact(project.id, "no-such-file.mp4") is None


async def test_the_scheduler_records_a_relative_artifact(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    backends = BackendRegistry()
    backends.register(MockBackend())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=EventBus(),
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
    )
    project = store.create(title="t", graph=_seed_graph())
    job = queue.put(
        Job(project_id=project.id, spec=make_spec(NodeKind.KEYFRAME, output_hash="a" * 64))
    )
    scheduler.start()
    try:
        await wait_for(lambda: queue.get(job.id).status is JobStatus.DONE, timeout=10)
    finally:
        await scheduler.stop()
    recorded = queue.get(job.id).artifact
    assert recorded == "a" * 64 + ".png"
    assert store.resolve_job_artifact(project.id, recorded) is not None
    queue.close()


async def test_a_job_is_not_finished_until_the_work_it_plans_is_queued(tmp_path):
    """Nothing queued or rendering is what "the render finished" means to a
    caller: `wait_for_render` returns on it and the CLI exits 0.

    So the gap between a job's DONE row and the jobs its own completion goes
    on to enqueue is a gap in which a render reports success over work that
    never ran. The script node is the real case - completing it is what
    expands the screenplay into scenes - and the hook that does the expanding
    loads a graph, saves it and enqueues, all after the DONE write. A poll
    landing in there exported a project whose scenes had not been enqueued
    yet, and `export` then refused with "no finished cut yet" over a render
    that had just reported success.
    """
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    backends = BackendRegistry()
    backends.register(MockBackend())
    project = store.create(title="t", graph=_seed_graph())

    outstanding_while_planning: list[list[str]] = []

    async def plan_more_work(job: Job) -> None:
        # Stands in for the screenplay expansion: the hook is where a
        # completion turns into the next round of jobs.
        if job.spec.kind is not NodeKind.SCRIPT:
            return
        outstanding_while_planning.append([j.id for j in queue.active(project.id)])
        queue.put(
            Job(project_id=project.id, spec=make_spec(NodeKind.KEYFRAME, output_hash="b" * 64))
        )

    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=EventBus(),
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
        on_job_done=plan_more_work,
    )
    script = queue.put(Job(project_id=project.id, spec=make_spec(NodeKind.SCRIPT)))
    scheduler.start()
    try:
        await wait_for(lambda: len(outstanding_while_planning) == 1, timeout=10)
    finally:
        await scheduler.stop()

    assert outstanding_while_planning == [[script.id]], (
        "the project read as idle while the work its script job planned was "
        "still being enqueued - a render waiting on an empty queue would call "
        "that finished"
    )
    queue.close()


# -- DUR-1: the project format is versioned ----------------------------------


def test_a_project_from_the_future_is_refused_not_silently_reduced(tmp_path):
    """Every model uses pydantic's default extra='ignore', so an older engine
    opening a newer project drops the fields it does not know — and the next
    action that touches the graph writes the reduced object back. The user's
    work is gone with no error and nothing to detect it against."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())
    path = store.project_dir(project.id) / "project.json"

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["version"] == GRAPH_VERSION

    saved["version"] = GRAPH_VERSION + 1
    saved["nodes"]["script"]["someFutureField"] = "must not be dropped silently"
    path.write_text(json.dumps(saved), encoding="utf-8")

    with pytest.raises(ProjectTooNew, match="newer version"):
        store.load_graph(project.id)
    # Refusing means refusing: the file is not rewritten on the way out.
    assert "someFutureField" in path.read_text(encoding="utf-8")


def test_a_state_file_that_is_not_utf8_is_refused_with_a_reason(tmp_path):
    """Builds before the store forced encoding="utf-8" wrote project.json in
    the Windows ANSI code page, so any em dash in a prompt — which the app's
    own generated titles are full of — landed as a lone 0x97. The file is
    unreadable forever afterwards, and the read raised UnicodeDecodeError
    out of a route whose contract is to refuse with a reason: the project
    became a bare 500 with nothing on screen to say which one, or why."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())
    path = store.project_dir(project.id) / "project.json"

    # Exactly what the old writer produced: valid cp1252, invalid UTF-8.
    # An extra key keeps the document valid JSON, so the ONLY thing wrong
    # with it is the encoding.
    saved = json.loads(path.read_text(encoding="utf-8"))
    saved["note"] = "whats new in LA — it starts with a question"
    path.write_bytes(json.dumps(saved, ensure_ascii=False).encode("cp1252"))
    assert bytes([0x97]) in path.read_bytes()  # the cp1252 em dash

    with pytest.raises(ProjectUnreadable, match="project.json"):
        store.load_graph(project.id)


def test_a_project_with_no_version_is_a_pre_versioning_project(tmp_path):
    """Absent is version 1, not "from the future" — existing projects must
    keep opening."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())
    path = store.project_dir(project.id) / "project.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    del saved["version"]
    path.write_text(json.dumps(saved), encoding="utf-8")

    graph = store.load_graph(project.id)
    assert graph.nodes["script"].params["prompt"] == "x"
    # Saving stamps the current version, so it is no longer ambiguous.
    store.save_graph(project.id, graph)
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == GRAPH_VERSION


async def test_a_future_project_surfaces_as_409_not_500(tmp_path):
    """A project written by a newer engine is a conflict the user can fix by
    updating, not corruption — surfacing it as a 500 invites exactly the
    wrong recovery."""
    import httpx

    from localcut_engine.api.app import create_app
    from localcut_engine.config import EngineConfig

    config = EngineConfig(data_dir=tmp_path, token="t", backend="mock")
    app = create_app(config)
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://engine",
            headers={"Authorization": "Bearer t"},
        ) as client,
    ):
        created = await client.post("/projects", json={"prompt": "x"})
        pid = created.json()["id"]
        path = config.projects_dir / f"{pid}.lcut" / "project.json"
        saved = json.loads(path.read_text(encoding="utf-8"))
        saved["version"] = GRAPH_VERSION + 5
        path.write_text(json.dumps(saved), encoding="utf-8")

        response = await client.get(f"/projects/{pid}/graph")
        assert response.status_code == 409
        assert "newer version" in response.json()["detail"]


# -- DUR-5: deletion under a live render -------------------------------------


async def test_deleting_a_mid_render_project_leaves_no_orphan_directory(rig):
    """rmtree racing a live render either raises "Directory not empty" (meta
    gone, multi-GB of artifacts left) or loses to the render's next
    output_path() call, which re-creates the directory. Either orphan has no
    meta.json, so it never appears in the project list and is never counted
    by Settings → Storage: disk the user can neither see nor reclaim."""
    store, _queue, service = rig
    project = service.create_from_prompt("a doomed project", target_duration_s=24)
    await wait_for(lambda: bool(service.scene_board(project.id)["scenes"]))

    assert store.generated_dir(project.id).exists()
    assert service.delete(project.id) is True
    assert service.delete(project.id) is False  # idempotent

    assert not any(p.id == project.id for p in store.list())
    assert not store.project_dir(project.id).exists()
    assert list(store.root.glob(".deleting-*")) == []


def test_a_reserved_project_disappears_from_the_list_immediately(tmp_path):
    """The rename is what makes deletion instant from the user's point of
    view — before a single byte is removed, and regardless of what a backend
    is still writing."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())

    doomed = store.reserve_for_deletion(project.id)
    assert doomed.exists() and doomed.name.startswith(".deleting-")
    assert store.list() == []
    assert store.get(project.id) is None

    assert store.purge(doomed) is True
    assert not doomed.exists()


def test_interrupted_deletions_are_reclaimed_on_the_next_start(tmp_path):
    """A directory the sweep could not finish is invisible to the project
    list — so without this it is disk the user can never see or reclaim."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())
    doomed = store.reserve_for_deletion(project.id)
    # Simulate a render that re-created a file after the rename.
    (doomed / "generated").mkdir(parents=True, exist_ok=True)
    (doomed / "generated" / "late.mp4").write_bytes(b"x")

    assert store.sweep_pending_deletions() == 1
    assert not doomed.exists()
    assert store.sweep_pending_deletions() == 0  # nothing left to do


def test_a_directory_recreated_under_the_original_name_is_reclaimed(tmp_path):
    """The reservation renames the project away, but a backend that has not
    stopped yet calls output_path(), whose mkdir(parents=True) re-creates the
    ORIGINAL path and writes artifacts into it. Purging only the reserved copy
    leaves that behind — and with no meta.json it never appears in list(), so
    nothing would ever reclaim it: the precise orphan reserve/purge exists to
    prevent, reintroduced one directory over."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())
    doomed = store.reserve_for_deletion(project.id)

    recreated = store.project_dir(project.id)
    (recreated / "generated").mkdir(parents=True, exist_ok=True)
    (recreated / "generated" / "late.mp4").write_bytes(b"x" * 4096)
    assert store.purge(doomed) is True

    assert store.purge_recreated(project.id) is True
    assert not recreated.exists()
    assert store.purge_recreated(project.id) is False  # idempotent


def test_a_live_project_is_never_mistaken_for_an_orphan(tmp_path):
    """The whole test above turns on 'no meta.json means nobody can open it'.
    If that ever stops being true the sweep deletes real projects, so the
    negative case is asserted next to the positive one."""
    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="keep me", graph=_seed_graph())

    assert store.purge_recreated(project.id) is False
    assert store.sweep_pending_deletions() == 0
    assert store.get(project.id) is not None
    assert store.project_dir(project.id).exists()


def test_a_skeleton_from_a_killed_delete_is_reclaimed_on_the_next_start(tmp_path):
    """Same orphan, but created after ProjectService.delete already returned —
    a render killed with the engine. Only the next start can catch it."""
    store = ProjectStore(tmp_path / "projects")
    keep = store.create(title="keep me", graph=_seed_graph())
    orphan = store.root / "deadbeef.lcut"
    (orphan / "generated").mkdir(parents=True)
    (orphan / "generated" / "late.mp4").write_bytes(b"x" * 4096)

    assert store.sweep_pending_deletions() == 1
    assert not orphan.exists()
    assert [p.id for p in store.list()] == [keep.id]


# -- DUR-4: shutdown cancels the running job ---------------------------------


async def test_shutdown_cancels_a_running_job_instead_of_blocking_on_it(tmp_path):
    """stop() awaiting the task with no cancel means quitting during a render
    blocks for the length of that render — up to ComfyUI's 600s inactivity
    window for a stalled workflow. The shell then force-kills the engine,
    which skips this shutdown entirely: the DB row stays `rendering` until
    the next boot, and ffmpeg children survive as orphans."""
    started = asyncio.Event()

    class WedgedBackend(ExecutionBackend):
        name = "wedged"

        def supports(self, kind):
            return True

        async def execute(self, spec, ctx):
            started.set()
            await asyncio.sleep(600)  # the stalled-workflow case

    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    backends = BackendRegistry()
    backends.register(WedgedBackend())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=EventBus(),
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
    )
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))
    scheduler.start()
    await asyncio.wait_for(started.wait(), timeout=5)

    loop = asyncio.get_running_loop()
    began = loop.time()
    await scheduler.stop(grace_s=0.2)
    assert loop.time() - began < 10, "stop() waited for the render instead of cancelling it"

    # Requeued, not left RENDERING for the next boot to find.
    assert queue.get(job.id).status is JobStatus.QUEUED
    queue.close()


async def test_a_clean_shutdown_still_lets_a_quick_job_finish(tmp_path):
    """The cancel is a backstop, not the normal path: a render that is about
    to finish must not be thrown away."""
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    backends = BackendRegistry()
    backends.register(MockBackend())
    project = store.create(title="t", graph=_seed_graph())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=EventBus(),
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
    )
    job = queue.put(
        Job(project_id=project.id, spec=make_spec(NodeKind.KEYFRAME, output_hash="b" * 64))
    )
    scheduler.start()
    await wait_for(lambda: queue.get(job.id).status is JobStatus.DONE, timeout=10)
    await scheduler.stop()
    assert queue.get(job.id).status is JobStatus.DONE
    queue.close()


# -- DUR-7: concurrent download starts ---------------------------------------


async def test_concurrent_starts_never_produce_two_writers_on_one_file(tmp_path):
    """Two starts that both observe a cancelling task would both create a
    task, and only the second is tracked — the first becomes invisible to
    cancel(), to delete()'s in-progress guard and to shutdown(), while both
    append to the same .part file."""
    from localcut_engine.config import EngineConfig
    from localcut_engine.manifest.manager import DownloadManager

    manifest = {
        "models": [
            {
                "id": "m1",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [
                    {"url": "https://example.com/a", "dest": "checkpoints/a.bin", "size": 10}
                ],
            }
        ]
    }
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    manager = DownloadManager(EngineConfig(data_dir=tmp_path), EventBus())

    running = asyncio.Event()

    async def slow_download(*args, **kwargs):
        running.set()
        await asyncio.sleep(30)

    manager._run = slow_download  # type: ignore[method-assign]

    first, second = await asyncio.gather(manager.start("m1"), manager.start("m1"))
    assert sorted([first, second]) == ["downloading", "started"]
    assert len(manager._tasks) == 1

    await asyncio.wait_for(running.wait(), timeout=5)
    assert manager.cancel("m1") is True  # the one live task is the tracked one
    await manager.shutdown()


def test_a_reader_holding_the_file_open_does_not_lose_the_write(tmp_path, monkeypatch):
    """Windows refuses MoveFileEx(REPLACE_EXISTING) while any handle to the
    destination is open. Meta and graph reads run concurrently with these
    rewrites — the API reads them on worker threads and job completions
    rewrite them constantly — so a reader holding the file for microseconds
    was enough to fail the write, losing a project update for no reason the
    user could ever explain. `_read_text_retry` had always handled the read
    side of this race; the write side had nothing."""
    from localcut_engine.project import store as store_module

    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="original", graph=_seed_graph())

    real_replace = store_module.os.replace
    calls = {"n": 0}

    def flaky_replace(src, dst):
        # Deny the first two attempts, exactly as a concurrent reader would.
        calls["n"] += 1
        if calls["n"] <= 2:
            raise PermissionError(5, "Access is denied")
        return real_replace(src, dst)

    monkeypatch.setattr(store_module.os, "replace", flaky_replace)
    project.title = "renamed"
    store.save_meta(project)

    assert calls["n"] == 3, "the write should have retried, not given up or spun"
    assert store.get(project.id).title == "renamed"
    # No temp files left behind by the failed attempts.
    assert [p.name for p in store.project_dir(project.id).glob(".meta.json.*")] == []


def test_a_write_that_never_succeeds_still_raises(tmp_path, monkeypatch):
    """Retrying must not turn a real, permanent failure into silence."""
    from localcut_engine.project import store as store_module

    store = ProjectStore(tmp_path / "projects")
    project = store.create(title="t", graph=_seed_graph())

    def always_denied(src, dst):
        raise PermissionError(5, "Access is denied")

    monkeypatch.setattr(store_module.os, "replace", always_denied)
    with pytest.raises(PermissionError):
        store.save_meta(project)
    assert [p.name for p in store.project_dir(project.id).glob(".meta.json.*")] == []


async def test_killing_an_already_dead_child_does_not_mask_the_cancellation():
    """_terminating fires while an exception is unwinding, so every signal it
    sends must be guarded. A child that exits between the returncode check and
    the signal raises ProcessLookupError — which would REPLACE the
    CancelledError being propagated, and the scheduler only requeues a job on
    CancelledError. Anything else records it as failed."""
    from localcut_engine.backends.ffmpeg import _terminating

    class AlreadyGone:
        """Reports itself running, then refuses both signals — the race the
        guard exists for, made deterministic."""

        returncode = None
        signalled = 0

        def terminate(self):
            AlreadyGone.signalled += 1
            raise ProcessLookupError(3, "No such process")

        def kill(self):
            AlreadyGone.signalled += 1
            raise ProcessLookupError(3, "No such process")

        async def wait(self):
            await asyncio.sleep(10)  # never returns: forces the kill path too

        async def communicate(self):
            raise asyncio.CancelledError()

    process = AlreadyGone()
    with pytest.raises(asyncio.CancelledError):
        async with _terminating(process) as proc:
            await proc.communicate()
    assert AlreadyGone.signalled == 2  # both terminate and kill were attempted
