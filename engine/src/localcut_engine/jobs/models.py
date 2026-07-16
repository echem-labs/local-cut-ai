"""Job records — every generation is a resumable job."""

from __future__ import annotations

import time
import uuid
from enum import StrEnum

from pydantic import BaseModel, Field

from ..graph.compiler import JobSpec


class JobStatus(StrEnum):
    QUEUED = "queued"
    RENDERING = "rendering"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Job(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    project_id: str
    spec: JobSpec
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0  # 0..1
    attempt: int = 0
    error: str | None = None
    artifact: str | None = None  # engine-relative path of the produced artifact
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
