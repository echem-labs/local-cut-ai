"""ProjectService — the orchestration layer tying store, compiler, queue
and scheduler together. Owns the two-stage flow: the script job runs
first; when its screenplay lands, the graph is expanded per scene and the
rest of the pipeline is enqueued.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .events import EventBus
from .graph.compiler import compile_graph
from .graph.model import NodeKind, StoryGraph, scene_sort_key
from .graph.patch import PatchOp, apply_patch
from .graph.templates import expand_screenplay, prompt_template_graph
from .jobs.models import Job, JobStatus
from .jobs.queue import JobQueue
from .jobs.scheduler import Scheduler
from .project.store import Project, ProjectStore
from .schema import Screenplay

logger = logging.getLogger(__name__)


class ProjectService:
    def __init__(self, store: ProjectStore, queue: JobQueue, events: EventBus) -> None:
        self.store = store
        self.queue = queue
        self.events = events
        self.scheduler: Scheduler | None = None  # attached by the app factory

    # -- creation ----------------------------------------------------------

    def create_from_prompt(
        self,
        prompt: str,
        *,
        target_duration_s: int = 60,
        aspect: str = "9:16",
        style_preset: str = "cinematic",
    ) -> Project:
        graph = prompt_template_graph(
            prompt,
            target_duration_s=target_duration_s,
            aspect=aspect,
            style_preset=style_preset,
        )
        project = self.store.create(title=prompt, graph=graph)
        self._enqueue_dirty(project.id, graph)
        return project

    # -- editing -----------------------------------------------------------

    def patch(self, project_id: str, ops: list[PatchOp]) -> set[str]:
        graph = self.store.load_graph(project_id)
        dirty = apply_patch(graph, ops)
        self.store.save_graph(project_id, graph)
        if dirty:
            self._enqueue_dirty(project_id, graph)
        return dirty

    def regenerate(self, project_id: str, node_id: str, seed: int | None = None) -> None:
        graph = self.store.load_graph(project_id)
        node = graph.nodes[node_id]
        node.seed = seed if seed is not None else node.seed + 1
        self.store.save_graph(project_id, graph)
        self._enqueue_dirty(project_id, graph)

    def finalize(self, project_id: str) -> int:
        """Draft → final ladder: re-render at target quality."""
        graph = self.store.load_graph(project_id)
        return self._enqueue_dirty(project_id, graph, quality="final")

    # -- compile & enqueue ---------------------------------------------------

    def _frozen_pins(
        self, project_id: str, graph: StoryGraph, jobs: list[Job]
    ) -> dict[str, str]:
        """Pinned node id → output hash of its newest completed artifact.
        Derived from job history (persistent), so pins survive restarts and
        upstream edits alike. `jobs` is the caller's newest-first job list —
        listed once and shared to avoid re-reading the queue."""
        frozen: dict[str, str] = {}
        for job in jobs:  # newest first
            node = graph.nodes.get(job.spec.node_id)
            if (
                node is not None
                and node.pinned
                and job.spec.node_id not in frozen
                and job.status is JobStatus.DONE
                and job.artifact
                and self.store.resolve_artifact(project_id, job.spec.output_hash) is not None
            ):
                frozen[job.spec.node_id] = job.spec.output_hash
        return frozen

    def _enqueue_dirty(self, project_id: str, graph: StoryGraph, quality: str = "draft") -> int:
        cached = self.store.cached_hashes(project_id)
        history = self.queue.list(project_id, 1000)
        frozen = self._frozen_pins(project_id, graph, history)
        if quality == "final":
            # Finals re-render generation nodes even when a draft is cached;
            # quality is part of the job, not the node hash, so drop cached
            # entries for clip-class nodes (pinned/frozen ones stay).
            memo: dict[str, str] = dict(frozen)
            clip_hashes = {
                graph.output_hash(n, memo)
                for n, node in graph.nodes.items()
                if node.kind in (NodeKind.CLIP, NodeKind.TIMELINE, NodeKind.EXPORT)
                and not node.pinned
            }
            cached -= clip_hashes
        plan = compile_graph(graph, cached, quality=quality, frozen=frozen)

        # Skip nodes that already have an identical job in flight.
        active_hashes = {
            job.spec.output_hash
            for job in history
            if job.status in (JobStatus.QUEUED, JobStatus.RENDERING)
        }
        enqueued = 0
        for spec in plan.jobs:
            if spec.output_hash in active_hashes:
                continue
            self.queue.put(Job(project_id=project_id, spec=spec))
            enqueued += 1
        if enqueued and self.scheduler is not None:
            self.scheduler.notify()
        self.events.publish("project.compiled", project_id=project_id, enqueued=enqueued)
        return enqueued

    # -- scheduler hook ------------------------------------------------------

    async def on_job_done(self, job: Job) -> None:
        if job.spec.kind is not NodeKind.SCRIPT or job.artifact is None:
            return
        graph = self.store.load_graph(job.project_id)
        if "timeline" in graph.nodes:
            return  # already expanded (script re-runs patch scenes separately, v2)
        screenplay = Screenplay.model_validate_json(Path(job.artifact).read_text())
        expand_screenplay(graph, screenplay)
        self.store.save_graph(job.project_id, graph)
        self.events.publish(
            "project.expanded",
            project_id=job.project_id,
            scenes=[s.id for s in screenplay.scenes],
        )
        self._enqueue_dirty(job.project_id, graph)

    # -- read model for the UI ------------------------------------------------

    def scene_board(self, project_id: str) -> dict:
        """Scene cards + statuses, derived from graph × jobs × artifacts."""
        graph = self.store.load_graph(project_id)
        history = self.queue.list(project_id, 1000)
        jobs = {job.spec.node_id: job for job in reversed(history)}
        cached = self.store.cached_hashes(project_id)
        # Frozen pins hash against their existing artifact (see compiler).
        memo: dict[str, str] = dict(self._frozen_pins(project_id, graph, history))

        def node_state(node_id: str) -> dict | None:
            node = graph.nodes.get(node_id)
            if node is None:
                return None  # removed via patch — the card shows what's left
            job = jobs.get(node_id)
            out_hash = graph.output_hash(node_id, memo)
            if node.pinned:
                status = "pinned"
            elif out_hash in cached:
                status = "final" if (job and job.spec.quality == "final") else "draft"
            elif job and job.status is JobStatus.RENDERING:
                status = "rendering"
            elif job and job.status is JobStatus.FAILED:
                status = "failed"
            else:
                status = "queued"
            return {
                "node_id": node_id,
                "status": status,
                "progress": job.progress if job else 0.0,
                "error": job.error if job else None,
                "artifact_hash": out_hash if out_hash in cached else None,
                "params": node.params,
                "seed": node.seed,
            }

        scenes = []
        raw_ids = {n.split(".")[0] for n in graph.nodes if "." in n and n.endswith(".clip")}
        scene_ids = sorted(raw_ids, key=scene_sort_key)
        for sid in scene_ids:
            scenes.append(
                {
                    "scene_id": sid,
                    "keyframe": node_state(f"{sid}.keyframe"),
                    "clip": node_state(f"{sid}.clip"),
                    "narration": node_state(f"{sid}.narration"),
                }
            )
        aux = {
            n: state
            for n in ("script", "music", "captions", "timeline", "export")
            if (state := node_state(n)) is not None
        }
        return {"scenes": scenes, "aux": aux}
