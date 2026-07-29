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

# How long stop() lets the current job wind down before cancelling it, and
# how long the cancellation itself gets to unwind. Both are short: the shell
# force-kills the engine if quitting takes too long, and a force-kill is
# strictly worse than a cancel (nothing gets to clean up).
SHUTDOWN_GRACE_S = 3.0
CANCEL_GRACE_S = 5.0

ArtifactResolver = Callable[[str, str], Path | None]  # (project_id, output_hash) -> path
JobHook = Callable[[Job], Awaitable[None]]


def _relative_artifact(artifact: Path, output_dir: Path) -> str:
    """An artifact path as `Job.artifact` stores it: relative to the
    project's generated/ dir. Falls back to the absolute path for a backend
    that wrote outside it (none do today, but the record must stay usable)."""
    try:
        return artifact.relative_to(output_dir).as_posix()
    except ValueError:
        return str(artifact)


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

    async def stop(self, grace_s: float = SHUTDOWN_GRACE_S) -> None:
        """Stop the loop, cancelling an in-flight render if it does not wind
        down within `grace_s`.

        Awaiting the task unconditionally means quitting during a render
        blocks for the length of that render — up to ComfyUI's 600s
        inactivity window for a wedged workflow. The shell then force-kills
        the engine, which skips this shutdown entirely: the DB row stays
        `rendering` until the next boot, and ffmpeg children survive as
        orphans writing into a workdir that has already been removed. So the
        cancel has to come from in here, where the backends can still clean
        up after themselves.
        """
        self._stopping = True
        self._wakeup.set()
        task = self._task
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=grace_s)
        except TimeoutError:
            logger.warning("scheduler did not stop in %.0fs; cancelling the running job", grace_s)
            task.cancel()
            # The job's own CancelledError handler marks the row and kills
            # its children; give it a bounded moment to do so.
            try:
                await asyncio.wait_for(task, timeout=CANCEL_GRACE_S)
            except (TimeoutError, asyncio.CancelledError):
                logger.warning("scheduler task did not unwind cleanly")
        except asyncio.CancelledError:
            task.cancel()
            raise

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
            # Clear BEFORE polling, never after. The poll below awaits, so an
            # enqueue can land while it is in flight; clearing afterwards
            # would wipe that notification and park the loop for the full
            # 30s timeout with work sitting in the queue.
            self._wakeup.clear()
            try:
                # Claim, don't peek: the row comes back already RENDERING, so
                # a second scheduler against the same db cannot pop it too.
                # Off the loop — every queue call takes a mutex that worker
                # threads also hold, and blocking the loop on it stalls the
                # /ws progress fan-out and every in-flight request.
                job = await asyncio.to_thread(self.queue.claim_next)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — a bad row must not kill the loop
                logger.exception("scheduler failed to read the queue; retrying")
                await asyncio.sleep(5.0)
                continue
            if job is None:
                try:
                    # Every in-process enqueue calls notify(); the timeout only
                    # covers out-of-process writers sharing the queue db.
                    await asyncio.wait_for(self._wakeup.wait(), timeout=30.0)
                except TimeoutError:
                    pass
                continue
            try:
                await self._execute(job)
            except asyncio.CancelledError:
                # Shutdown (or a stuck-job cancel) landed mid-render. Put the
                # job back so the next boot re-renders it, rather than leaving
                # a RENDERING row that only _recover_interrupted will ever
                # notice — and re-raise, because a cancelled task must die.
                logger.info("scheduler cancelled while running job %s; requeueing", job.id)
                await asyncio.shield(asyncio.to_thread(self._requeue_quietly, job))
                raise
            except Exception:  # noqa: BLE001 — one job must never kill the loop
                # _execute does pre-`try` work (publish job.started); if that
                # raises (e.g. the queue db is locked) the exception would
                # otherwise escape _run and stop the scheduler forever,
                # wedging every later job as QUEUED.
                logger.exception("scheduler crashed handling job %s", job.id)
                if not await asyncio.to_thread(self._fail_quietly, job):
                    # Couldn't even persist the failure — back off so we don't
                    # hot-loop the same still-QUEUED row against a locked db.
                    await asyncio.sleep(1.0)

    async def _execute(self, job: Job) -> None:
        # claim_next already persisted RENDERING/started_at; this only adds
        # the resolved backend name (the cache-trust boundary).
        try:
            job.backend = self.backends.resolve(job.spec.kind, job.spec.model).name
        except GenerationError:
            job.backend = None  # the resolve below fails the job properly
        if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
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
                # On a thread: this runs from inside backend.execute, i.e. on
                # the event loop, and the write takes a mutex that the worker
                # threads hold across a transaction.
                if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
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
                # Assembly-family inputs are hard requirements — but only
                # fatally missing when nothing in flight can still produce
                # them. An ordering hiccup must not fail minutes of good
                # downstream work: requeue behind the producer instead. The
                # serial loop guarantees progress — when this job popped,
                # nothing was rendering, so the producer is QUEUED and pops
                # next.
                missing_hashes = {job.spec.input_hashes[port] for port in missing}
                producing = {
                    other.spec.output_hash
                    for other in await asyncio.to_thread(self.queue.active, job.project_id)
                    if other.id != job.id
                }
                if missing_hashes & producing:
                    job.status = JobStatus.QUEUED
                    job.progress = 0.0
                    job.started_at = None
                    job.created_at = time.time()  # back of the FIFO
                    await asyncio.to_thread(self.queue.update_unless_cancelled, job)
                    return
                raise RuntimeError(f"missing upstream artifacts on ports: {missing}")
            backend = self.backends.resolve(job.spec.kind, job.spec.model)
            artifact = await backend.execute(job.spec, ctx)
            job.status = JobStatus.DONE
            job.progress = 1.0
            # Only a finished job keeps its notices: on a failed attempt the
            # error dominates, and the retry re-emits its own.
            job.notices = ctx.notices
            # Same trip for the model the backend reported actually using.
            job.model = ctx.model_used
            # Stored RELATIVE to the project's generated/ dir, as the field
            # has always been documented. An absolute path breaks the moment
            # the data dir moves, the app is reinstalled under another
            # account, or a backup is restored onto a new machine: the
            # artifact is still there under its hash, but the recorded path
            # is not, so tool promotion reports "the script has not finished
            # generating yet" forever. The EDL builder relativises for the
            # same reason.
            job.artifact = _relative_artifact(artifact, ctx.output_dir)
            job.finished_at = time.time()
            # Settle BEFORE the DONE row, not after. "Nothing queued or
            # rendering" is what a caller reads as a finished render —
            # wait_for_render returns on it and `render` exits 0 — so work
            # that this completion goes on to enqueue has to be on the queue
            # before the job stops counting as outstanding. With the DONE
            # write first, the script node's expansion (a graph load, a save
            # with fsync, then the enqueue) left the queue momentarily empty
            # and a poll landing there reported success over scenes that had
            # not been enqueued yet.
            await self._settle(job)
            if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
                return  # user cancelled during the render — honor it, skip DONE
            self.events.publish(
                "job.done",
                job_id=job.id,
                node_id=job.spec.node_id,
                artifact=job.artifact,
                project_id=job.project_id,
            )
        except (OOMError, asyncio.CancelledError) as exc:
            if isinstance(exc, asyncio.CancelledError):
                raise  # _run requeues and re-raises; never record it as failed
            await self._handle_oom(job, exc)
            return
        except Exception as exc:  # noqa: BLE001 — job isolation boundary
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.finished_at = time.time()
            if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
                # The user's cancel outranks whatever the render died of — bail
                # before logging so an intentional cancel isn't recorded as a
                # spurious ERROR with a traceback (still inside the except, so
                # the log below keeps its traceback for real failures).
                return
            logger.exception("job %s failed", job.id)
            self.events.publish(
                "job.failed",
                job_id=job.id,
                node_id=job.spec.node_id,
                error=str(exc),
                project_id=job.project_id,
            )
            return

    async def _settle(self, job: Job) -> None:
        """Record what this job's completion implies — for the script node,
        expanding the screenplay and enqueueing the scene work it plans.

        Swallows its own failures rather than raising. It runs inside the
        job's `try`, and a follow-up error (a screenplay that will not expand)
        must not flip a job that really did render into FAILED.

        The cancel check is a plain read, not the atomic one the DONE write
        makes: a cancel landing *during* the hook still gets its side effects.
        That is a far narrower window than skipping the check entirely, which
        would expand and enqueue a whole pipeline for a job the user had
        already cancelled. Project deletion needs no check here — the hook
        bails on a project that is gone.
        """
        if self.on_job_done is None:
            return
        if await asyncio.to_thread(self.queue.status_of, job.id) == JobStatus.CANCELLED.value:
            return
        try:
            await self.on_job_done(job)
        except asyncio.CancelledError:
            raise  # shutdown — _run requeues the job; never a job failure
        except Exception as exc:  # noqa: BLE001
            logger.exception("post-completion hook failed for job %s", job.id)
            self.events.publish(
                "project.error",
                project_id=job.project_id,
                node_id=job.spec.node_id,
                error=str(exc),
            )

    def _requeue_quietly(self, job: Job) -> None:
        """Put a cancelled-by-shutdown job back on the queue. Best effort: a
        failure here just leaves the row RENDERING, which _recover_interrupted
        fixes on the next boot — the same place it would have ended up before
        shutdown cancelled anything."""
        try:
            job.status = JobStatus.QUEUED
            job.progress = 0.0
            job.started_at = None
            self.queue.update_unless_cancelled(job)
        except Exception:  # noqa: BLE001
            logger.exception("could not requeue job %s during shutdown", job.id)

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
            if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
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
        if not await asyncio.to_thread(self.queue.update_unless_cancelled, job):
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
