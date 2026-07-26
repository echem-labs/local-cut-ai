"""Duplicating a project must not launder untrusted artifacts.

`generated/` travels with the copy — artifacts are content-addressed, so they
stay valid — but job history lives in sqlite keyed by project id and does NOT.
That asymmetry is the whole problem: `_distrusted_hashes` works from history,
so in the copy it has nothing to work from and every placeholder comes back
trusted. A project rendered by the mock backend then duplicates into one whose
placeholders are served as the real cut by export, OTIO/FCPXML handoff and
package — which is precisely what the trusted-cache machinery exists to stop.
"""

from __future__ import annotations

from localcut_engine.backends.base import BackendRegistry, ExecutionBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.compiler import JobSpec
from localcut_engine.graph.model import Node, NodeKind, StoryGraph
from localcut_engine.jobs.models import Job, JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService

REAL = "real-backend"
MOCK = "mock"


class _Real(ExecutionBackend):
    """What would render a SCRIPT node today."""

    name = REAL

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.SCRIPT

    async def execute(self, spec, ctx):  # pragma: no cover - never run
        raise NotImplementedError


def _rig(tmp_path) -> tuple[ProjectService, ProjectStore, JobQueue]:
    registry = BackendRegistry()
    registry.register(_Real())
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    return ProjectService(store, queue, EventBus(), backends=registry), store, queue


def _seed(store: ProjectStore, title: str = "source"):
    graph = StoryGraph()
    graph.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "p"}))
    return store.create(title=title, graph=graph)


def _artifact(store: ProjectStore, project_id: str, out_hash: str) -> None:
    generated = store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{out_hash}.script.json").write_text("{}", encoding="utf-8")


def _record(queue: JobQueue, project_id: str, out_hash: str, backend: str) -> None:
    job = Job(
        project_id=project_id,
        spec=JobSpec(
            node_id="script",
            kind=NodeKind.SCRIPT,
            output_hash=out_hash,
            params={},
            model=None,
            seed=0,
            input_hashes={},
        ),
    )
    queue.put(job)
    # put() writes the row as QUEUED; the DONE state and the backend that
    # produced it are what `_distrusted_hashes` reads.
    job.status = JobStatus.DONE
    job.backend = backend
    queue.update(job)


def test_a_mock_artifact_does_not_survive_duplication(tmp_path):
    """The defect: the copy had no history, so the placeholder read as
    trusted and would be handed to an NLE as the finished cut."""
    service, store, queue = _rig(tmp_path)
    project = _seed(store)
    out_hash = "a" * 64
    _artifact(store, project.id, out_hash)
    _record(queue, project.id, out_hash, MOCK)

    # Distrusted in the source, because `mock` is not what renders SCRIPT now.
    assert out_hash in service._distrusted_hashes(
        queue.list(project.id, 100), store.cached_hashes(project.id)
    )

    copy = service.duplicate(project.id)

    assert out_hash not in store.cached_hashes(copy.id), (
        "the mock artifact travelled into the copy, where no history marks it untrusted"
    )
    # The source keeps its own copy — duplication must never mutate the
    # original, and the artifact is still legitimately viewable there.
    assert out_hash in store.cached_hashes(project.id)


def test_a_trusted_artifact_still_travels(tmp_path):
    """The point of copying generated/ is that a finished project duplicates
    into a finished one. Dropping everything would make duplicate a re-render."""
    service, store, queue = _rig(tmp_path)
    project = _seed(store)
    out_hash = "b" * 64
    _artifact(store, project.id, out_hash)
    _record(queue, project.id, out_hash, REAL)

    copy = service.duplicate(project.id)

    assert out_hash in store.cached_hashes(copy.id)


def test_history_from_before_backend_tracking_stays_trusted(tmp_path):
    """A job row with no recorded backend predates tracking; treating that as
    untrusted would re-render every artifact in every older project once."""
    service, store, queue = _rig(tmp_path)
    project = _seed(store)
    out_hash = "c" * 64
    _artifact(store, project.id, out_hash)
    _record(queue, project.id, out_hash, None)

    copy = service.duplicate(project.id)

    assert out_hash in store.cached_hashes(copy.id)


def test_duplicating_without_a_backend_registry_keeps_everything(tmp_path):
    """`_distrusted_hashes` answers empty with no registry, so nothing is
    dropped — a headless/test configuration must not silently lose artifacts."""
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, EventBus())
    project = _seed(store)
    out_hash = "d" * 64
    _artifact(store, project.id, out_hash)
    _record(queue, project.id, out_hash, MOCK)

    copy = service.duplicate(project.id)

    assert out_hash in store.cached_hashes(copy.id)
