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

from ..backends.base import BackendRegistry, ExecutionContext, OOMError
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
        self._stopping = False

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._run(), name="scheduler")

    async def stop(self) -> None:
        self._stopping = True
        self._wakeup.set()
        if self._task is not None:
            await self._task

    def notify(self) -> None:
        """Call after enqueueing work."""
        self._wakeup.set()

    async def _run(self) -> None:
        while not self._stopping:
            job = self.queue.next_queued()
            if job is None:
                self._wakeup.clear()
                try:
                    await asyncio.wait_for(self._wakeup.wait(), timeout=2.0)
                except TimeoutError:
                    pass
                continue
            await self._execute(job)

    async def _execute(self, job: Job) -> None:
        job.status = JobStatus.RENDERING
        job.progress = 0.0
        job.started_at = time.time()
        self.queue.update(job)
        self.events.publish("job.started", job_id=job.id, node_id=job.spec.node_id)

        async def report(fraction: float) -> None:
            job.progress = fraction
            self.events.publish(
                "job.progress", job_id=job.id, node_id=job.spec.node_id, progress=fraction
            )

        inputs: dict[str, Path] = {}
        missing = []
        for port, input_hash in job.spec.input_hashes.items():
            path = self.resolve_artifact(job.project_id, input_hash)
            if path is None:
                missing.append(port)
            else:
                inputs[port] = path

        ctx = ExecutionContext(
            output_dir=self.output_dir_for(job.project_id),
            input_artifacts=inputs,
            report_progress=report,
        )
        try:
            if missing and job.spec.kind.value in ("clip", "timeline", "export"):
                raise RuntimeError(f"missing upstream artifacts on ports: {missing}")
            backend = self.backends.resolve(job.spec.kind)
            artifact = await backend.execute(job.spec, ctx)
            current = self.queue.get(job.id)
            if current is not None and current.status is JobStatus.CANCELLED:
                return
            job.status = JobStatus.DONE
            job.progress = 1.0
            job.artifact = str(artifact)
            job.finished_at = time.time()
            self.queue.update(job)
            self.events.publish(
                "job.done", job_id=job.id, node_id=job.spec.node_id, artifact=str(artifact)
            )
            if self.on_job_done is not None:
                await self.on_job_done(job)
        except OOMError as exc:
            await self._handle_oom(job, exc)
        except Exception as exc:  # noqa: BLE001 — job isolation boundary
            logger.exception("job %s failed", job.id)
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.finished_at = time.time()
            self.queue.update(job)
            self.events.publish(
                "job.failed", job_id=job.id, node_id=job.spec.node_id, error=str(exc)
            )

    async def _handle_oom(self, job: Job, exc: OOMError) -> None:
        if job.attempt < len(FALLBACK_LADDER):
            rung = FALLBACK_LADDER[job.attempt]
            job.attempt += 1
            job.spec.params = {**job.spec.params, **rung}
            job.status = JobStatus.QUEUED
            job.progress = 0.0
            self.queue.update(job)
            self.events.publish(
                "job.retrying",
                job_id=job.id,
                node_id=job.spec.node_id,
                attempt=job.attempt,
                fallback=rung,
            )
            self.notify()
            return
        job.status = JobStatus.FAILED
        job.error = f"out of memory after {job.attempt} fallback attempts: {exc}"
        job.finished_at = time.time()
        self.queue.update(job)
        # The UI renders this as choices, not an error code.
        self.events.publish(
            "job.failed",
            job_id=job.id,
            node_id=job.spec.node_id,
            error=job.error,
            suggestions=["lower_resolution", "smaller_model", "cloud"],
        )
