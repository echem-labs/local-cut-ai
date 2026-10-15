"""Telling an engine that went down on a render from one that was stopped.

A start that finds a job `rendering` knows the last engine went down partway
through it. Requeueing it is right after a stop and wrong after a crash: a
render that takes the engine down is claimed again by the next start and the
one after that. Under docker-compose's `restart: unless-stopped` that is a
crash loop nobody has to press anything to keep going. So a stop puts itself
on record as soon as it begins, before uvicorn waits on a single connection.
A start that finds a job mid-render with no stop on record counts a crash
against it. The second one fails the job.

The tests that decide it run a real `localcut serve` in a child process and
kill it, because the question is what survives a kill: SIGKILL on POSIX and
TerminateProcess on Windows give the engine no chance to run anything.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from conftest import free_port, make_spec

from localcut_engine.api import app as engine_app
from localcut_engine.api.app import create_app
from localcut_engine.backends.base import BackendRegistry
from localcut_engine.config import EngineConfig
from localcut_engine.events import EventBus
from localcut_engine.graph.model import NodeKind
from localcut_engine.jobs import queue as job_queue
from localcut_engine.jobs.models import Job, JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore

from test_cancel import BlockingBackend

TOKEN = "stops-token"

# The engine every subprocess test runs: `localcut serve` itself, with the
# mock backend's render replaced by one that never finishes. The first job a
# new project queues (its script) is therefore always the one in flight.
_STALLED_ENGINE = """
import asyncio
import sys

from localcut_engine.backends.mock import MockBackend
from localcut_engine.cli import main


async def render_forever(self, spec, ctx):
    await asyncio.sleep(3600)


MockBackend.execute = render_forever
sys.exit(main(sys.argv[1:]))
"""


@dataclass
class Running:
    proc: subprocess.Popen
    client: httpx.Client
    port: int
    log: Path

    def said(self) -> str:
        return self.log.read_text(encoding="utf-8", errors="replace")


@contextlib.contextmanager
def started(data_dir: Path, log: Path):
    """A `localcut serve` child on its own port, up and answering. Each start
    gets a fresh port, so a killed engine's sockets in TIME_WAIT cannot hold
    up the next one."""
    port = free_port()
    # Nothing from the developer's own shell: a stray LOCALCUT_BACKEND or
    # LOCALCUT_HOST would change what is being tested.
    env = {key: value for key, value in os.environ.items() if not key.startswith("LOCALCUT_")}
    env["LOCALCUT_TOKEN"] = TOKEN
    command = [
        sys.executable,
        "-c",
        _STALLED_ENGINE,
        "serve",
        "--port",
        str(port),
        "--data-dir",
        str(data_dir),
        "--backend",
        "mock",
    ]
    with log.open("wb") as out:
        proc = subprocess.Popen(command, env=env, stdout=out, stderr=subprocess.STDOUT)
        client = httpx.Client(
            base_url=f"http://127.0.0.1:{port}",
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=10.0,
        )
        engine = Running(proc, client, port, log)
        try:
            deadline = time.monotonic() + 60
            while proc.poll() is None and time.monotonic() < deadline:
                try:
                    if client.get("/health").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.1)
            assert proc.poll() is None, f"the engine exited on startup:\n{engine.said()}"
            yield engine
        finally:
            client.close()
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=30)


def wait_for(probe, what: str, engine: Running, timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = probe()
        if found:
            return found
        assert engine.proc.poll() is None, f"the engine exited waiting for {what}:\n{engine.said()}"
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}:\n{engine.said()}")


def jobs(engine: Running) -> dict[str, dict]:
    return {job["id"]: job for job in engine.client.get("/jobs").json()}


def rendering_job(engine: Running) -> dict:
    return wait_for(
        lambda: next((j for j in jobs(engine).values() if j["status"] == "rendering"), None),
        "a job to start rendering",
        engine,
    )


def crash(engine: Running) -> None:
    """End the engine with no warning at all: SIGKILL on POSIX,
    TerminateProcess on Windows."""
    engine.proc.kill()
    engine.proc.wait(timeout=30)


def new_project(engine: Running) -> None:
    engine.client.post("/projects", json={"prompt": "a short film about tides"}).raise_for_status()


@contextlib.contextmanager
def request_in_flight(port: int):
    """A connection holding a request open: the headers sent, most of the
    body still to come. uvicorn's graceful exit waits for it before the
    lifespan's shutdown runs, which is what the desktop's open requests (a
    long LLM edit, a vision suggestion) do to a real engine."""
    sock = socket.create_connection(("127.0.0.1", port))
    head = (
        "POST /projects HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        f"Authorization: Bearer {TOKEN}\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: 4096\r\n"
        "\r\n"
        '{"prompt": '
    )
    sock.sendall(head.encode())
    try:
        yield
    finally:
        sock.close()


def stored(data_dir: Path, job_id: str) -> tuple[str, dict]:
    """A job's row as the next start will find it, read with the engine down.

    Retried for a moment: on windows-latest the first read straight after
    TerminateProcess has failed with "disk I/O error", as if the killed
    engine's hold on the WAL's shared-memory file outlived the process.
    """
    deadline = time.monotonic() + 10
    while True:
        db = sqlite3.connect(data_dir / "queue.db")
        try:
            status, payload = db.execute(
                "SELECT status, payload FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            return status, json.loads(payload)
        except sqlite3.OperationalError:
            if time.monotonic() > deadline:
                raise
        finally:
            db.close()
        time.sleep(0.2)


# -- a crash, a stop and what the next start makes of each --------------------


def test_a_job_that_keeps_taking_the_engine_down_fails_on_the_third_start(tmp_path):
    data = tmp_path / "data"
    with started(data, tmp_path / "start-1.log") as engine:
        new_project(engine)
        job = rendering_job(engine)
        crash(engine)

    with started(data, tmp_path / "start-2.log") as engine:
        again = rendering_job(engine)
        assert again["id"] == job["id"]
        assert again.get("crashes") == 1
        crash(engine)

    with started(data, tmp_path / "start-3.log") as engine:
        # Settled before the engine answered anything: the start that found
        # the job mid-render for the second time failed it instead of
        # claiming it.
        third = jobs(engine)[job["id"]]
        assert third["status"] == "failed", third
        assert third["crashes"] == job_queue.CRASH_LIMIT == 2
        assert third["error"] == job_queue.CRASHED_TOO_OFTEN
        assert third["finished_at"] is not None
        # And nothing else took its place on the GPU.
        assert not [j for j in jobs(engine).values() if j["status"] == "rendering"]


def test_a_requested_stop_that_is_killed_partway_is_not_a_crash(tmp_path):
    """The desktop asks, waits and kills an engine that has not exited by
    then. The 202 comes back once the stop is on record, so a kill any time
    after it is a stop, however early it lands. After more stops than it
    takes crashes to fail a job, the job is still claimed on the next start."""
    data = tmp_path / "data"
    job_id = None
    for start in range(job_queue.CRASH_LIMIT + 1):
        with started(data, tmp_path / f"start-{start}.log") as engine:
            if job_id is None:
                new_project(engine)
            job = rendering_job(engine)
            job_id = job_id or job["id"]
            assert job["id"] == job_id
            assert job.get("crashes", 0) == 0

            assert engine.client.post("/shutdown").status_code == 202
            # Before the engine's own shutdown could requeue it: the row is
            # still `rendering`, which is what a crash leaves too.
            crash(engine)
            status, payload = stored(data, job_id)
            assert status == "rendering"
            assert payload["engine_stopping"] is True

    with started(data, tmp_path / "last.log") as engine:
        job = rendering_job(engine)
        assert job["id"] == job_id
        assert job["crashes"] == 0
        assert job["engine_stopping"] is False


def test_a_requested_stop_runs_the_normal_exit_with_a_request_still_open(tmp_path):
    """Left alone, a requested stop is uvicorn's own graceful exit, lifespan
    shutdown and all: the scheduler requeues the render itself and the
    process exits 0. An open request must not hold that up, or the lifespan
    never runs before the desktop's kill and nothing it stops gets stopped."""
    data = tmp_path / "data"
    with started(data, tmp_path / "start.log") as engine:
        new_project(engine)
        job = rendering_job(engine)
        with request_in_flight(engine.port):
            assert engine.client.post("/shutdown").status_code == 202
            try:
                code = engine.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                raise AssertionError(f"the engine did not exit:\n{engine.said()}") from None
        assert code == 0, engine.said()

    status, payload = stored(data, job["id"])
    assert status == "queued"
    assert payload.get("crashes", 0) == 0
    assert payload.get("engine_stopping") is False


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="nothing can send a console child of a GUI app SIGTERM on Windows; "
    "the desktop stops the engine over HTTP there",
)
def test_sigterm_records_the_stop_before_it_waits_on_connections(tmp_path):
    """SIGTERM is how docker, systemd and the desktop's own fallback stop an
    engine. uvicorn spends the first part of its exit waiting on open
    connections and only then runs the lifespan, so a stop recorded there
    is not recorded at all when the kill lands during the wait."""
    data = tmp_path / "data"
    with started(data, tmp_path / "start-1.log") as engine:
        new_project(engine)
        job = rendering_job(engine)
        with request_in_flight(engine.port):
            engine.proc.send_signal(signal.SIGTERM)
            # Well inside the wait on the open request.
            time.sleep(engine_app.SHUTDOWN_DRAIN_S / 2)
            crash(engine)
    status, payload = stored(data, job["id"])
    assert status == "rendering"
    assert payload["engine_stopping"] is True

    with started(data, tmp_path / "start-2.log") as engine:
        again = rendering_job(engine)
        assert again["id"] == job["id"]
        assert again["crashes"] == 0


# -- the queue's side of it ----------------------------------------------------


def _claimed(queue: JobQueue, output_hash: str = "c" * 64) -> Job:
    queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash=output_hash)))
    job = queue.claim_next()
    assert job is not None
    return job


def test_each_start_that_finds_a_job_mid_render_counts_one_crash(tmp_path):
    db = tmp_path / "queue.db"
    queue = JobQueue(db)
    job = _claimed(queue)
    queue.close()

    queue = JobQueue(db)  # the engine went down with it rendering
    first = queue.get(job.id)
    assert first.status is JobStatus.QUEUED
    assert first.crashes == 1
    assert queue.claim_next().id == job.id
    queue.close()

    queue = JobQueue(db)  # and again
    second = queue.get(job.id)
    assert second.status is JobStatus.FAILED
    assert second.crashes == 2
    assert second.error == job_queue.CRASHED_TOO_OFTEN
    assert queue.claim_next() is None
    queue.close()


def test_a_job_mid_render_with_a_stop_on_record_is_requeued_uncounted(tmp_path):
    db = tmp_path / "queue.db"
    queue = JobQueue(db)
    job = _claimed(queue)
    assert queue.mark_engine_stopping(job.id)
    queue.close()

    queue = JobQueue(db)
    found = queue.get(job.id)
    assert found.status is JobStatus.QUEUED
    assert found.crashes == 0
    assert found.engine_stopping is False
    queue.close()


def test_a_stop_is_on_record_only_for_the_claim_it_interrupted(tmp_path):
    """A job requeued by a stop and claimed again by the next engine is a
    new render. If that one takes the engine down, it counts."""
    db = tmp_path / "queue.db"
    queue = JobQueue(db)
    job = _claimed(queue)
    queue.mark_engine_stopping(job.id)
    queue.close()

    queue = JobQueue(db)
    reclaimed = queue.claim_next()
    assert reclaimed.id == job.id
    assert reclaimed.engine_stopping is False
    queue.close()

    queue = JobQueue(db)
    assert queue.get(job.id).crashes == 1
    queue.close()


def test_a_stop_is_not_recorded_on_a_job_that_is_no_longer_rendering(tmp_path):
    queue = JobQueue(tmp_path / "queue.db")
    job = _claimed(queue)
    assert queue.cancel(job.id)
    assert not queue.mark_engine_stopping(job.id)
    assert queue.get(job.id).status is JobStatus.CANCELLED
    queue.close()


# -- the scheduler's side of it ------------------------------------------------


def _scheduler(tmp_path, queue: JobQueue, backend) -> Scheduler:
    store = ProjectStore(tmp_path / "projects")
    backends = BackendRegistry()
    backends.register(backend)
    return Scheduler(
        queue=queue,
        backends=backends,
        events=EventBus(),
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
    )


async def test_a_normal_shutdown_still_requeues_and_counts_nothing(tmp_path):
    db = tmp_path / "queue.db"
    queue = JobQueue(db)
    backend = BlockingBackend()
    scheduler = _scheduler(tmp_path, queue, backend)
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))
    scheduler.start()
    await asyncio.wait_for(backend.started.wait(), timeout=5)

    await scheduler.stop(grace_s=0.2)
    assert queue.get(job.id).status is JobStatus.QUEUED
    queue.close()

    queue = JobQueue(db)
    found = queue.get(job.id)
    assert found.status is JobStatus.QUEUED
    assert found.crashes == 0
    queue.close()


async def test_a_cancel_still_cancels_and_counts_nothing(tmp_path):
    db = tmp_path / "queue.db"
    queue = JobQueue(db)
    backend = BlockingBackend()
    scheduler = _scheduler(tmp_path, queue, backend)
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))
    scheduler.start()
    await asyncio.wait_for(backend.started.wait(), timeout=5)

    assert queue.cancel(job.id)
    assert scheduler.cancel_running(job.id)
    async with asyncio.timeout(5):
        while backend.interrupted == 0:
            await asyncio.sleep(0.02)
    await scheduler.stop()
    queue.close()

    queue = JobQueue(db)
    found = queue.get(job.id)
    assert found.status is JobStatus.CANCELLED
    assert found.crashes == 0
    queue.close()


async def test_beginning_a_stop_records_it_on_the_render_in_flight(tmp_path):
    queue = JobQueue(tmp_path / "queue.db")
    backend = BlockingBackend()
    scheduler = _scheduler(tmp_path, queue, backend)
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))
    scheduler.start()
    await asyncio.wait_for(backend.started.wait(), timeout=5)

    await scheduler.begin_stop()
    found = queue.get(job.id)
    # On record and still rendering: the grace that lets a render about to
    # finish do so has not even started yet.
    assert found.status is JobStatus.RENDERING
    assert found.engine_stopping is True
    assert backend.interrupted == 0

    await scheduler.stop(grace_s=0.2)
    assert queue.get(job.id).status is JobStatus.QUEUED
    queue.close()


async def test_a_job_claimed_as_the_stop_begins_goes_back_unrendered(tmp_path):
    """The claim runs on a worker thread. A stop that begins while it is in
    flight finds nothing rendering to record, so the job the claim comes
    back with must not start. It would render with no stop on record and a
    kill would count against it."""
    queue = JobQueue(tmp_path / "queue.db")
    backend = BlockingBackend()
    scheduler = _scheduler(tmp_path, queue, backend)
    job = queue.put(Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64)))

    claiming = asyncio.Event()
    release = asyncio.Event()
    loop = asyncio.get_running_loop()
    claim = queue.claim_next

    def held_claim():
        loop.call_soon_threadsafe(claiming.set)
        asyncio.run_coroutine_threadsafe(release.wait(), loop).result(timeout=10)
        return claim()

    queue.claim_next = held_claim  # type: ignore[method-assign]
    scheduler.start()
    await asyncio.wait_for(claiming.wait(), timeout=5)
    stopping = asyncio.ensure_future(scheduler.begin_stop())
    await asyncio.sleep(0)
    release.set()
    await stopping
    await scheduler.stop(grace_s=1.0)

    assert not backend.started.is_set()
    assert queue.get(job.id).status is JobStatus.QUEUED
    queue.close()


# -- the route ---------------------------------------------------------------


async def test_the_shutdown_route_needs_the_token(tmp_path):
    app = create_app(EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock"))
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(transport=transport, base_url="http://engine") as http,
        app.router.lifespan_context(app),
    ):
        response = await http.post("/shutdown", headers={"Authorization": "Bearer wrong"})
        assert response.status_code == 401


async def test_an_engine_that_cannot_stop_itself_says_so_and_changes_nothing(tmp_path):
    """Served by something other than `localcut serve` (a test, an embedding
    host), nothing can end the server. Recording a stop that is not
    happening would only stop the scheduler claiming work."""
    app = create_app(EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock"))
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://engine",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as http,
        app.router.lifespan_context(app),
    ):
        response = await http.post("/shutdown")
        assert response.status_code == 503
        assert "cannot stop itself" in response.json()["detail"]

        # Still rendering what it is given.
        created = await http.post("/projects", json={"prompt": "a short film about tides"})
        project_id = created.json()["id"]
        async with asyncio.timeout(15):
            while not [
                job
                for job in (await http.get("/jobs", params={"project_id": project_id})).json()
                if job["status"] == "done"
            ]:
                await asyncio.sleep(0.05)
