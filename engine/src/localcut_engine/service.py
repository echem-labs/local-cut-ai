"""ProjectService — the orchestration layer tying store, compiler, queue
and scheduler together. Owns the two-stage flow: the script job runs
first; when its screenplay lands, the graph is expanded per scene and the
rest of the pipeline is enqueued.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
from pathlib import Path

from .backends.base import BackendRegistry, GenerationError
from .events import EventBus
from .graph.compiler import QUALITY_SENSITIVE_KINDS, compile_graph
from .graph.editor import EditPlan, compile_edits, graph_view
from .graph.model import OPTIONAL_PORTS, Node, NodeKind, StoryGraph, scene_sort_key
from .graph.patch import PatchOp, apply_patch
from .graph.templates import expand_screenplay, prompt_template_graph, tool_graph
from .jobs.models import Job, JobStatus
from .jobs.queue import JobQueue
from .jobs.scheduler import Scheduler
from .otio import edl_to_otio
from .project.store import Project, ProjectStore
from .schema import Screenplay

logger = logging.getLogger(__name__)


class ProjectService:
    def __init__(
        self,
        store: ProjectStore,
        queue: JobQueue,
        events: EventBus,
        backends: BackendRegistry | None = None,
    ) -> None:
        self.store = store
        self.queue = queue
        self.events = events
        self.backends = backends  # cache trust: who renders which kind now
        self.scheduler: Scheduler | None = None  # attached by the app factory
        # Handlers run off the event loop; graph read-modify-write cycles
        # must not interleave.
        self._lock = threading.Lock()

    # -- creation ----------------------------------------------------------

    def create_from_prompt(
        self,
        prompt: str,
        *,
        target_duration_s: int = 60,
        aspect: str = "9:16",
        style_preset: str = "cinematic",
        mode: str = "prompt",
    ) -> Project:
        graph = prompt_template_graph(
            prompt,
            target_duration_s=target_duration_s,
            aspect=aspect,
            style_preset=style_preset,
        )
        with self._lock:
            project = self.store.create(title=prompt, graph=graph, mode=mode)
            self._enqueue_dirty(project.id, graph)
        return project

    def create_tool(self, tool: str, params: dict) -> Project:
        """Quick Tool session: a one-node micro-project (doc: single artifact,
        direct export, optional promote into a full project)."""
        graph = tool_graph(tool, params)
        title = str(params.get("prompt") or params.get("text") or tool)
        with self._lock:
            project = self.store.create(title=title, graph=graph, mode=f"tool:{tool}")
            self._enqueue_dirty(project.id, graph)
        return project

    def promote_tool(self, project_id: str) -> Project:
        """Script tool session → full prompt-mode project seeded with the
        already-generated screenplay (the script node arrives pre-cached, so
        promotion costs zero LLM work)."""
        with self._lock:
            meta = self.store.get(project_id)
            if meta is None or meta.mode != "tool:script":
                raise ValueError("only script tool sessions can be promoted")
            graph = self.store.load_graph(project_id)
            script = graph.nodes.get("script")
            if script is None or script.kind is not NodeKind.SCRIPT:
                raise ValueError("only script tool sessions can be promoted")
            # Only the artifact matching the node's CURRENT identity counts:
            # after a regenerate (seed bump) the older screenplay must not be
            # promoted as if it were the new seed's output.
            current_hash = graph.output_hash("script")
            job = next(
                (
                    j
                    for j in self.queue.list(project_id, 1000)
                    if j.spec.node_id == "script"
                    and j.spec.output_hash == current_hash
                    and j.status is JobStatus.DONE
                    and j.artifact
                    and Path(j.artifact).exists()
                ),
                None,
            )
            if job is None:
                raise ValueError("the script has not finished generating yet")
            screenplay = Screenplay.model_validate_json(Path(job.artifact).read_text())

            params = script.params
            new_graph = prompt_template_graph(
                str(params.get("prompt", "")),
                target_duration_s=int(params.get("target_duration_s", 60)),
                aspect=str(params.get("aspect", "9:16")),
                style_preset=str(params.get("style_preset", "cinematic")),
            )
            new_graph.nodes["script"].seed = script.seed
            expand_screenplay(new_graph, screenplay)
            project = self.store.create(
                title=screenplay.title or str(params.get("prompt", "")), graph=new_graph
            )
            # Seed the artifact under the new script node's hash: cached, so
            # the pipeline starts at keyframes instead of re-running the LLM.
            out_hash = new_graph.output_hash("script", {})
            dest = self.store.generated_dir(project.id)
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(job.artifact, dest / f"{out_hash}.screenplay.json")
            self._enqueue_dirty(project.id, new_graph)
        return project

    def approve(self, project_id: str, checkpoint: str) -> int:
        """Beginner-mode gates: passing a checkpoint releases the next stage
        of jobs (script → storyboard review → full render)."""
        if checkpoint not in ("script", "storyboard"):
            raise ValueError(f"unknown checkpoint: {checkpoint!r}")
        with self._lock:
            project = self.store.get(project_id)
            if project is None:
                raise KeyError(project_id)
            if checkpoint not in project.approvals:
                project.approvals.append(checkpoint)
                self.store.save_meta(project)
            self.events.publish("project.approved", project_id=project_id, checkpoint=checkpoint)
            return self._enqueue_dirty(project_id, self.store.load_graph(project_id))

    # -- editing -----------------------------------------------------------

    def patch(self, project_id: str, ops: list[PatchOp]) -> set[str]:
        with self._lock:
            graph = self.store.load_graph(project_id)
            dirty = apply_patch(graph, ops)
            self.store.save_graph(project_id, graph)
            if dirty:
                self._enqueue_dirty(project_id, graph)
        return dirty

    def add_asset(self, project_id: str, filename: str, data: bytes) -> dict:
        """Import a user asset as a graph node. The file lands in generated/
        under the node's output hash, so the node is born cached: assets are
        never executed, only consumed (e.g. wired into a clip's keyframe
        port as the I2V source)."""
        import hashlib

        suffix = Path(filename).suffix.lower()
        sha = hashlib.sha256(data).hexdigest()
        node_id = f"asset-{sha[:12]}"
        with self._lock:
            graph = self.store.load_graph(project_id)
            if node_id not in graph.nodes:
                graph.add_node(
                    Node(
                        id=node_id,
                        kind=NodeKind.ASSET,
                        params={"name": filename, "sha256": sha},
                    )
                )
                self.store.save_graph(project_id, graph)
            out_hash = graph.output_hash(node_id)
            dest = self.store.generated_dir(project_id)
            dest.mkdir(parents=True, exist_ok=True)
            path = dest / f"{out_hash}{suffix}"
            if not path.exists():
                path.write_bytes(data)
        self.events.publish("project.asset", project_id=project_id, node_id=node_id)
        return {"node_id": node_id, "hash": out_hash, "name": filename}

    def edit_view(self, project_id: str, scope: str) -> dict:
        """The whitelisted graph view a natural-language edit works from."""
        with self._lock:
            return graph_view(self.store.load_graph(project_id), scope)

    def apply_edit_plan(self, project_id: str, plan: EditPlan, scope: str) -> dict:
        """Compile an LLM edit plan against the live graph and apply it.
        Validation and apply share one lock hold, so the plan can't be
        checked against one graph state and applied to another."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            ops, warnings = compile_edits(graph, plan, scope)
            dirty = apply_patch(graph, ops) if ops else set()
            if ops:
                self.store.save_graph(project_id, graph)
            if dirty:
                self._enqueue_dirty(project_id, graph)
        self.events.publish(
            "project.edited", project_id=project_id, ops=len(ops), summary=plan.summary
        )
        return {"ops": len(ops), "dirty": sorted(dirty), "warnings": warnings}

    def regenerate(self, project_id: str, node_id: str, seed: int | None = None) -> None:
        with self._lock:
            graph = self.store.load_graph(project_id)
            node = graph.nodes[node_id]
            node.seed = seed if seed is not None else node.seed + 1
            self.store.save_graph(project_id, graph)
            self._enqueue_dirty(project_id, graph)

    def finalize(self, project_id: str, clip_model: str | None = None) -> int:
        """Draft → final ladder: re-render at target quality. When a final
        clip model is configured (e.g. Wan 2.2 on 16 GB tiers), unpinned
        clips switch to it — the ladder upgrades the model, not just steps."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            if clip_model:
                changed = False
                for node in graph.nodes.values():
                    if node.kind is NodeKind.CLIP and not node.pinned and node.model != clip_model:
                        node.model = clip_model
                        changed = True
                if changed:
                    self.store.save_graph(project_id, graph)
            return self._enqueue_dirty(project_id, graph, quality="final")

    def delete(self, project_id: str) -> bool:
        """Remove the project and stop its in-flight work — otherwise the
        scheduler keeps rendering into (and recreating) the deleted dir."""
        with self._lock:
            self.queue.cancel_project(project_id)
            return self.store.delete(project_id)

    def package(self, project_id: str) -> list[str]:
        """On-demand publish kit: a thumbnail conditioned on the screenplay
        plus LLM title/description/hashtags. Both join the graph as nodes —
        cached, regenerable, served through the normal artifact routes —
        rather than running as a side channel."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            script = graph.nodes.get("script")
            if script is None or script.kind is not NodeKind.SCRIPT:
                raise LookupError("project has no script to package from")
            history = self.queue.list(project_id, 1000)
            cached = self.store.cached_hashes(project_id)
            memo = dict(self._frozen_pins(graph, history, cached))
            script_artifact = self.store.resolve_artifact(
                project_id, graph.output_hash("script", memo)
            )
            if script_artifact is None:
                raise LookupError("script has not rendered yet")
            screenplay = Screenplay.model_validate_json(script_artifact.read_text())

            summary = " ".join(
                [screenplay.title, screenplay.hook] + [s.narration for s in screenplay.scenes]
            ).strip()[:2000]
            hero = screenplay.scenes[0] if screenplay.scenes else None
            thumb_prompt = ", ".join(
                part
                for part in (
                    hero.visual if hero else screenplay.title,
                    screenplay.style.visual,
                    "bold, high contrast, title-safe thumbnail composition",
                )
                if part
            )
            for node_id, kind, params in (
                ("thumbnail", NodeKind.THUMBNAIL, {"prompt": thumb_prompt, "aspect": "16:9"}),
                ("metadata", NodeKind.SCRIPT, {"task": "metadata", "prompt": summary}),
            ):
                node = graph.nodes.get(node_id)
                if node is None:
                    graph.add_node(Node(id=node_id, kind=kind, params=params))
                else:
                    node.params = params  # re-package follows the current script
            self.store.save_graph(project_id, graph)
            self._enqueue_dirty(project_id, graph)
            return ["thumbnail", "metadata"]

    def export_otio(self, project_id: str) -> dict:
        """The current timeline as an OTIO document for pro-NLE handoff.
        Raises LookupError while the timeline hasn't rendered (or is stale
        for the current graph) and ValueError for non-exportable EDLs."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            if "timeline" not in graph.nodes:
                raise LookupError("project has no timeline")
            history = self.queue.list(project_id, 1000)
            cached = self.store.cached_hashes(project_id)
            memo = dict(self._frozen_pins(graph, history, cached))
            edl_path = self.store.resolve_artifact(project_id, graph.output_hash("timeline", memo))
            if edl_path is None:
                raise LookupError("timeline is not rendered for the current edit")
            project = self.store.get(project_id)
            edl = json.loads(edl_path.read_text())
        return edl_to_otio(
            edl,
            resolve=lambda src: p if (p := Path(src)).is_absolute() else edl_path.parent / p,
            name=project.title if project else project_id,
        )

    # -- compile & enqueue ---------------------------------------------------

    def _frozen_pins(self, graph: StoryGraph, jobs: list[Job], cached: set[str]) -> dict[str, str]:
        """Pinned node id → output hash of its frozen artifact. The hash
        snapshotted on the node at pin time is authoritative (it survives any
        amount of job history); pre-snapshot graphs fall back to the newest
        completed job. Either way the artifact must still exist."""
        frozen: dict[str, str] = {}
        for node_id, node in graph.nodes.items():
            if node.pinned and node.frozen_hash and node.frozen_hash in cached:
                frozen[node_id] = node.frozen_hash
        for job in jobs:  # newest first — legacy fallback
            node = graph.nodes.get(job.spec.node_id)
            if (
                node is not None
                and node.pinned
                and job.spec.node_id not in frozen
                and job.status is JobStatus.DONE
                and job.artifact
                and job.spec.output_hash in cached
            ):
                frozen[job.spec.node_id] = job.spec.output_hash
        return frozen

    def _distrusted_hashes(self, history: list[Job], cached: set[str]) -> set[str]:
        """Cached hashes whose newest producer is no longer the backend that
        would render that kind today (e.g. mock placeholders after switching
        to a real chain) must re-render, not get served as artifacts."""
        if self.backends is None:
            return set()
        distrusted: set[str] = set()
        seen: set[str] = set()
        for job in history:  # newest first wins per hash
            out_hash = job.spec.output_hash
            if job.status is not JobStatus.DONE or out_hash in seen:
                continue
            seen.add(out_hash)
            if job.backend is None or out_hash not in cached:
                continue  # pre-tracking history stays trusted
            try:
                # Model-aware: a cloud:* node resolves to the cloud backend,
                # so its artifacts stay trusted — distrusting them here would
                # re-enqueue (and re-bill) the same render forever.
                expected = self.backends.resolve(job.spec.kind, job.spec.model).name
            except GenerationError:
                continue
            if job.backend != expected:
                distrusted.add(out_hash)
        return distrusted

    def _enqueue_dirty(self, project_id: str, graph: StoryGraph, quality: str = "draft") -> int:
        cached = self.store.cached_hashes(project_id)
        history = self.queue.list(project_id, 1000)
        cached -= self._distrusted_hashes(history, cached)
        frozen = self._frozen_pins(graph, history, cached)
        if quality == "final":
            # Finals re-render generation nodes even when a draft is cached;
            # quality is part of the job, not the node hash, so drop cached
            # entries for quality-sensitive nodes (pinned/frozen ones stay).
            memo: dict[str, str] = dict(frozen)
            clip_hashes = {
                graph.output_hash(n, memo)
                for n, node in graph.nodes.items()
                if node.kind in QUALITY_SENSITIVE_KINDS and not node.pinned
            }
            cached -= clip_hashes
        plan = compile_graph(graph, cached, quality=quality, frozen=frozen)

        # Skip nodes that already have an identical job in flight — quality
        # included, so finalize still enqueues finals over active drafts.
        active = {(job.spec.output_hash, job.spec.quality) for job in self.queue.active(project_id)}
        project = self.store.get(project_id)
        enqueued = 0
        for spec in plan.jobs:
            if (spec.output_hash, spec.quality) in active:
                continue
            if not self._checkpoint_open(project, spec.kind):
                continue  # released later by POST .../approve
            self.queue.put(Job(project_id=project_id, spec=spec))
            enqueued += 1
        if enqueued and self.scheduler is not None:
            self.scheduler.notify()
        self.events.publish("project.compiled", project_id=project_id, enqueued=enqueued)
        return enqueued

    @staticmethod
    def _checkpoint_open(project: Project | None, kind: NodeKind) -> bool:
        """Beginner mode pauses at checkpoints: the script must be approved
        before storyboard work runs, and the storyboard before video/assembly
        compute is spent. Other modes auto-approve."""
        if project is None or project.mode != "beginner":
            return True
        if kind is NodeKind.SCRIPT:
            return True
        # Thumbnails derive from the approved script (packaging), not from
        # the storyboard — gating them there would silently drop an explicit
        # POST /package in beginner mode.
        if kind in (NodeKind.KEYFRAME, NodeKind.NARRATION, NodeKind.MUSIC, NodeKind.THUMBNAIL):
            return "script" in project.approvals
        return "storyboard" in project.approvals

    # -- scheduler hook ------------------------------------------------------

    async def on_job_done(self, job: Job) -> None:
        # Graph IO + recompiles are blocking; keep them off the event loop
        # that streams progress.
        await asyncio.to_thread(self._on_job_done_sync, job)

    def _on_job_done_sync(self, job: Job) -> None:
        # Only the project's script node expands — a "metadata" publish-kit
        # job is SCRIPT-kind too but must never re-shape the graph.
        if (
            job.spec.kind is NodeKind.SCRIPT
            and job.spec.node_id == "script"
            and job.artifact is not None
        ):
            meta = self.store.get(job.project_id)
            if meta is not None and meta.mode.startswith("tool:"):
                return  # tool sessions stay one node; promotion expands
            with self._lock:
                graph = self.store.load_graph(job.project_id)
                screenplay = Screenplay.model_validate_json(Path(job.artifact).read_text())
                # Idempotent: first run builds the subgraphs, re-runs patch
                # the new screenplay into the existing nodes.
                expand_screenplay(graph, screenplay)
                self.store.save_graph(job.project_id, graph)
                self.events.publish(
                    "project.expanded",
                    project_id=job.project_id,
                    scenes=[s.id for s in screenplay.scenes],
                )
                self._enqueue_dirty(job.project_id, graph)
            return
        with self._lock:
            self._heal_optional_consumers(job)

    def _heal_optional_consumers(self, job: Job) -> None:
        """A consumer that ran while this node's artifact was missing (only
        possible through an optional port) cached output built without it —
        under a hash that already includes this input, so nothing would ever
        re-render it. Drop those artifacts and recompile."""
        graph = self.store.load_graph(job.project_id)
        if job.spec.node_id not in graph.nodes:
            return
        optional_dsts = [
            e.dst
            for e in graph.edges
            if e.src == job.spec.node_id and e.port in OPTIONAL_PORTS and e.dst in graph.nodes
        ]
        if not optional_dsts:
            return
        cached = self.store.cached_hashes(job.project_id)
        history = self.queue.list(job.project_id, 1000)
        memo = dict(self._frozen_pins(graph, history, cached))
        stale: set[str] = set()
        for dst in optional_dsts:
            if graph.output_hash(dst, memo) in cached:
                stale.add(dst)
                stale |= graph.downstream_of(dst)
        dropped = 0
        for node_id in stale:
            if node_id in graph.nodes:
                dropped += self.store.delete_artifacts(
                    job.project_id, graph.output_hash(node_id, memo)
                )
        if dropped:
            self._enqueue_dirty(job.project_id, graph)

    # -- read model for the UI ------------------------------------------------

    def scene_board(self, project_id: str) -> dict:
        """Scene cards + statuses, derived from graph × jobs × artifacts."""
        with self._lock:
            return self._scene_board(project_id)

    def _scene_board(self, project_id: str) -> dict:
        graph = self.store.load_graph(project_id)
        history = self.queue.list(project_id, 1000)
        jobs = {job.spec.node_id: job for job in reversed(history)}
        cached = self.store.cached_hashes(project_id)
        # Frozen pins hash against their existing artifact (see compiler).
        memo: dict[str, str] = dict(self._frozen_pins(graph, history, cached))

        def node_state(node_id: str) -> dict | None:
            node = graph.nodes.get(node_id)
            if node is None:
                return None  # removed via patch — the card shows what's left
            job = jobs.get(node_id)
            out_hash = graph.output_hash(node_id, memo)
            # In-flight work outranks a stale cached artifact: a queued
            # final re-render must not read as already 'final'.
            if node.pinned:
                status = "pinned"
            elif job and job.status is JobStatus.RENDERING:
                status = "rendering"
            elif job and job.status is JobStatus.QUEUED:
                status = "queued"
            elif out_hash in cached:
                status = "final" if (job and job.spec.quality == "final") else "draft"
            elif job and job.status is JobStatus.FAILED:
                status = "failed"
            elif job and job.status is JobStatus.CANCELLED:
                status = "cancelled"
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
                # The advanced inspector edits these directly.
                "model": node.model,
                "pinned": node.pinned,
            }

        scenes = []
        raw_ids = {n.split(".")[0] for n in graph.nodes if "." in n and n.endswith(".clip")}
        scene_ids = sorted(raw_ids, key=scene_sort_key)
        for sid in scene_ids:
            card = {
                "scene_id": sid,
                "keyframe": node_state(f"{sid}.keyframe"),
                "clip": node_state(f"{sid}.clip"),
                "narration": node_state(f"{sid}.narration"),
            }
            # A split scene has sequential takes beyond ".clip" — surface
            # them so the card can show aggregate render state.
            extra = sorted(
                (
                    n
                    for n in graph.nodes
                    if n.startswith(f"{sid}.clip")
                    and n != f"{sid}.clip"
                    and n.removeprefix(f"{sid}.clip").isdigit()
                ),
                key=lambda n: int(n.removeprefix(f"{sid}.clip")),
            )
            if extra:
                card["clip_takes"] = [node_state(n) for n in extra]
            scenes.append(card)
        # Fixed order for the pipeline nodes, then anything else at the top
        # level (Quick Tool nodes like "thumbnail"/"voiceover").
        aux_ids = [
            n for n in ("script", "music", "captions", "timeline", "export") if n in graph.nodes
        ]
        aux_ids += sorted(n for n in graph.nodes if "." not in n and n not in aux_ids)
        aux = {n: state for n in aux_ids if (state := node_state(n)) is not None}
        return {"scenes": scenes, "aux": aux}
