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
import time
from pathlib import Path

from .backends.base import BackendRegistry, GenerationError
from .events import EventBus
from .fcpxml import edl_to_fcpxml
from .graph.compiler import QUALITY_SENSITIVE_KINDS, compile_graph
from .graph.editor import EditPlan, compile_edits, graph_revision, graph_view
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


class ConflictError(RuntimeError):
    """A request lost a race with concurrent state (maps to HTTP 409)."""


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
            project = self.store.create(
                title=prompt,
                graph=graph,
                mode=mode,
                aspect=aspect,
                duration_s=float(target_duration_s),
            )
            self._enqueue_dirty(project.id, graph)
        return project

    def create_tool(self, tool: str, params: dict) -> Project:
        """Quick Tool session: a one-node micro-project (doc: single artifact,
        direct export, optional promote into a full project)."""
        graph = tool_graph(tool, params)
        title = str(params.get("prompt") or params.get("text") or tool)
        with self._lock:
            project = self.store.create(
                title=title,
                graph=graph,
                mode=f"tool:{tool}",
                aspect=str(params.get("aspect")) if params.get("aspect") else None,
            )
            self._enqueue_dirty(project.id, graph)
        return project

    def rename(self, project_id: str, title: str) -> Project:
        """Title is meta-only display state — the graph and every node id
        are untouched, so nothing re-renders."""
        with self._lock:
            project = self.store.get(project_id)
            if project is None:
                raise KeyError(project_id)
            project.title = title[:120]
            project.updated_at = time.time()
            self.store.save_meta(project)
        self.events.publish("project.renamed", project_id=project_id, title=project.title)
        return project

    def duplicate(self, project_id: str) -> Project:
        with self._lock:
            copy = self.store.duplicate(project_id)
            if copy is None:
                raise KeyError(project_id)
        return copy

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
                title=screenplay.title or str(params.get("prompt", "")),
                graph=new_graph,
                aspect=str(params.get("aspect", "9:16")),
                duration_s=float(params.get("target_duration_s", 60)),
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
                project.updated_at = time.time()
                self.store.save_meta(project)
            self.events.publish("project.approved", project_id=project_id, checkpoint=checkpoint)
            return self._enqueue_dirty(project_id, self.store.load_graph(project_id))

    # -- editing -----------------------------------------------------------

    def patch(self, project_id: str, ops: list[PatchOp]) -> set[str]:
        with self._lock:
            graph = self.store.load_graph(project_id)
            dirty = apply_patch(graph, ops)
            dirty |= self._sync_caption_texts(graph)
            self.store.save_graph(project_id, graph)
            if dirty:
                self._enqueue_dirty(project_id, graph)
            self._refresh_meta_locked(project_id, graph)
        return dirty

    @staticmethod
    def _sync_caption_texts(graph: StoryGraph) -> set[str]:
        """Re-derive the captions node's ground-truth texts from the narration
        nodes, returning the nodes it dirtied. expand_screenplay writes them
        from the screenplay, but narration text also changes through patches
        (Inspector edits) and LLM edit plans — without this, captions would
        anchor the new audio to the old words.

        Every narration node contributes, empty text included, so this
        derivation matches expand_screenplay's exactly: a mismatch would flip
        the captions hash back and forth between the two paths, re-rendering
        the caption track and the export on every cycle."""
        captions = graph.nodes.get("captions")
        if captions is None:
            return set()
        texts = {
            node_id.removesuffix(".narration"): str(node.params.get("text", ""))
            for node_id, node in graph.nodes.items()
            if node_id.endswith(".narration")
        }
        if not texts or captions.params.get("texts") == texts:
            return set()
        # The hash change is what re-renders the captions; report it as dirty
        # so the work is enqueued now rather than lying in wait for whatever
        # unrelated action next triggers a plan.
        captions.params["texts"] = texts
        return {"captions"}

    def add_asset(self, project_id: str, filename: str, data: bytes, voice: bool = False) -> dict:
        """Import a user asset as a graph node. The file lands in generated/
        under the node's output hash, so the node is born cached: assets are
        never executed, only consumed (an image wired into a clip's keyframe
        port as the I2V source; a consented voice sample into a narration
        node's voice_ref port for cloning — the API layer has already
        enforced the consent affirmation for audio)."""
        import hashlib

        suffix = Path(filename).suffix.lower()
        sha = hashlib.sha256(data).hexdigest()
        node_id = f"asset-{sha[:12]}"
        params: dict = {"name": filename, "sha256": sha}
        if voice:
            params["voice_consent"] = True
        with self._lock:
            graph = self.store.load_graph(project_id)
            if node_id not in graph.nodes:
                graph.add_node(Node(id=node_id, kind=NodeKind.ASSET, params=params))
                self.store.save_graph(project_id, graph)
            out_hash = graph.output_hash(node_id)
            dest = self.store.generated_dir(project_id)
            dest.mkdir(parents=True, exist_ok=True)
            path = dest / f"{out_hash}{suffix}"
            if not path.exists():
                path.write_bytes(data)
            self._refresh_meta_locked(project_id, graph)
        self.events.publish("project.asset", project_id=project_id, node_id=node_id)
        return {"node_id": node_id, "hash": out_hash, "name": filename}

    def edit_view(self, project_id: str, scope: str) -> dict:
        """The whitelisted graph view a natural-language edit works from."""
        with self._lock:
            return graph_view(self.store.load_graph(project_id), scope)

    def apply_edit_plan(
        self, project_id: str, plan: EditPlan, scope: str, revision: str | None = None
    ) -> dict:
        """Compile an LLM edit plan against the live graph and apply it.
        Validation and apply share one lock hold, so the plan can't be
        checked against one graph state and applied to another. `revision`
        is the digest of the graph the plan was built from; if a background
        script job re-expanded (renumbering scenes) during the LLM call, the
        digest no longer matches and the stale plan is refused rather than
        landing on content the model never saw."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            if revision is not None and graph_revision(graph, scope) != revision:
                raise ConflictError(
                    "the project changed while the edit was being generated — please retry"
                )
            ops, warnings = compile_edits(graph, plan, scope)
            dirty = apply_patch(graph, ops) if ops else set()
            # Same ground-truth sync as patch(): an NL edit rewrites narration
            # text, so the captions must follow the new words, not the old.
            dirty |= self._sync_caption_texts(graph)
            if ops:
                self.store.save_graph(project_id, graph)
            if dirty:
                self._enqueue_dirty(project_id, graph)
            if ops:
                self._refresh_meta_locked(project_id, graph)
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
            self._refresh_meta_locked(project_id, graph)

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
            enqueued = self._enqueue_dirty(project_id, graph, quality="final")
            self._refresh_meta_locked(project_id, graph)
            return enqueued

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

    def _exportable_edl(self, project_id: str) -> tuple[dict, Path, str]:
        """The rendered EDL for the current edit, its base dir, and a title.
        Raises LookupError while the timeline hasn't rendered (or is stale
        for the current graph)."""
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
        return edl, edl_path.parent, project.title if project else project_id

    def export_otio(self, project_id: str) -> dict:
        """The current timeline as an OTIO document for pro-NLE handoff.
        ValueError for non-exportable EDLs."""
        edl, base, title = self._exportable_edl(project_id)
        return edl_to_otio(
            edl,
            resolve=lambda src: p if (p := Path(src)).is_absolute() else base / p,
            name=title,
        )

    def export_fcpxml(self, project_id: str) -> str:
        """The current timeline as FCPXML text for Final Cut handoff — same
        rendered-EDL contract as export_otio."""
        edl, base, title = self._exportable_edl(project_id)
        return edl_to_fcpxml(
            edl,
            resolve=lambda src: p if (p := Path(src)).is_absolute() else base / p,
            name=title,
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

        # Supersede stale queued work: a re-plan that changed a node's hash
        # (seed bump, param edit) makes any still-queued job for that node
        # garbage — cancel it instead of letting it render into an artifact
        # nothing references, or fail against inputs that no longer exist.
        # Rendering jobs are left to finish; their output is merely unused.
        active_jobs = self.queue.active(project_id)
        planned = {spec.node_id: spec.output_hash for spec in plan.jobs}
        superseded = {
            job.id
            for job in active_jobs
            if job.status is JobStatus.QUEUED
            and job.spec.node_id in planned
            and job.spec.output_hash != planned[job.spec.node_id]
        }
        for job_id in superseded:
            self.queue.cancel(job_id)
        # Skip nodes that already have an identical job in flight — quality
        # included, so finalize still enqueues finals over active drafts.
        active = {
            (job.spec.output_hash, job.spec.quality)
            for job in active_jobs
            if job.id not in superseded
        }
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
        # The project can be deleted between a job completing and this handler
        # running; bail before any load_graph, which would otherwise raise
        # inside the worker thread and escape into the scheduler.
        meta = self.store.get(job.project_id)
        if meta is None:
            return
        # Only the project's script node expands — a "metadata" publish-kit
        # job is SCRIPT-kind too but must never re-shape the graph.
        if (
            job.spec.kind is NodeKind.SCRIPT
            and job.spec.node_id == "script"
            and job.artifact is not None
        ):
            if meta.mode.startswith("tool:"):
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
                self._refresh_meta_locked(job.project_id, graph)
            return
        with self._lock:
            self._heal_optional_consumers(job)
            # A finished keyframe may be the tile thumbnail Home is waiting
            # on; any completion moves updated_at.
            self._refresh_meta_locked(job.project_id)

    def _heal_optional_consumers(self, job: Job) -> None:
        """A consumer that ran while this node's artifact was missing (only
        possible through an optional port) cached output built without it —
        under a hash that already includes this input, so nothing would ever
        re-render it. Drop those artifacts and recompile."""
        try:
            graph = self.store.load_graph(job.project_id)
        except (OSError, ValueError):
            return  # project deleted between completion and this handler
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
        frozen = self._frozen_pins(graph, history, cached)
        memo = dict(frozen)
        stale: set[str] = set()
        for dst in optional_dsts:
            if graph.output_hash(dst, memo) in cached:
                stale.add(dst)
                stale |= graph.downstream_of(dst)
        # A pin is the user's explicit "leave this alone". The memo above
        # resolves a pinned node to its FROZEN hash, so deleting it here
        # would destroy the very artifact the pin protects — and, with the
        # artifact gone, the pin stops resolving and the node re-renders.
        stale -= set(frozen)
        dropped = 0
        for node_id in stale:
            if node_id in graph.nodes:
                dropped += self.store.delete_artifacts(
                    job.project_id, graph.output_hash(node_id, memo)
                )
        if dropped:
            self._enqueue_dirty(job.project_id, graph)

    # -- read model for the UI ------------------------------------------------

    def _refresh_meta_locked(self, project_id: str, graph: StoryGraph | None = None) -> None:
        """Denormalize the Home-grid read model into meta.json (review 4):
        updated_at now, thumb = the cut's first rendered keyframe, duration =
        current cut length. Meta-only — graph and wire contract untouched.
        Callers hold self._lock."""
        project = self.store.get(project_id)
        if project is None:
            return
        if graph is None:
            try:
                graph = self.store.load_graph(project_id)
            except (OSError, ValueError):
                graph = None
        project.updated_at = time.time()
        if graph is not None:
            cached = self.store.cached_hashes(project_id)
            history = self.queue.list(project_id, 1000)
            memo = dict(self._frozen_pins(graph, history, cached))
            scene_ids = sorted(
                {n.split(".")[0] for n in graph.nodes if "." in n and n.endswith(".clip")},
                key=scene_sort_key,
            )
            timeline = graph.nodes.get("timeline")
            order = timeline.params.get("order") if timeline is not None else None
            if isinstance(order, list):
                ordered = [str(s) for s in order if str(s) in scene_ids]
                scene_ids = ordered + [s for s in scene_ids if s not in ordered]
            thumb: str | None = None
            duration = 0.0
            for sid in scene_ids:
                clip = graph.nodes.get(f"{sid}.clip")
                if clip is not None:
                    value = clip.params.get("duration_s")
                    if isinstance(value, (int, float)) and value > 0:
                        duration += float(value)
                if thumb is None and f"{sid}.keyframe" in graph.nodes:
                    key_hash = graph.output_hash(f"{sid}.keyframe", memo)
                    if key_hash in cached:
                        thumb = key_hash
            # The assembled timeline is the duration authority once it
            # exists: narration timing stretches scenes at assembly, so the
            # planned per-clip sum above can disagree with the exported cut
            # (a 44 s plan can assemble into a 65 s video).
            edl = self._assembled_edl(project_id, graph, memo, cached)
            assembled = edl.get("duration") if edl else None
            if isinstance(assembled, (int, float)) and assembled > 0:
                duration = float(assembled)
            project.thumb_hash = thumb
            if duration > 0:
                project.duration_s = round(duration, 1)
        self.store.save_meta(project)

    def _assembled_edl(
        self, project_id: str, graph: StoryGraph, memo: dict[str, str], cached: set[str]
    ) -> dict | None:
        """The cached timeline EDL, or None. The assembled cut is the
        authority on real durations once it exists — narration timing
        stretches scenes at assembly, so planned per-clip sums drift from
        the exported video."""
        if "timeline" not in graph.nodes:
            return None
        timeline_hash = graph.output_hash("timeline", memo)
        if timeline_hash not in cached:
            return None
        path = self.store.resolve_artifact(project_id, timeline_hash)
        if path is None:
            return None
        try:
            edl = json.loads(path.read_text())
        except (OSError, ValueError):
            return None  # mock/legacy EDLs — planned values stand
        return edl if isinstance(edl, dict) else None

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
            elif job and job.status is JobStatus.FAILED:
                # A failed render must surface even when a cached draft exists
                # at the same hash (quality isn't part of the hash) — otherwise
                # a failed *final* reads as a completed 'final'. The draft stays
                # viewable via artifact_hash below.
                status = "failed"
            elif job and job.status is JobStatus.CANCELLED:
                status = "cancelled"
            elif out_hash in cached:
                status = "final" if (job and job.spec.quality == "final") else "draft"
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
        # Per-scene actuals from the assembled cut so the timeline strip
        # agrees with the video it plays (planned sums drift at assembly).
        edl = self._assembled_edl(project_id, graph, memo, cached)
        assembled_durations = {
            str(seg.get("scene")): float(seg["duration"])
            for seg in (edl.get("video", []) if edl else [])
            if isinstance(seg, dict) and isinstance(seg.get("duration"), (int, float))
        }
        return {"scenes": scenes, "aux": aux, "assembled_durations": assembled_durations}
