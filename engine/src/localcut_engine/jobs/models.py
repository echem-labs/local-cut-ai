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
    # Starts of the engine that found this job still `rendering` with no stop
    # on record: the engine crashed, was killed or lost power partway through
    # it. JobQueue fails the job when this reaches CRASH_LIMIT rather than
    # claim a render that takes the engine down every time it runs.
    crashes: int = 0
    # Set while the job renders once the engine has begun a stop it was asked
    # for (POST /shutdown, SIGTERM, Ctrl+C). A start that finds the job still
    # `rendering` with this set knows it was stopped, not crashed. It
    # requeues the job without counting. Meaningful only on a `rendering`
    # row; claiming clears it.
    engine_stopping: bool = False
    error: str | None = None
    # Non-fatal signals from a job that finished — `error` means it did not.
    # Stored with the payload (no migration) and surfaced on the scene board.
    notices: list[Notice] = []
    # The optional input ports (graph.model.OPTIONAL_PORTS) whose artifact
    # did not exist when this job rendered, so its output was built without
    # them: a cut with no music bed, an export with no burned captions. The
    # input finishing later heals exactly these consumers. Set when the job
    # renders. None on a row that does not say, which the heal reads as
    # built without.
    absent_inputs: list[str] | None = None
    # Path of the produced artifact, RELATIVE to the project's generated/
    # dir. Never absolute: the data dir moves, apps get reinstalled under
    # another account, and backups get restored onto other machines — an
    # absolute path survives none of that, while the artifact itself (named
    # by its hash) survives all of it. Resolve through
    # ProjectStore.resolve_job_artifact, never by Path(job.artifact).
    artifact: str | None = None
    backend: str | None = None  # which backend rendered it — cache trust boundary
    # The model the backend reported using (ctx.record_model). Display-grade
    # provenance, not a trust boundary like `backend`: None when the backend
    # has no meaningful model name (ffmpeg assembly, mock).
    model: str | None = None
    created_at: float = Field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
