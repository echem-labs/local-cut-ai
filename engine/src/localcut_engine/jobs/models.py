"""Job records — every generation is a resumable job."""

from __future__ import annotations

import time
import uuid
from enum import StrEnum

from pydantic import BaseModel, Field

from ..graph.compiler import JobSpec
from ..notices import Notice

_JOB_ID_LEN = 12

# The API's path-param validation is built from this — the id generator and
# the route pattern must agree or every route 404s new jobs.
JOB_ID_PATTERN = rf"^[a-f0-9]{{{_JOB_ID_LEN}}}$"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RENDERING = "rendering"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Job(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:_JOB_ID_LEN])
    project_id: str
    spec: JobSpec
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0  # 0..1
    attempt: int = 0
    error: str | None = None
    # Non-fatal signals from a job that finished — `error` means it did not.
    # Stored with the payload (no migration) and surfaced on the scene board.
    notices: list[Notice] = []
    # Path of the produced artifact, RELATIVE to the project's generated/
    # dir. Never absolute: the data dir moves, apps get reinstalled under
    # another account, and backups get restored onto other machines — an
    # absolute path survives none of that, while the artifact itself (named
    # by its hash) survives all of it. Resolve through
    # ProjectStore.resolve_job_artifact, never by Path(job.artifact).
    artifact: str | None = None
    backend: str | None = None  # which backend rendered it — cache trust boundary
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
