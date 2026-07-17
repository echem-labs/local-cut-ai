"""Job records — every generation is a resumable job."""

from __future__ import annotations

import time
import uuid
from enum import StrEnum

from pydantic import BaseModel, Field

from ..graph.compiler import JobSpec

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
    artifact: str | None = None  # engine-relative path of the produced artifact
    backend: str | None = None  # which backend rendered it — cache trust boundary
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
