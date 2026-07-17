"""GPU-serial scheduler — the scheduler owns VRAM as a resource; naive
parallelism = OOM. One job renders at a time; OOM walks the
fallback ladder (lower res → fewer steps → suggest cloud).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from ..backends.base import BackendRegistry, ExecutionContext, GenerationError, OOMError
from ..graph.model import OPTIONAL_PORTS, NodeKind
from ..events import EventBus
from .models import Job, JobStatus
from .queue import JobQueue

logger = logging.getLogger(__name__)

# Each rung mutates the job spec params; the last failure offers cloud.
FALLBACK_LADDER: list[dict[str, Any]] = [
    {"resolution_scale": 0.75},
    {"resolution_scale": 0.5, "offload": "aggressive"},
]

ArtifactResolver = Callable[[str, str], Path | None]  # (project_id, output_hash) -> path
JobHook = Callable[[Job], Awaitable[None]]


class Scheduler:
    def __init__(
        self,
        queue: JobQueue,
        backends: BackendRegistry,
        events: EventBus,
        output_dir_for: Callable[[str], Path],
        resolve_artifact: ArtifactResolver,
        on_job_done: JobHook | None = None,
    ) -> None:
        self.queue = queue
        self.backends = backends
        self.events = events
        self.output_dir_for = output_dir_for
        self.resolve_artifact = resolve_artifact
        self.on_job_done = on_job_done
        self._wakeup = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.events.bind_to_running_loop()
        self._task = self._loop.create_task(self._run(), name="scheduler")

    async def stop(self) -> None:
        self._stopping = True
        self._wakeup.set()
        if self._task is not None:
            await self._task

    def notify(self) -> None:
        """Call after enqueueing work — safe from worker threads."""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._loop is not None and running is not self._loop:
            self._loop.call_soon_threadsafe(self._wakeup.set)
        else:
            self._wakeup.set()

    async def _run(self) -> None:
        while not self._stopping:
            try:
                job = self.queue.next_queued()
            except Exception:  # noqa: BLE001 — a bad row must not kill the loop
                logger.exception("scheduler failed to read the queue; retrying")
                await asyncio.sleep(5.0)
                continue
            if job is None:
                self._wakeup.clear()
                try:
                    # Every in-process enqueue calls notify(); the timeout only
                    # covers out-of-process writers sharing the queue db.
                    await asyncio.wait_for(self._wakeup.wait(), timeout=30.0)
                except TimeoutError:
                    pass
                continue
            try:
                await self._execute(job)
            except Exception:  # noqa: BLE001 — one job must never kill the loop
                # _execute does pre-`try` work (persist RENDERING, publish
                # job.started); if that raises (e.g. the queue db is locked)
                # the exception would otherwise escape _run and stop the
                # scheduler forever, wedging every later job as QUEUED.
                logger.exception("scheduler crashed handling job %s", job.id)
                if not self._fail_quietly(job):
                    # Couldn't even persist the failure — back off so we don't
                    # hot-loop the same still-QUEUED row against a locked db.
                    await asyncio.sleep(1.0)

    async def _execute(self, job: Job) -> None:
        job.status = JobStatus.RENDERING
        job.progress = 0.0
        job.started_at = time.time()
        try:
            job.backend = self.backends.resolve(job.spec.kind, job.spec.model).name
        except GenerationError:
            job.backend = None  # the resolve below fails the job properly
        if not self.queue.update_unless_cancelled(job):
            return  # cancelled before it started — do not render it
        self.events.publish(
            "job.started", job_id=job.id, node_id=job.spec.node_id, project_id=job.project_id
        )

        persisted = 0.0
        cancelled = False

        async def report(fraction: float) -> None:
            nonlocal persisted, cancelled
            if cancelled:
                return  # a cancel already won — stop persisting and emitting
            job.progress = fraction
            # Persist coarsely so board polls see live progress without a disk
            # write per sampler step.
            if fraction - persisted >= 0.05:
                persisted = fraction
                # A progress write rewrites the whole row from the in-memory
                # job (still RENDERING), so it would resurrect a job cancelled
                # in the meantime. update_unless_cancelled makes the check and
                # write atomic against a threaded cancel (project deletion runs
                # queue.cancel_project on a worker thread, not this loop).
                if not self.queue.update_unless_cancelled(job):
                    cancelled = True
                    return
            self.events.publish(
                "job.progress",
                job_id=job.id,
                node_id=job.spec.node_id,
                progress=fraction,
                project_id=job.project_id,
            )

        inputs: dict[str, Path] = {}
        missing = []
        for port, input_hash in job.spec.input_hashes.items():
            path = self.resolve_artifact(job.project_id, input_hash)
            if path is None:
                if port not in OPTIONAL_PORTS:
                    missing.append(port)
            else:
                inputs[port] = path

        ctx = ExecutionContext(
            output_dir=self.output_dir_for(job.project_id),
            input_artifacts=inputs,
            report_progress=report,
        )
        try:
            if missing and job.spec.kind in (
                NodeKind.CLIP,
                NodeKind.CAPTIONS,
                NodeKind.TIMELINE,
                NodeKind.EXPORT,
            ):
                raise RuntimeError(f"missing upstream artifacts on ports: {missing}")
            backend = self.backends.resolve(job.spec.kind, job.spec.model)
            artifact = await backend.execute(job.spec, ctx)
            job.status = JobStatus.DONE
            job.progress = 1.0
            job.artifact = str(artifact)
            job.finished_at = time.time()
            if not self.queue.update_unless_cancelled(job):
                return  # user cancelled during the render — honor it, skip DONE
            self.events.publish(
                "job.done",
                job_id=job.id,
                node_id=job.spec.node_id,
                artifact=str(artifact),
                project_id=job.project_id,
            )
        except OOMError as exc:
            await self._handle_oom(job, exc)
            return
        except Exception as exc:  # noqa: BLE001 — job isolation boundary
            logger.exception("job %s failed", job.id)
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.finished_at = time.time()
            if not self.queue.update_unless_cancelled(job):
                return  # the user's cancel outranks whatever the render died of
            self.events.publish(
                "job.failed",
                job_id=job.id,
                node_id=job.spec.node_id,
                error=str(exc),
                project_id=job.project_id,
            )
            return
        # The hook runs outside the job's try: a follow-up failure (e.g.
        # screenplay expansion) must not flip a persisted DONE to FAILED.
        if self.on_job_done is not None:
            try:
                await self.on_job_done(job)
            except Exception as exc:  # noqa: BLE001
                logger.exception("post-completion hook failed for job %s", job.id)
                self.events.publish(
                    "project.error",
                    project_id=job.project_id,
                    node_id=job.spec.node_id,
                    error=str(exc),
                )

    def _fail_quietly(self, job: Job) -> bool:
        """Best-effort mark a job FAILED after an unexpected scheduler error.
        Returns False if even the persist failed, so the loop can back off
        instead of hot-looping the still-QUEUED row."""
        try:
            job.status = JobStatus.FAILED
            job.error = "scheduler error while running the job"
            job.finished_at = time.time()
            if self.queue.update_unless_cancelled(job):
                self.events.publish(
                    "job.failed",
                    job_id=job.id,
                    node_id=job.spec.node_id,
                    error=job.error,
                    project_id=job.project_id,
                )
            return True
        except Exception:  # noqa: BLE001
            logger.exception("could not persist failure for job %s", job.id)
            return False

    async def _handle_oom(self, job: Job, exc: OOMError) -> None:
        if job.attempt < len(FALLBACK_LADDER):
            rung = FALLBACK_LADDER[job.attempt]
            job.attempt += 1
            job.spec.params = {**job.spec.params, **rung}
            job.status = JobStatus.QUEUED
            job.progress = 0.0
            if not self.queue.update_unless_cancelled(job):
                return  # never resurrect a job the user cancelled mid-render
            self.events.publish(
                "job.retrying",
                job_id=job.id,
                node_id=job.spec.node_id,
                attempt=job.attempt,
                fallback=rung,
                project_id=job.project_id,
            )
            self.notify()
            return
        job.status = JobStatus.FAILED
        job.error = f"out of memory after {job.attempt} fallback attempts: {exc}"
        job.finished_at = time.time()
        if not self.queue.update_unless_cancelled(job):
            return  # cancelled mid-render — leave the CANCELLED status intact
        # The UI renders this as choices, not an error code.
        self.events.publish(
            "job.failed",
            job_id=job.id,
            node_id=job.spec.node_id,
            error=job.error,
            suggestions=["lower_resolution", "smaller_model", "cloud"],
            project_id=job.project_id,
        )
