"""SQLite-persisted job queue — long overnight batches must survive app
restarts and driver hiccups. Jobs found `rendering` on startup
are requeued (the render was interrupted).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path

from pydantic import ValidationError

from .models import Job, JobStatus

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
"""


class JobQueue:
    def __init__(self, db_path: Path | str) -> None:
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.executescript(_SCHEMA)
        self._lock = threading.Lock()
        self._recover_interrupted()

    def _recover_interrupted(self) -> None:
        with self._lock, self._db:
            rows = self._db.execute(
                "SELECT id, payload FROM jobs WHERE status = ?", (JobStatus.RENDERING,)
            ).fetchall()
            for job_id, payload in rows:
                try:
                    job = Job.model_validate_json(payload)
                except ValidationError:
                    self._poison(job_id)
                    continue
                job.status = JobStatus.QUEUED
                job.progress = 0.0
                self._write(job)

    def _poison(self, job_id: str) -> None:
        """A payload this build can't parse (schema skew, disk damage) must
        fail visibly instead of wedging the queue."""
        logger.error("job %s has an unreadable payload; marking failed", job_id)
        self._db.execute("UPDATE jobs SET status = ? WHERE id = ?", (JobStatus.FAILED, job_id))

    def _write(self, job: Job) -> None:
        self._db.execute(
            "INSERT INTO jobs(id, project_id, status, created_at, payload) VALUES(?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload",
            (job.id, job.project_id, job.status, job.created_at, job.model_dump_json()),
        )

    def put(self, job: Job) -> Job:
        with self._lock, self._db:
            self._write(job)
        return job

    def update(self, job: Job) -> None:
        self.put(job)

    def update_unless_cancelled(self, job: Job) -> bool:
        """Persist `job` unless a cancel has already won its row. The status
        read and the write happen under a single lock hold, so this is atomic
        against a cancel written from another thread — project deletion cancels
        jobs via a worker thread (asyncio.to_thread), so the scheduler cannot
        assume cancels only arrive on its own loop. Returns False when the row
        is already CANCELLED; the caller must then treat the job as cancelled
        and never resurrect it to rendering/done/failed."""
        with self._lock, self._db:
            row = self._db.execute("SELECT status FROM jobs WHERE id = ?", (job.id,)).fetchone()
            if row is not None and row[0] == JobStatus.CANCELLED:
                return False
            self._write(job)
            return True

    def next_queued(self) -> Job | None:
        while True:
            with self._lock:
                row = self._db.execute(
                    "SELECT id, payload FROM jobs WHERE status = ? ORDER BY created_at LIMIT 1",
                    (JobStatus.QUEUED,),
                ).fetchone()
            if row is None:
                return None
            try:
                return Job.model_validate_json(row[1])
            except ValidationError:
                with self._lock, self._db:
                    self._poison(row[0])

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._db.execute("SELECT payload FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return Job.model_validate_json(row[0]) if row else None

    def list(self, project_id: str | None = None, limit: int = 200) -> list[Job]:
        query = "SELECT payload FROM jobs"
        params: tuple = ()
        if project_id:
            query += " WHERE project_id = ?"
            params = (project_id,)
        query += " ORDER BY created_at DESC LIMIT ?"
        with self._lock:
            rows = self._db.execute(query, (*params, limit)).fetchall()
        return [Job.model_validate_json(r[0]) for r in rows]

    def active(self, project_id: str) -> list[Job]:
        """Queued/rendering jobs only — indexed, so callers that just need
        the in-flight set skip hydrating the whole history."""
        with self._lock:
            rows = self._db.execute(
                "SELECT payload FROM jobs WHERE project_id = ? AND status IN (?, ?)",
                (project_id, JobStatus.QUEUED, JobStatus.RENDERING),
            ).fetchall()
        return [Job.model_validate_json(r[0]) for r in rows]

    def cancel(self, job_id: str) -> bool:
        # Read-modify-write under a single lock hold so the CANCELLED write is
        # atomic against a concurrent scheduler persist (update_unless_cancelled
        # reads status under the same lock): the job ends up either DONE (it
        # finished first) or CANCELLED — never resurrected, in either order.
        with self._lock, self._db:
            row = self._db.execute("SELECT payload FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                return False
            job = Job.model_validate_json(row[0])
            if job.status not in (JobStatus.QUEUED, JobStatus.RENDERING):
                return False
            job.status = JobStatus.CANCELLED
            self._write(job)
            return True

    def cancel_project(self, project_id: str) -> int:
        """Cancel every in-flight job of a project (project deletion). Reads and
        writes each row under one lock hold — the previous active()-then-update()
        split let a scheduler persist land between the read and the CANCELLED
        write, resurrecting a job the deletion meant to stop."""
        with self._lock, self._db:
            rows = self._db.execute(
                "SELECT payload FROM jobs WHERE project_id = ? AND status IN (?, ?)",
                (project_id, JobStatus.QUEUED, JobStatus.RENDERING),
            ).fetchall()
            for (payload,) in rows:
                job = Job.model_validate_json(payload)
                job.status = JobStatus.CANCELLED
                self._write(job)
            return len(rows)

    def close(self) -> None:
        self._db.close()
