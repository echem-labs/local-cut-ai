"""The OOM fallback ladder only ever goes DOWN.

Each rung mutates the job spec's params, and it did so by plain dict merge:
`{**spec.params, **rung}`. That is correct only while nothing else sets
`resolution_scale`. Nothing did — until the failure card started offering
"render this smaller" as the one-click answer to an out-of-memory failure,
which is exactly a graph-level `resolution_scale`.

At that point the merge inverts the ladder's purpose. A node the user has
pinned to 0.5 fails, and the first retry OVERWRITES it with rung zero's
0.75 — a bigger render than the one that just ran out of memory, and one
more likely to fail again. The user's deliberate choice is silently raised
by the very mechanism meant to rescue it.

A rung is a ceiling, not an assignment. With nothing set, `min` leaves the
ladder bit-for-bit as it was (1.0 -> 0.75 -> 0.5), which is the common path
and must not move.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from localcut_engine.backends.base import BackendRegistry, OOMError
from localcut_engine.events import EventBus
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import NodeKind
from localcut_engine.jobs.models import Job
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import FALLBACK_LADDER, Scheduler


def _drain(queue_: asyncio.Queue) -> list[dict]:
    """Everything published so far. The bus hands out an asyncio.Queue rather
    than taking a callback, so the test reads it the way the WS route does."""
    events: list[dict] = []
    while not queue_.empty():
        events.append(queue_.get_nowait())
    return events


def _scheduler(tmp_path) -> tuple[Scheduler, JobQueue, asyncio.Queue]:
    events = EventBus()
    published = events.subscribe()
    queue = JobQueue(tmp_path / "queue.db")
    scheduler = Scheduler(
        queue=queue,
        backends=BackendRegistry(),
        events=events,
        output_dir_for=lambda project_id: tmp_path / project_id,
        resolve_artifact=lambda project_id, output_hash: None,
    )
    return scheduler, queue, published


def _job(params: dict) -> Job:
    return Job(
        project_id="p1",
        spec=JobSpec(
            node_id="s1.clip",
            kind=NodeKind.CLIP,
            output_hash="a" * 64,
            params=params,
            model=None,
            seed=1,
            input_hashes={},
        ),
    )


async def test_an_unset_scale_walks_the_ladder_exactly_as_before(tmp_path):
    """The path every OOM has taken until now, pinned so the fix cannot
    quietly make renders smaller than they were."""
    scheduler, queue, _ = _scheduler(tmp_path)
    job = _job({})
    queue.put(job)

    await scheduler._handle_oom(job, OOMError("cuda oom"))
    assert job.spec.params["resolution_scale"] == pytest.approx(0.75)
    assert job.attempt == 1

    await scheduler._handle_oom(job, OOMError("cuda oom"))
    assert job.spec.params["resolution_scale"] == pytest.approx(0.5)
    assert job.spec.params["offload"] == "aggressive"
    assert job.attempt == 2


async def test_a_rung_never_raises_a_scale_the_spec_already_asks_for(tmp_path):
    """The defect: 0.5 came back as 0.75, so the retry after an out-of-memory
    failure asked for MORE memory than the attempt that failed."""
    scheduler, queue, _ = _scheduler(tmp_path)
    job = _job({"resolution_scale": 0.5})
    queue.put(job)

    await scheduler._handle_oom(job, OOMError("cuda oom"))

    assert job.spec.params["resolution_scale"] == pytest.approx(0.5), (
        "the ladder raised the resolution of a job that had just run out of memory"
    )


async def test_the_rung_still_applies_everything_that_is_not_a_scale(tmp_path):
    """`offload` is an assignment and must keep landing — the ceiling rule is
    about one key, not about ignoring rungs."""
    scheduler, queue, _ = _scheduler(tmp_path)
    job = _job({"resolution_scale": 0.25})
    queue.put(job)

    await scheduler._handle_oom(job, OOMError("cuda oom"))
    await scheduler._handle_oom(job, OOMError("cuda oom"))

    assert job.spec.params["resolution_scale"] == pytest.approx(0.25)
    assert job.spec.params["offload"] == "aggressive"


async def test_the_retry_event_reports_the_rung_actually_used(tmp_path):
    """The desktop renders this as "retrying at N%", so it has to be the
    scale the retry RUNS at, not the rung's nominal value."""
    scheduler, queue, published = _scheduler(tmp_path)
    job = _job({"resolution_scale": 0.5})
    queue.put(job)

    await scheduler._handle_oom(job, OOMError("cuda oom"))

    retrying = [event for event in _drain(published) if event["type"] == "job.retrying"]
    assert retrying, "no job.retrying event was published"
    assert retrying[-1]["fallback"]["resolution_scale"] == pytest.approx(0.5)


async def test_the_ladder_still_gives_up_after_its_last_rung(tmp_path):
    """Exhaustion is what produces the suggestions the failure card renders;
    a ceiling that made rungs no-ops must not turn the ladder into a loop."""
    scheduler, queue, published = _scheduler(tmp_path)
    job = _job({"resolution_scale": 0.5})
    queue.put(job)

    for _ in range(len(FALLBACK_LADDER) + 1):
        await scheduler._handle_oom(job, OOMError("cuda oom"))

    assert job.status.value == "failed"
    failed = [event for event in _drain(published) if event["type"] == "job.failed"]
    assert failed, "no job.failed event was published"
    assert failed[-1]["suggestions"] == ["lower_resolution", "smaller_model", "cloud"]


def test_asyncio_marker_is_configured():
    """Guard against these tests silently not running: they are coroutines,
    and an unconfigured asyncio mode collects them as passing no-ops."""
    assert inspect.iscoroutinefunction(test_a_rung_never_raises_a_scale_the_spec_already_asks_for)
