"""SQLite-persisted job queue — long overnight batches must survive app
restarts and driver hiccups. Jobs found `rendering` on startup
are requeued (the render was interrupted).
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .models import Job, JobStatus

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
                "SELECT payload FROM jobs WHERE status = ?", (JobStatus.RENDERING,)
            ).fetchall()
            for (payload,) in rows:
                job = Job.model_validate_json(payload)
                job.status = JobStatus.QUEUED
                job.progress = 0.0
                self._write(job)

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

    def next_queued(self) -> Job | None:
        with self._lock:
            row = self._db.execute(
                "SELECT payload FROM jobs WHERE status = ? ORDER BY created_at LIMIT 1",
                (JobStatus.QUEUED,),
            ).fetchone()
        return Job.model_validate_json(row[0]) if row else None

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

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status not in (JobStatus.QUEUED, JobStatus.RENDERING):
            return False
        job.status = JobStatus.CANCELLED
        self.update(job)
        return True

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._db.execute(
                "SELECT status, COUNT(*) FROM jobs GROUP BY status"
            ).fetchall()
        return {status: count for status, count in rows}

    def close(self) -> None:
        self._db.close()
