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
from collections.abc import Collection
from contextvars import ContextVar
from pathlib import Path

from .backends.base import BackendRegistry, GenerationError
from .events import EventBus
from .fcpxml import edl_to_fcpxml
from .graph.compiler import (
    QUALITY_SENSITIVE_KINDS,
    CompiledPlan,
    compile_graph,
    orphaned_nodes,
    unready_nodes,
)
from .graph.editor import (
    EditPlan,
    compile_edits,
    graph_revision,
    graph_view,
    scrub_removed,
    typical_clip_s,
)
from .graph.model import (
    KEYFRAME_PORT,
    OPTIONAL_PORTS,
    SCENE_AUDIO_SUFFIX,
    Node,
    NodeKind,
    StoryGraph,
    scene_sort_key,
)
from .graph.patch import (
    TRANSIENT_PARAMS,
    PatchOp,
    apply_patch,
    check_restorable,
    stored_params,
    without_nulls,
)
from .graph.template_io import GraphTemplate, build_graph, to_template
from .graph.templates import (
    MAX_CLIP_S,
    expand_screenplay,
    prompt_template_graph,
    tool_graph,
)
from .jobs.models import Job, JobStatus
from .jobs.queue import JobQueue
from .jobs.scheduler import Scheduler
from .otio import edl_to_otio
from .providers.images import IMAGE_MIME_TYPES
from .project.store import (
    SAVEPOINT_LIMIT,
    GraphHistory,
    NodeTakes,
    Project,
    ProjectStore,
    SavePoint,
    Snapshot,
    TakeRecord,
)
from .schema import Screenplay

logger = logging.getLogger(__name__)

# Every status a scene-board node can report. This is a wire contract: the
# desktop mirrors it as the `NodeStatus` union, and a status the UI does not
# know renders with no colour and no label. test_ui_contract compares the two.
SCENE_NODE_STATUSES = (
    "queued",
    "rendering",
    "draft",
    "final",
    "failed",
    "cancelled",
    "pinned",
    "skipped",
    # Content the user has not written yet, or something downstream of it.
    # Distinct from `skipped`: that one reads "not needed", and this node is
    # very much needed — it is waiting on a person, not on the queue.
    "blocked",
)


class ConflictError(RuntimeError):
    """A request lost a race with concurrent state (maps to HTTP 409)."""


# Whether the caller of the request in flight may spend the user's BYOK
# provider keys. A ContextVar rather than a parameter because EVERY enqueue
# funnels through _enqueue_dirty and nothing else, while the *routes* that
# reach it are fifteen and growing - a flag threaded through them would be
# missing from the sixteenth, which is precisely how this rule was broken
# three times over. asyncio.to_thread copies the context, so a value set by
# the API layer is visible in the worker thread that runs the service.
CLOUD_SPEND_ALLOWED: ContextVar[bool] = ContextVar("cloud_spend_allowed", default=True)

# The prefix `BackendRegistry.resolve` routes on (backends/base.py). Named
# here because the spend rule's whole claim is that what it refuses is
# exactly what would reach a provider, and a second spelling of the test is
# how that claim stops being true.
CLOUD_PREFIX = "cloud:"


class CloudSpendRefused(RuntimeError):
    """A caller that may not spend the user's BYOK keys planned a render
    that would (maps to HTTP 403).

    The rule is enforced where the money is actually committed - the queue -
    rather than at the surfaces that lead there. A client-side deny-list of
    routes cannot hold: set_model was gated, then select_take reached the
    same spend by restoring a recorded identity, then undo reached it by
    restoring a whole snapshot. Each fix named a route; this names the
    outcome.
    """


# The sentence every refusal ends on. One constant because the message is the
# agent-facing contract for this 403 and it reaches a console through
# `automation.py`, so it is ASCII-constrained too - and a sentence duplicated
# across two modules is a sentence that gets reworded in one of them.
_REFUSAL_TAIL = "Choosing cloud models is a decision made in the app."


def cloud_text_refusal(model: str) -> CloudSpendRefused:
    """The refusal for the one spend that never reaches the queue.

    `/edit` with a `model` calls the BYOK text provider inline on the request
    path, so `_enqueue_dirty` never sees it and `ProjectService._refusal`'s
    "would render" wording does not fit. Here rather than inline in the route
    so both refusals share the tail above and the same ASCII surface.
    """
    return CloudSpendRefused(
        f"{model} would bill the user's provider key for this edit, and this caller may "
        f"not spend it. {_REFUSAL_TAIL}"
    )


# Nodes whose regenerate keeps the displaced identity as a selectable take.
# Assets are never regenerated; the script rebuilds the whole pipeline, so a
# screenplay "take" is a different feature from an alternate render.
TAKE_KINDS = (
    NodeKind.KEYFRAME,
    NodeKind.CLIP,
    NodeKind.NARRATION,
    NodeKind.MUSIC,
    NodeKind.THUMBNAIL,
)


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
            self._refuse_new_graph_spend(graph)
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
            self._refuse_new_graph_spend(graph)
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
            # An unknown id used to surface as `store.duplicate` returning
            # None; the spend check below reads the source graph first, so
            # the KeyError contract is established before anything reads it.
            if self.store.get(project_id) is None:
                raise KeyError(project_id)
            # Job history is keyed by project id and does NOT travel with the
            # copy, so `_distrusted_hashes` would have nothing to work from
            # there: every placeholder in the copied generated/ would come
            # back trusted, and export/package would hand a mock artifact over
            # as the real cut. Decide distrust HERE, against the source's
            # history, and drop those artifacts from the copy so they
            # re-render under the backend that serves the kind today.
            source_history = self.queue.list(project_id, 1000)
            source_cached = self.store.cached_hashes(project_id)
            distrusted = self._distrusted_hashes(source_history, source_cached)
            # Read once and reused for the enqueue below: copytree makes the
            # copy's project.json byte-identical, so re-reading it under the
            # new id would validate the same document twice.
            graph = self.store.load_graph(project_id)
            # Against the cache the COPY will start with, not an empty one:
            # a fully-rendered source duplicates into a fully-cached project
            # that enqueues nothing, and refusing that would refuse more than
            # the rule asks for.
            self._refuse_new_graph_spend(graph, source_cached - distrusted)
            copy = self.store.duplicate(project_id)
            if copy is None:
                raise KeyError(project_id)
            for out_hash in distrusted:
                self.store.delete_artifacts(copy.id, out_hash)
            # generated/ travels with the copy, so a fully-rendered source
            # duplicates into a fully-cached project and this enqueues
            # nothing. A source that was mid-render (or never finished)
            # copies its gaps too — and without this the duplicate has no
            # jobs at all, so every unrendered node sits reading "queued"
            # forever with nothing running.
            self._enqueue_dirty(copy.id, graph)
        return copy

    def export_template(self, project_id: str, *, name: str = "", description: str = "") -> dict:
        """This project's shape as a portable template document."""
        with self._lock:
            project = self.store.get(project_id)
            if project is None:
                raise KeyError(project_id)
            graph = self.store.load_graph(project_id)
        template = to_template(
            graph,
            name=name or project.title,
            description=description,
            mode=project.mode,
            aspect=project.aspect,
            duration_s=project.duration_s,
        )
        return template.model_dump(mode="json")

    def create_from_template(self, template: GraphTemplate, *, title: str = "") -> Project:
        """A new project with the template's graph.

        The template is already validated (see graph.template_io) — this only
        turns it into a project. Nothing is cached, so `_enqueue_dirty` plans
        the whole graph, exactly as a fresh prompt-mode project does.
        """
        graph = build_graph(template)
        with self._lock:
            # A template is legitimately allowed to carry cloud models (see
            # `cloud_models` in template_io), which makes importing one a
            # choice to spend on the author's providers - refused before the
            # project exists, or the 403 leaves it in the user's list anyway.
            self._refuse_new_graph_spend(graph)
            project = self.store.create(
                title=title or template.name,
                graph=graph,
                mode=template.mode,
                aspect=template.aspect,
                duration_s=template.duration_s,
            )
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
            artifact: Path | None = None
            for candidate in self.queue.list(project_id, 1000):
                if (
                    candidate.spec.node_id == "script"
                    and candidate.spec.output_hash == current_hash
                    and candidate.status is JobStatus.DONE
                ):
                    # Through the store, not Path(job.artifact): the record is
                    # generated/-relative, and older records may be absolute
                    # paths from a machine this project no longer lives on.
                    artifact = self.store.resolve_job_artifact(project_id, candidate.artifact)
                    if artifact is not None:
                        break
            if artifact is None:
                # Fall back to the content-addressed artifact itself: job
                # history can be trimmed and a record can be stale, but the
                # file is named by the hash we just computed. Without this,
                # promotion after a data-dir move reports "the script has not
                # finished generating yet" forever.
                artifact = self.store.resolve_artifact(project_id, current_hash)
            if artifact is None:
                raise ValueError("the script has not finished generating yet")
            screenplay = Screenplay.model_validate_json(artifact.read_text(encoding="utf-8"))

            params = script.params
            new_graph = prompt_template_graph(
                str(params.get("prompt", "")),
                target_duration_s=int(params.get("target_duration_s", 60)),
                aspect=str(params.get("aspect", "9:16")),
                style_preset=str(params.get("style_preset", "cinematic")),
            )
            new_graph.nodes["script"].seed = script.seed
            expand_screenplay(new_graph, screenplay)
            # The screenplay is copied in below, so the script node arrives
            # cached and must not count as a spend; everything else in the
            # expanded graph does.
            out_hash = new_graph.output_hash("script", {})
            self._refuse_new_graph_spend(new_graph, {out_hash})
            project = self.store.create(
                title=screenplay.title or str(params.get("prompt", "")),
                graph=new_graph,
                aspect=str(params.get("aspect", "9:16")),
                duration_s=float(params.get("target_duration_s", 60)),
            )
            # Seed the artifact under the new script node's hash: cached, so
            # the pipeline starts at keyframes instead of re-running the LLM.
            dest = self.store.generated_dir(project.id)
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(artifact, dest / f"{out_hash}.screenplay.json")
            # Record the link on both sides before any job can run. Both metas
            # are written under this lock hold, and _refresh_meta_locked --
            # which the first finished job triggers -- re-reads meta.json
            # before writing, so it carries these fields forward rather than
            # dropping them.
            #
            # `meta` was read under this same hold and nothing else may write
            # it meanwhile, so appending cannot lose a concurrent promotion.
            project.promoted_from = project_id
            self.store.save_meta(project)
            meta.promoted_to = [*meta.promoted_to, project.id]
            self.store.save_meta(meta)
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
            graph = self.store.load_graph(project_id)
            # Passing a checkpoint is what RELEASES the jobs it was holding
            # back, so it is a cloud decision even though it names no model —
            # and there is no un-approve, so a refusal after `save_meta` left
            # the gate permanently open for the user's next action to spend
            # through.
            self._refuse_cloud_spend(project_id, graph)
            if checkpoint not in project.approvals:
                project.approvals.append(checkpoint)
                project.updated_at = time.time()
                self.store.save_meta(project)
            self.events.publish("project.approved", project_id=project_id, checkpoint=checkpoint)
            return self._enqueue_dirty(project_id, graph)

    def render(self, project_id: str) -> int:
        """Plan whatever is stale, at draft quality. Returns jobs enqueued.

        `patch` only re-plans when an op actually dirtied something, so an
        empty patch — the obvious way to say "just render what is pending" —
        enqueues nothing at all. That is fine for an editor, which patches
        because something changed, and wrong for a headless caller whose
        queue was drained by a restart or a cancellation: it would be told
        the render finished without a single job having run.

        `_enqueue_dirty` already works from the cache rather than a dirty
        set, so this is the draft-quality twin of `finalize`.
        """
        with self._lock:
            graph = self.store.load_graph(project_id)
            enqueued = self._enqueue_dirty(project_id, graph)
            self._refresh_meta_locked(project_id, graph)
            return enqueued

    # -- editing -----------------------------------------------------------

    def patch(self, project_id: str, ops: list[PatchOp]) -> set[str]:
        with self._lock:
            graph = self.store.load_graph(project_id)
            before = graph.model_dump(mode="json")
            # Read before the ops touch anything: `select_take` and `set_model`
            # both land a model, and the gate has to know which ones the
            # caller found already there.
            before_cloud = self._cloud_models(graph)
            ops, takes = self._resolve_select_takes(project_id, graph, ops)
            ops = self._resolve_scene_ops(graph, ops)
            dirty = apply_patch(graph, ops)
            dirty |= self._sync_caption_texts(graph)
            # Nothing is on disk yet: a refusal here leaves the project
            # exactly as the caller found it, takes.json included.
            #
            # Under the same `if dirty` as the enqueue below, so this moves
            # WHEN the refusal happens and never WHICH patches it refuses. An
            # op that dirties nothing (a pin) plans no jobs, so it never
            # reached the check before — refusing one because some unrelated
            # node happens to sit on a cloud model would deny an agent an
            # edit that cannot bill anyone.
            if dirty:
                self._refuse_cloud_spend(project_id, graph, before=before_cloud)
            if takes is not None:
                self.store.save_takes(project_id, takes)
            self.store.save_graph(project_id, graph)
            self._record_history(project_id, before, graph, kind="patch")
            if dirty:
                self._enqueue_dirty(project_id, graph)
            self._refresh_meta_locked(project_id, graph)
        return dirty

    def _resolve_select_takes(
        self, project_id: str, graph: StoryGraph, ops: list[PatchOp]
    ) -> tuple[list[PatchOp], NodeTakes | None]:
        """Fill each select_take op with the recorded identity its `take`
        hash names, and park the node's current identity as a take of its
        own — so switching is always a round trip, never a one-way door.

        Returns the takes to persist rather than persisting them, because
        the patch can still be refused (a take can carry a cloud model) and
        a refused request must not leave a take recorded behind it."""
        if not any(op.op == "select_take" for op in ops):
            return ops, None
        takes = self.store.load_takes(project_id)
        memo = {nid: n.frozen_hash for nid, n in graph.nodes.items() if n.pinned and n.frozen_hash}
        resolved: list[PatchOp] = []
        for op in ops:
            if op.op != "select_take":
                resolved.append(op)
                continue
            node = graph.nodes.get(op.node_id)
            if node is None:
                raise KeyError(op.node_id)
            record = next(
                (t for t in takes.takes.get(op.node_id, []) if t.output_hash == op.take), None
            )
            if record is None:
                raise ValueError(f"{op.node_id} has no recorded take {op.take}")
            takes.record(op.node_id, self._current_take(graph, op.node_id, memo))
            resolved.append(
                PatchOp(
                    op="select_take",
                    node_id=op.node_id,
                    params=dict(record.params),
                    seed=record.seed,
                    model=record.model,
                )
            )
        return resolved, takes

    def _resolve_scene_ops(self, graph: StoryGraph, ops: list[PatchOp]) -> list[PatchOp]:
        """Compile each add_scene / remove_scene op into the primitive ops
        that build or dismantle a scene subgraph — through apply_patch like
        every other edit, so the cycle check and the consent gate cover
        added scenes for free.

        The screenplay stays the source of truth: like a scene removed by
        the NL editor, an added scene lives until the script itself
        re-renders, at which point expansion rebuilds the scene set from
        the new screenplay.
        """
        resolved: list[PatchOp] = []
        # Ops are compiled against the unmutated graph, so a second
        # add_scene in the same patch must see the order the first one
        # built, not recompute it from the graph and overwrite it.
        carried_order: list[str] | None = None
        # Same reason, one op along: two removals in a patch must not each
        # think the other's scene is still there — the last scene check
        # would pass twice and empty the project.
        removed: set[str] = set()
        for op in ops:
            if op.op == "add_scene":
                compiled = self._compile_add_scene(graph, op, resolved, carried_order)
                carried_order = list(compiled[-1].params["order"])
                resolved.extend(compiled)
            elif op.op == "remove_scene":
                removed.add(op.node_id)
                resolved.extend(self._compile_remove_scene(graph, op, removed))
            else:
                resolved.append(op)
        return resolved

    @staticmethod
    def _compile_remove_scene(graph: StoryGraph, op: PatchOp, removed: set[str]) -> list[PatchOp]:
        """A scene's nodes, plus the timeline's references to it.

        The refusals are the NL editor's, restated against a single scene —
        one route for removing a scene must not be safer than the other.
        They are ValueErrors rather than dropped warnings because this op
        names one scene and the caller is a person who clicked delete: a
        refusal they can read beats a request that reports success and
        changes nothing.
        """
        scene_id = op.node_id
        # Prefix-based, like templates._remove_scene: a split scene owns
        # clip takes beyond the fixed member set.
        members = sorted(n for n in graph.nodes if n.startswith(f"{scene_id}."))
        if not members:
            raise KeyError(scene_id)
        scenes = {n.split(".")[0] for n in graph.nodes if "." in n}
        if not scenes - removed:
            raise ValueError(f"{scene_id} is the only scene left — a project keeps at least one")
        pinned = [n for n in members if graph.nodes[n].pinned]
        if pinned:
            raise ValueError(f"{scene_id} has a pinned node ({pinned[0]}) — unpin it to remove it")
        timeline = graph.nodes.get("timeline")
        if timeline is not None and timeline.pinned:
            # A pinned timeline serves a frozen EDL, so the removal would
            # delete the nodes and leave the cut playing them. Refuse rather
            # than half-apply.
            raise ValueError("the timeline is pinned — unpin it to remove scenes")
        compiled = [PatchOp(op="remove_node", node_id=member) for member in members]
        # Computed against every scene removed so far in this patch, so the
        # last scrub in a multi-removal patch is the complete one.
        if timeline is not None:
            scrub = scrub_removed(timeline.params, removed)
            if scrub:
                compiled.append(PatchOp(op="set_params", node_id="timeline", params=scrub))
        return compiled

    @staticmethod
    def _compile_add_scene(
        graph: StoryGraph,
        op: PatchOp,
        pending: list[PatchOp],
        carried_order: list[str] | None,
    ) -> list[PatchOp]:
        if "timeline" not in graph.nodes or "script" not in graph.nodes:
            raise ValueError("this project has no timeline to add a scene to")
        # `src` names a picture to build the scene on, in place of the
        # keyframe this op would otherwise generate — a scene made from an
        # image the user dropped in.
        #
        # Part of THIS op rather than a `connect` in a second patch, for two
        # reasons. The first patch ends in `_enqueue_dirty`, and until the
        # asset is wired the generated keyframe still feeds the clip: it is
        # queued, rendered and paid for, and only then displaced. That is the
        # exact waste `orphaned_nodes` was written to prevent, and it cannot,
        # because the node is not orphaned yet. Second, two patches can
        # half-succeed — leaving a scene with no picture that the user's next
        # attempt duplicates rather than repairs.
        #
        # Checked here because `connect` does not: it wires whatever id it is
        # given, so a typo would build the whole subgraph around an edge from
        # a node that does not exist.
        if op.src is not None and op.src not in graph.nodes:
            raise ValueError(f"unknown keyframe source: {op.src}")
        # This op reads its params before the add_node ops it compiles to
        # reach `stored_params`, and it reads them through `str(...)` with a
        # default written for an ABSENT key: `str(None)` is the string
        # "None", so a null here mints a scene whose keyframe renders that
        # word, whose narration speaks it, and which `unready_nodes` reads
        # as written rather than blocked. `null` for a field the caller has
        # not filled in is exactly what an LLM emits into `ops`.
        params = stored_params(op.params or {})
        prompt = str(params.get("prompt", ""))
        narration = str(params.get("narration", ""))
        # Absent means "whatever this project's scenes run for" — the same
        # rule the suggestion's word budget is derived from, so the narration
        # written for the scene is measured against the length the scene
        # actually gets.
        default_s = typical_clip_s(
            [
                float(node.params["duration_s"])
                for node in graph.nodes.values()
                if node.kind is NodeKind.CLIP
                and isinstance(node.params.get("duration_s"), int | float)
            ]
        )
        try:
            duration_s = float(params.get("duration_s", default_s))
        except (TypeError, ValueError):
            duration_s = default_s
        # One clip only: past MAX_CLIP_S a scene splits into sequential
        # takes, which is expansion's job to construct, not a patch op's.
        duration_s = min(max(duration_s, 1.0), MAX_CLIP_S)

        # Never reuse a scene number: trims/transitions in the timeline
        # params are keyed by scene id and survive scene removal, so a
        # recycled id would inherit a removed scene's edits. Ids pending in
        # this same patch count too, or two add_scene ops collide.
        used = {
            n.split(".")[0] for n in graph.nodes if "." in n and n.split(".")[0].startswith("s")
        }
        timeline = graph.nodes["timeline"]
        order = (
            list(carried_order)
            if carried_order is not None
            else list(timeline.params.get("order") or [])
        )
        used |= set(order)
        used |= set((timeline.params.get("trims") or {}).keys())
        used |= set((timeline.params.get("transitions") or {}).keys())
        used |= {p.node_id.split(".")[0] for p in pending if p.op == "add_node"}
        numbers = [int(s[1:]) for s in used if s[1:].isdigit()]
        sid = f"s{max(numbers, default=0) + 1}"

        scene_ids = sorted(
            {n.split(".")[0] for n in graph.nodes if "." in n and n.endswith(".clip")},
            key=scene_sort_key,
        )
        if not order:
            order = scene_ids
        if op.after is not None:
            if op.after not in order:
                raise ValueError(f"unknown scene: {op.after}")
            order.insert(order.index(op.after) + 1, sid)
        else:
            order.append(sid)

        aspect = graph.nodes["script"].params.get("aspect") or timeline.params.get("aspect")
        # Voice is a project-wide style choice; a new scene should speak
        # like its neighbours, not fall back to the backend default.
        voice = next(
            (
                node.params["voice"]
                for node in graph.nodes.values()
                if node.kind is NodeKind.NARRATION and node.params.get("voice")
            ),
            None,
        )
        keyframe_params = {"prompt": prompt}
        clip_params = {
            "prompt": prompt,
            "motion": str(params.get("motion", "")),
            "duration_s": duration_s,
            "mode": "i2v",
        }
        if aspect:
            keyframe_params["aspect"] = aspect
            clip_params["aspect"] = aspect
        narration_params: dict = {"text": narration}
        if voice:
            narration_params["voice"] = voice

        kf_id, clip_id, narr_id = f"{sid}.keyframe", f"{sid}.clip", f"{sid}.narration"
        return [
            PatchOp(
                op="add_node",
                node_id=kf_id,
                node=Node(id=kf_id, kind=NodeKind.KEYFRAME, params=keyframe_params),
            ),
            PatchOp(
                op="add_node",
                node_id=clip_id,
                node=Node(id=clip_id, kind=NodeKind.CLIP, params=clip_params),
            ),
            PatchOp(
                op="add_node",
                node_id=narr_id,
                node=Node(id=narr_id, kind=NodeKind.NARRATION, params=narration_params),
            ),
            PatchOp(op="connect", node_id=kf_id, src="script", port="default"),
            PatchOp(op="connect", node_id=narr_id, src="script", port="default"),
            # The user's picture when they supplied one, otherwise the node
            # this op just minted. The generated keyframe is still ADDED
            # either way: it is what the flowchart marks "not needed", and
            # what the scene falls back to if the still is ever disconnected.
            PatchOp(op="connect", node_id=clip_id, src=op.src or kf_id, port=KEYFRAME_PORT),
            PatchOp(op="connect", node_id="timeline", src=clip_id, port=sid),
            PatchOp(
                op="connect",
                node_id="timeline",
                src=narr_id,
                port=f"{sid}{SCENE_AUDIO_SUFFIX}",
            ),
            PatchOp(op="set_params", node_id="timeline", params={"order": order}),
        ]

    @staticmethod
    def _current_take(graph: StoryGraph, node_id: str, memo: dict[str, str]) -> TakeRecord:
        """The node's identity, as `select_take` will restore it.

        Recorded through `stored_params` because `select_take` restores it
        through `stored_params`: a null written here is dropped on the way
        back, landing the node one hash away from the artifact this record
        names and re-rendering a take that was supposed to be a cache hit.
        Safe to strip RESERVED_PARAMS here too - TAKE_KINDS holds no asset
        or script node, so nothing in this record carries one.
        """
        node = graph.nodes[node_id]
        return TakeRecord(
            output_hash=graph.output_hash(node_id, memo),
            seed=node.seed,
            model=node.model,
            params=stored_params(node.params, drop=TRANSIENT_PARAMS),
            at=time.time(),
        )

    def _record_history(
        self,
        project_id: str,
        before: dict,
        graph: StoryGraph,
        *,
        kind: str,
        summary: str | None = None,
        node_id: str | None = None,
    ) -> None:
        """Under the lock, after a mutation: push the pre-mutation graph onto
        the undo stack — but only when the mutation changed anything, so a
        no-op patch does not burn an undo step on nothing."""
        if graph.model_dump(mode="json") == before:
            return
        history = self.store.load_history(project_id)
        history.push(
            Snapshot(kind=kind, at=time.time(), summary=summary, node_id=node_id, graph=before)
        )
        self.store.save_history(project_id, history)

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
        node's voice_ref port for cloning). `voice` is True only when the
        API layer collected the consent affirmation — audio without it is a
        plain asset, unstamped, which the voice_ref chokepoint refuses."""
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

    def asset_image_path(self, project_id: str, node_id: str) -> Path:
        """Where an image asset's bytes actually are.

        Refuses anything that is not an image asset here rather than letting a
        vision provider discover it: sending the script node's JSON to a
        cloud model spends a request to be told what this can answer for
        free. `KeyError` for a node that is not in the graph, `ValueError`
        for one that is not a picture — the two the route maps to 404 and
        422.
        """
        with self._lock:
            graph = self.store.load_graph(project_id)
            node = graph.nodes.get(node_id)
            if node is None:
                raise KeyError(node_id)
            if node.kind is not NodeKind.ASSET:
                raise ValueError(f"{node_id} is not an image asset")
            path = self.store.resolve_artifact(project_id, graph.output_hash(node_id))
        if path is None:
            raise KeyError(node_id)
        if path.suffix.lower() not in IMAGE_MIME_TYPES:
            raise ValueError(f"{node_id} is not an image asset")
        return path

    def preview_edit_plan(
        self, project_id: str, plan: EditPlan, scope: str, revision: str | None = None
    ) -> dict:
        """Compile an edit plan and report what it WOULD do — the planned
        ops, the warnings, and the dirty cone — committing nothing: no
        save, no enqueue, no history entry, no event. The dirty preview
        applies the ops to a throwaway copy of the graph, so it is the
        same answer apply would give, not an estimate."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            if revision is not None and graph_revision(graph, scope) != revision:
                raise ConflictError(
                    "the project changed while the edit was being generated — please retry"
                )
            ops, warnings = compile_edits(graph, plan, scope)
            scratch = graph.model_copy(deep=True)
            dirty = apply_patch(scratch, ops) if ops else set()
        return {
            "ops": len(ops),
            "planned": [op.model_dump(exclude_none=True) for op in ops],
            "dirty": sorted(dirty),
            "warnings": warnings,
        }

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
            before = graph.model_dump(mode="json")
            before_cloud = self._cloud_models(graph)
            ops, warnings = compile_edits(graph, plan, scope)
            dirty = apply_patch(graph, ops) if ops else set()
            # Same ground-truth sync as patch(): an NL edit rewrites narration
            # text, so the captions must follow the new words, not the old.
            dirty |= self._sync_caption_texts(graph)
            # Persist whenever the graph changed at all, not just when the plan
            # compiled to ops: the sync above can dirty the captions on its own
            # (a graph whose texts drifted), and enqueueing work derived from a
            # graph that was never saved would render under a hash the stored
            # graph can never reproduce — re-rendering forever.
            # Same rule, and the same placement, as patch(): nothing is on
            # disk yet, so a refusal here leaves the project as the caller
            # found it. This is the route an agent host reaches for most, and
            # an NL edit that only rewrites a prompt still re-dirties a clip
            # the user put on a cloud model.
            if dirty:
                self._refuse_cloud_spend(project_id, graph, before=before_cloud)
            if ops or dirty:
                self.store.save_graph(project_id, graph)
                self._record_history(project_id, before, graph, kind="edit", summary=plan.summary)
            if dirty:
                self._enqueue_dirty(project_id, graph)
            if ops or dirty:
                self._refresh_meta_locked(project_id, graph)
        self.events.publish(
            "project.edited", project_id=project_id, ops=len(ops), summary=plan.summary
        )
        return {"ops": len(ops), "dirty": sorted(dirty), "warnings": warnings}

    def regenerate(self, project_id: str, node_id: str, seed: int | None = None) -> None:
        with self._lock:
            graph = self.store.load_graph(project_id)
            node = graph.nodes[node_id]
            before = graph.model_dump(mode="json")
            before_cloud = self._cloud_models(graph)
            takes: NodeTakes | None = None
            if node.kind in TAKE_KINDS:
                # The identity being displaced stays selectable: its artifact
                # is content-addressed on disk, so switching back later is a
                # cache hit, not a re-render.
                takes = self.store.load_takes(project_id)
                memo = {
                    nid: n.frozen_hash
                    for nid, n in graph.nodes.items()
                    if n.pinned and n.frozen_hash
                }
                takes.record(node_id, self._current_take(graph, node_id, memo))
            node.seed = seed if seed is not None else node.seed + 1
            # A new take is of the node's configuration. Carrying a finished
            # revision's notes here would re-ask them against a draft that
            # the revision itself has already superseded.
            #
            # Not `stored_params`: this runs on any node the route names,
            # assets included, and those hold the RESERVED_PARAMS the patch
            # chokepoint gates on - stripping `voice_consent` here would make
            # every later restore fail check_restorable.
            node.params = {k: v for k, v in node.params.items() if k not in TRANSIENT_PARAMS}
            # Nothing is on disk yet, same as patch(). The seed bump is
            # exactly what makes this node uncached, so a refusal after the
            # write parks the graph on a cloud identity with no artifact
            # behind it - and the user's next render from the app pays for
            # the choice the refused caller made.
            self._refuse_cloud_spend(project_id, graph, before=before_cloud)
            if takes is not None:
                self.store.save_takes(project_id, takes)
            self.store.save_graph(project_id, graph)
            self._record_history(project_id, before, graph, kind="regenerate", node_id=node_id)
            self._enqueue_dirty(project_id, graph)
            self._refresh_meta_locked(project_id, graph)

    # -- undo/redo & save points --------------------------------------------

    def history_info(self, project_id: str) -> dict:
        with self._lock:
            return self._history_info(self.store.load_history(project_id))

    def undo(self, project_id: str) -> dict:
        return self._step_history(project_id, "undo")

    def redo(self, project_id: str) -> dict:
        return self._step_history(project_id, "redo")

    def _step_history(self, project_id: str, direction: str) -> dict:
        """Walk the undo/redo stacks one step. The two directions are one
        mechanism: pop a snapshot, park the current graph on the opposite
        stack under the same descriptor, restore. Because artifacts are
        content-addressed, the re-plan after a restore is cache hits for
        everything that ever rendered — undo never re-renders old work."""
        with self._lock:
            history = self.store.load_history(project_id)
            source = history.undo if direction == "undo" else history.redo
            target = history.redo if direction == "undo" else history.undo
            if not source:
                raise ConflictError(f"nothing to {direction}")
            entry = source.pop()
            restored = self._restorable_graph(entry.graph)
            current = self.store.load_graph(project_id)
            # Before the stacks are rewritten: a snapshot can hold a cloud
            # model the caller may not spend on, and restoring one is how the
            # rule was broken the third time. Refusing after the pop would
            # consume the history step as well as landing the model.
            self._refuse_cloud_spend(project_id, restored, before=self._cloud_models(current))
            target.append(entry.model_copy(update={"graph": current.model_dump(mode="json")}))
            self.store.save_graph(project_id, restored)
            self.store.save_history(project_id, history)
            self._enqueue_dirty(project_id, restored)
            self._refresh_meta_locked(project_id, restored)
            info = self._history_info(history)
        self.events.publish("project.restored", project_id=project_id, direction=direction)
        return info

    def create_savepoint(self, project_id: str, label: str) -> dict:
        label = label.strip()[:80]
        if not label:
            raise ValueError("save point label is empty")
        with self._lock:
            graph = self.store.load_graph(project_id)
            history = self.store.load_history(project_id)
            if len(history.savepoints) >= SAVEPOINT_LIMIT:
                raise ValueError(
                    f"a project holds at most {SAVEPOINT_LIMIT} save points - delete one first"
                )
            history.savepoints.append(
                SavePoint(
                    id=f"sp{history.next_savepoint}",
                    label=label,
                    at=time.time(),
                    graph=graph.model_dump(mode="json"),
                )
            )
            history.next_savepoint += 1
            self.store.save_history(project_id, history)
            return self._history_info(history)

    def restore_savepoint(self, project_id: str, savepoint_id: str) -> dict:
        with self._lock:
            history = self.store.load_history(project_id)
            savepoint = next((s for s in history.savepoints if s.id == savepoint_id), None)
            if savepoint is None:
                raise KeyError(savepoint_id)
            restored = self._restorable_graph(savepoint.graph)
            current = self.store.load_graph(project_id)
            if restored.model_dump(mode="json") != current.model_dump(mode="json"):
                # Same rule, and the same reason, as undo/redo above. Here it
                # also protects the save point itself: the refusal used to
                # fire between save_graph and save_history, which restored the
                # graph and then dropped the "restore" snapshot that was the
                # only way back to what the user had.
                self._refuse_cloud_spend(project_id, restored, before=self._cloud_models(current))
                # Restoring is itself an undoable mutation, so Ctrl+Z walks
                # back out of a save point like out of any other edit.
                history.push(
                    Snapshot(
                        kind="restore",
                        at=time.time(),
                        summary=savepoint.label,
                        graph=current.model_dump(mode="json"),
                    )
                )
                self.store.save_graph(project_id, restored)
                self._enqueue_dirty(project_id, restored)
                self._refresh_meta_locked(project_id, restored)
            self.store.save_history(project_id, history)
            info = self._history_info(history)
        self.events.publish("project.restored", project_id=project_id, direction="savepoint")
        return info

    def delete_savepoint(self, project_id: str, savepoint_id: str) -> dict:
        with self._lock:
            history = self.store.load_history(project_id)
            kept = [s for s in history.savepoints if s.id != savepoint_id]
            if len(kept) == len(history.savepoints):
                raise KeyError(savepoint_id)
            history.savepoints = kept
            self.store.save_history(project_id, history)
            return self._history_info(history)

    @staticmethod
    def _restorable_graph(dump: dict) -> StoryGraph:
        """A snapshot as a validated StoryGraph. check_restorable re-runs the
        patch chokepoint's structural gates (cycles, voice consent): the
        snapshots are engine-written, but they live in an editable file.

        A restore is also the fifth route that replaces every node's params
        wholesale, so it re-establishes the null rule too — `without_nulls`
        rather than `stored_params`, because check_restorable below reads
        `voice_consent` off the asset node and stripping it here would refuse
        every legitimate restore of a voice-cloned project. Without this,
        expansion's migration is undone by one Ctrl+Z: a snapshot taken
        before the rule existed re-plants `{"captions": None}` on the export,
        which silently stops burning the captions the user asked for and
        lands on a hash no cached export can match.
        """
        graph = StoryGraph.model_validate(dump)
        for node in graph.nodes.values():
            node.params = without_nulls(node.params)
        check_restorable(graph)
        return graph

    @staticmethod
    def _history_info(history: GraphHistory) -> dict:
        def descriptor(snapshot: Snapshot) -> dict:
            return {
                "kind": snapshot.kind,
                "summary": snapshot.summary,
                "node_id": snapshot.node_id,
            }

        return {
            "undo_depth": len(history.undo),
            "redo_depth": len(history.redo),
            "undo_top": descriptor(history.undo[-1]) if history.undo else None,
            "redo_top": descriptor(history.redo[-1]) if history.redo else None,
            "savepoints": [{"id": s.id, "label": s.label, "at": s.at} for s in history.savepoints],
        }

    def enhance_script(self, project_id: str, notes: str) -> set[str]:
        """Revise the script from user feedback: the notes and the screenplay
        they amend ride the script node's params, so the rewrite goes through
        the same patch path as any other graph edit (new hash, re-plan, board
        state) and reaches every script backend via script_prompt."""
        notes = notes.strip()
        if not notes:
            raise ValueError("feedback is empty")
        with self._lock:
            graph = self.store.load_graph(project_id)
            script = graph.nodes.get("script")
            if script is None or script.kind is not NodeKind.SCRIPT:
                raise ValueError("this project has no script to enhance")
            # Only the artifact matching the node's CURRENT identity is the
            # screenplay the user is looking at — same rule promotion applies.
            artifact = self.store.resolve_artifact(project_id, graph.output_hash("script"))
            if artifact is None:
                raise ValueError("the script has not finished generating yet")
            base = artifact.read_text(encoding="utf-8")
        return self.patch(
            project_id,
            [
                PatchOp(
                    op="set_params",
                    node_id="script",
                    params={"feedback": notes, "base_screenplay": base},
                )
            ],
        )

    def finalize(self, project_id: str, clip_model: str | None = None) -> int:
        """Draft → final ladder: re-render at target quality. When a final
        clip model is configured (e.g. Wan 2.2 on 16 GB tiers), unpinned
        clips switch to it — the ladder upgrades the model, not just steps."""
        with self._lock:
            graph = self.store.load_graph(project_id)
            if clip_model:
                before_cloud = self._cloud_models(graph)
                changed = False
                for node in graph.nodes.values():
                    if node.kind is NodeKind.CLIP and not node.pinned and node.model != clip_model:
                        node.model = clip_model
                        changed = True
                if changed:
                    # The ladder's model upgrade is itself a write that can
                    # put every clip on a cloud model, so it is refused
                    # before it lands, not after.
                    self._refuse_cloud_spend(
                        project_id, graph, quality="final", before=before_cloud
                    )
                    self.store.save_graph(project_id, graph)
            enqueued = self._enqueue_dirty(project_id, graph, quality="final")
            self._refresh_meta_locked(project_id, graph)
            return enqueued

    def delete(self, project_id: str) -> bool:
        """Remove the project and stop its in-flight work.

        Cancelling the queue rows is not enough on its own: the backend for a
        RENDERING job keeps writing into generated/ until it notices, so a
        bare rmtree either raises "Directory not empty" (leaving meta gone but
        multi-GB of artifacts behind) or loses a race with the render's next
        output_path() call, which re-creates the directory after deletion.
        Either orphan has no meta.json, so it never appears in the project
        list and is never counted by Settings → Storage — disk the user can
        neither see nor reclaim.

        So: rename the directory out of the way FIRST (atomic, and instantly
        invisible to the project list), then cancel, then remove the renamed
        copy with retries — and finally the skeleton a still-writing backend
        may have re-created under the ORIGINAL name, which is an orphan of
        exactly the kind described above (no meta.json, so invisible, so
        never reclaimed). sweep_pending_deletions catches anything that
        appears after this returns, on the next start.
        """
        with self._lock:
            project_dir = self.store.project_dir(project_id)
            if not project_dir.exists():
                return False
            doomed = self.store.reserve_for_deletion(project_id)
            self.queue.cancel_project(project_id)
        # Outside the lock: the sweep can take a moment on a large project,
        # and nothing else needs to wait for it.
        self.store.purge(doomed)
        self.store.purge_recreated(project_id)
        self.events.publish("project.deleted", project_id=project_id)
        return True

    def sweep_deleted(self) -> int:
        """Remove any directories a previous delete could not finish (the
        engine exited mid-sweep, or a backend held a file open). Called at
        startup; returns how many were reclaimed."""
        return self.store.sweep_pending_deletions()

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
            # Trusted: a mock placeholder screenplay must not become the
            # source for a real publish kit.
            cached = self._trusted_cache(project_id, history)
            memo = dict(self._frozen_pins(graph, history, cached))
            script_hash = graph.output_hash("script", memo)
            script_artifact = (
                self.store.resolve_artifact(project_id, script_hash)
                if script_hash in cached
                else None
            )
            if script_artifact is None:
                raise LookupError("script has not rendered yet")
            screenplay = Screenplay.model_validate_json(script_artifact.read_text(encoding="utf-8"))

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
            self._refuse_cloud_spend(project_id, graph)
            self.store.save_graph(project_id, graph)
            # Only the two nodes this route owns. Both are written from the
            # screenplay and take no upstream port, so this is the whole of
            # what a publish kit needs — and re-rendering the rest of the
            # project is not something "write me a title" may decide to do.
            self._enqueue_dirty(project_id, graph, only=("thumbnail", "metadata"))
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
            # Trusted: a mock placeholder EDL must never be handed to an NLE
            # as if it were the real cut.
            cached = self._trusted_cache(project_id, history)
            memo = dict(self._frozen_pins(graph, history, cached))
            timeline_hash = graph.output_hash("timeline", memo)
            edl_path = (
                self.store.resolve_artifact(project_id, timeline_hash)
                if timeline_hash in cached
                else None
            )
            if edl_path is None:
                raise LookupError("timeline is not rendered for the current edit")
            project = self.store.get(project_id)
            edl = json.loads(edl_path.read_text(encoding="utf-8"))
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

    def _trusted_cache(self, project_id: str, history: list[Job]) -> set[str]:
        """The project's cached hashes with placeholder output removed.

        Every consumer of the artifact cache has to go through here, not just
        the enqueue path: an artifact produced by a backend that has since
        been replaced (typically the mock, standing in while ffmpeg or the
        weights were missing) is exactly as wrong when export or package
        resolves it as when the compiler does. Filtering only on enqueue lets
        a placeholder be assembled into a real deliverable.
        """
        cached = self.store.cached_hashes(project_id)
        return cached - self._distrusted_hashes(history, cached)

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

    def _plan(
        self, project_id: str, graph: StoryGraph, history: list[Job], quality: str = "draft"
    ) -> CompiledPlan:
        """What rendering this graph would do right now, against the cache.

        Takes the job history rather than reading it, because `_enqueue_dirty`
        needs the same rows again afterwards and it is the one query here that
        is not free."""
        cached = self._trusted_cache(project_id, history)
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
        return compile_graph(graph, cached, quality=quality, frozen=frozen)

    @staticmethod
    def _billable(plan: CompiledPlan) -> list[str]:
        """The nodes in this plan that would bill the user's provider keys.
        The test is the exact prefix BackendRegistry.resolve routes on, so
        what this names is precisely what would reach a provider.

        Only what would render RIGHT NOW: `plan.jobs` deliberately excludes a
        node whose artifact is already cached, one whose scene is still
        blocked, and one that is pinned to a frozen artifact. That is the
        right answer for the queue and the wrong one for the write, which is
        why `_refuse_cloud_spend` also asks `_cloud_models` below.
        """
        return sorted(
            {spec.node_id for spec in plan.jobs if (spec.model or "").startswith(CLOUD_PREFIX)}
        )

    @staticmethod
    def _cloud_models(graph: StoryGraph) -> dict[str, str]:
        """Node id -> the `cloud:*` model sitting on it.

        The plan answers "what would bill if this rendered now"; this answers
        "what has the graph been pointed at", which is the question the write
        gate has to ask. `compile_graph` copies `node.model` onto the spec
        verbatim, so anything here bills the moment its node is planned.
        """
        return {
            node_id: node.model
            for node_id, node in graph.nodes.items()
            if (node.model or "").startswith(CLOUD_PREFIX)
        }

    @staticmethod
    def _refusal(billed: list[str], outcome: str) -> CloudSpendRefused:
        """One wording for the refusal, whichever render gate raised it.

        The message is the agent-facing contract for this 403 and it reaches
        a console through `automation.py`, so it is also ASCII-constrained.
        Three copies of it here is three places for that to drift; only the
        outcome clause differs, so only the outcome clause is a parameter.
        The `/edit` route spends on a text model rather than a render and so
        needs its own sentence - `cloud_text_refusal` above, which shares the
        tail this ends on.
        """
        return CloudSpendRefused(
            f"{', '.join(billed)} would render on a cloud model, and this caller may not "
            f"spend the user's provider keys - {outcome}. {_REFUSAL_TAIL}"
        )

    def _refuse_cloud_spend(
        self,
        project_id: str,
        graph: StoryGraph,
        quality: str = "draft",
        *,
        before: dict[str, str] | None = None,
    ) -> None:
        """Refuse BEFORE the mutation that would bill is written down.

        `_enqueue_dirty` enforces the same rule at the queue, which is where
        the money is committed - and that is still the backstop, because it
        covers paths that never come through here. But a mutating path that
        calls it AFTER `save_graph` hands a refused caller its 403 with the
        `cloud:*` model already persisted on the node. Nothing was queued,
        which is what the message says and is true; what it does not say is
        that the next render the USER starts from the app now spends. The
        guarantee is "an agent cannot CHOOSE cloud", and choosing is the
        write, not the queue - three client-side gates leaked in turn before
        the rule moved here, and this is the fourth shape of the same leak.

        Two questions, because the plan alone does not answer the guarantee.
        `before` is the caller's `_cloud_models` reading of the graph as it
        was on disk; anything cloud in the new graph that was not on that
        node before is a model this caller CHOSE, and is refused whether or
        not a render is planned for it right now. `plan.jobs` cannot see
        those: a node whose artifact is already cached is not in the plan at
        all, so `select_take` onto a take recorded on a cloud model - takes
        exist precisely because switching back is a cache hit - landed the
        model with nothing billable to report. So did `set_model` on a node
        inside a blocked scene's cone, which `unready_nodes` removes from
        every plan until someone writes the scene, and then bills.

        Callers that write no model pass no `before` (approve releases a
        checkpoint, package adds two model-less nodes) and are covered by the
        plan alone, which is also what keeps this from refusing more than the
        rule asks: a patch that touches an unrelated node in a project the
        USER put on a cloud model introduces nothing and is not refused.

        Costs nothing on the path that matters: the app declares no header,
        so `CLOUD_SPEND_ALLOWED` is true and this returns immediately. Nor on
        the agent path for a project with no cloud model anywhere, which is
        the common case even though the MCP client sends the deny header on
        EVERY request - only a graph that could actually bill pays for the
        second plan.
        """
        if CLOUD_SPEND_ALLOWED.get():
            return
        after = self._cloud_models(graph)
        if not after:
            return
        if before is not None:
            introduced = sorted(nid for nid, model in after.items() if before.get(nid) != model)
            if introduced:
                raise self._refusal(introduced, "nothing was changed")
        history = self.queue.list(project_id, 1000)
        billed = self._billable(self._plan(project_id, graph, history, quality))
        if billed:
            raise self._refusal(billed, "nothing was changed")

    def _refuse_new_graph_spend(self, graph: StoryGraph, cached: set[str] | None = None) -> None:
        """The same rule for a graph whose project is not on disk yet.

        `_refuse_cloud_spend` plans against a stored project's queue history
        and artifact cache; a create, a template import or a duplicate has
        neither under the id it is about to write, so the plan is compiled
        against the cache the new project will START with - empty for a
        fresh graph, the copied `generated/` for a duplicate. Without this
        the refusal lands after `store.create`, and a caller that may not
        spend is told "nothing was changed" while a fully-formed project
        carrying the author's cloud models sits in the user's list, one
        click from rendering.

        Pins are resolved here for the same reason `_plan` resolves them: a
        duplicate inherits `pinned`/`frozen_hash` and the frozen artifact
        travels in `generated/`, so `compile_graph` skips the node - but only
        when it is handed the `frozen` memo. Without it the pinned node
        re-hashes live, misses the copied cache, and every downstream hash
        misses with it, so the gate plans billable jobs the copy would never
        enqueue and refuses a duplicate that bills nobody. The gate must
        never compute a different plan from the enqueue it is guarding.
        """
        if CLOUD_SPEND_ALLOWED.get() or not self._cloud_models(graph):
            return
        cached = cached if cached is not None else set()
        # No job history under the new id, and none is needed: `_frozen_pins`
        # falls back to it only for graphs written before frozen_hash existed.
        frozen = self._frozen_pins(graph, [], cached)
        billed = self._billable(compile_graph(graph, cached, frozen=frozen))
        if billed:
            raise self._refusal(billed, "nothing was created")

    def _enqueue_dirty(
        self,
        project_id: str,
        graph: StoryGraph,
        quality: str = "draft",
        only: Collection[str] | None = None,
    ) -> int:
        history = self.queue.list(project_id, 1000)
        plan = self._plan(project_id, graph, history, quality)

        # A route that adds its own nodes queues those and nothing else.
        #
        # `_plan` always describes the WHOLE graph, which is right for every
        # caller that means "render this project" and wrong for `/package`,
        # which means "write me a title". On a graph that had drifted since
        # its last render — an edited scene, or a machine whose backends no
        # longer reproduce the cached hashes — opening the publish kit
        # re-rendered the project underneath the user, and an assembly that
        # then failed under those backends took the finished cut with it.
        #
        # Restricted here rather than at the call site because everything
        # below reads `plan.jobs`: the supersede sweep must not cancel work
        # for nodes this call is not responsible for, and the spend refusal
        # must judge what is actually being queued.
        if only is not None:
            plan = plan.model_copy(
                update={"jobs": [spec for spec in plan.jobs if spec.node_id in only]}
            )

        # Before anything is queued or superseded: a caller that may not
        # spend gets nothing enqueued at all, rather than a partial render
        # that stops at the first billable node. Callers that mutate state
        # first ask `_refuse_cloud_spend` before they persist anything; this
        # stays as the backstop for every path that does not.
        if not CLOUD_SPEND_ALLOWED.get():
            billed = self._billable(plan)
            if billed:
                raise self._refusal(billed, "nothing was queued")

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
        # That upgrade path must not run in reverse. Every caller but
        # `finalize` re-plans at draft, so a draft kept landing on a hash a
        # final owned — once from a clip finishing mid-finalize (a draft
        # queued alongside the still-running final), and once after the final
        # had already finished, when a slower upstream completed and
        # invalidated it downstream. Either way the draft ran last, the node
        # reported `draft`, and the project header offered "Create final
        # video" forever with no Download for the video it had just made.
        #
        # Quality is not in the hash, so the same address can only ever hold
        # one of the two: keep the final. Already in flight, and nothing to
        # rebuild -> the draft is redundant, drop it. Already delivered once
        # but the artifact has since been invalidated -> it does need
        # rebuilding, but at the quality it had, so promote rather than drop.
        finals_in_flight = {
            job.spec.output_hash
            for job in active_jobs
            if job.id not in superseded and job.spec.quality == "final"
        }
        finals_delivered = {
            job.spec.output_hash
            for job in history
            if job.spec.quality == "final" and job.status is JobStatus.DONE
        }
        project = self.store.get(project_id)
        enqueued = 0
        for spec in plan.jobs:
            if (spec.output_hash, spec.quality) in active:
                continue
            if spec.quality != "final":
                if spec.output_hash in finals_in_flight:
                    continue
                if spec.output_hash in finals_delivered:
                    spec = spec.model_copy(update={"quality": "final"})
                    if (spec.output_hash, "final") in active:
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
                # A tool session stays one node -- promotion is what expands
                # it -- but the meta still has to be refreshed, or the one
                # kind of session that never re-enters this function keeps
                # `updated_at` at its creation time and records no artifact,
                # so history sorts it wrong and calls a finished script
                # unfinished.
                with self._lock:
                    self._refresh_meta_locked(job.project_id)
                return
            with self._lock:
                graph = self.store.load_graph(job.project_id)
                # Refuse a screenplay the graph has already moved past.
                #
                # _enqueue_dirty cancels superseded jobs that are still
                # QUEUED, but deliberately lets a RENDERING one finish — its
                # output is meant to be merely unused. Without this check it
                # is not unused: it expands into the graph and enqueues a
                # full pipeline of keyframes and clips for a screenplay the
                # user already replaced, which is hours of GPU spent on
                # discarded content before the newer script even lands.
                if graph.output_hash("script") != job.spec.output_hash:
                    logger.info(
                        "discarding superseded script job %s for project %s",
                        job.id,
                        job.project_id,
                    )
                    return
                artifact = self.store.resolve_job_artifact(job.project_id, job.artifact)
                if artifact is None:
                    logger.warning("script job %s completed but its artifact is gone", job.id)
                    return
                screenplay = Screenplay.model_validate_json(artifact.read_text(encoding="utf-8"))
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
        history = self.queue.list(job.project_id, 1000)
        cached = self._trusted_cache(job.project_id, history)
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

    def _refresh_meta_locked(
        self, project_id: str, graph: StoryGraph | None = None, *, touch: bool = True
    ) -> None:
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
        if touch:
            project.updated_at = time.time()
        if graph is not None:
            history = self.queue.list(project_id, 1000)
            cached = self._trusted_cache(project_id, history)
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
            if project.mode.startswith("tool:"):
                project.tool_artifact_hash = self._tool_output(graph, project.mode, memo, cached)
                if thumb is None:
                    thumb = self._tool_still(graph, memo, cached)
            project.thumb_hash = thumb
            if duration > 0:
                project.duration_s = round(duration, 1)
        self.store.save_meta(project)

    @staticmethod
    def _tool_output(
        graph: StoryGraph, mode: str, memo: dict[str, str], cached: set[str]
    ) -> str | None:
        """The finished artifact of a quick tool session, or None.

        `tool_graph` names the session's terminal node for the tool itself,
        so the mode carries the node id: `tool:voiceover` -> `voiceover`. Only
        a hash that is actually cached counts, which is what makes this mean
        "produced something" rather than "was asked to".
        """
        node_id = mode.removeprefix("tool:")
        if node_id not in graph.nodes:
            return None
        out_hash = graph.output_hash(node_id, memo)
        return out_hash if out_hash in cached else None

    @staticmethod
    def _tool_still(graph: StoryGraph, memo: dict[str, str], cached: set[str]) -> str | None:
        """The rendered still a quick tool session can show on its tile.

        Tool graphs carry no scenes, so the `{scene}.keyframe` rule above
        never matches and every session -- image, voiceover, script alike --
        wore the same generic glyph. Only the two still-image kinds qualify:
        the clip tool contributes its conditioning keyframe, which is a frame
        of the video it produced, and the kinds that render audio or text
        contribute nothing rather than an artifact no <img> can decode.

        Node ids are walked in code-unit order so the choice is the same on
        every machine -- `keyframe` before a hypothetical later still, not
        whichever the dict happens to yield first.
        """
        for node_id in sorted(graph.nodes):
            if graph.nodes[node_id].kind not in (NodeKind.KEYFRAME, NodeKind.THUMBNAIL):
                continue
            still = graph.output_hash(node_id, memo)
            if still in cached:
                return still
        return None

    def backfill_tool_metas(self) -> int:
        """Fill in the quick-tool fields for sessions written by an older
        build, returning how many gained an artifact.

        `tool_artifact_hash` and a tool session's `thumb_hash` are only ever
        written by a meta refresh, and a refresh only happens on a WRITE. A
        session that finished before this build existed is never written
        again, so without this it would report "draft" behind a working
        download, and a generic glyph in place of the image it made, forever.
        History is made of precisely those old sessions.

        One pass at startup. A session that legitimately has no artifact is
        re-examined on each start -- a graph load apiece, and they are the
        minority -- which is cheaper and less brittle than persisting a
        "swept" marker that could itself fall out of date.
        """
        filled = 0
        for project in self.store.list():
            if not project.mode.startswith("tool:") or project.tool_artifact_hash:
                continue
            with self._lock:
                try:
                    self._refresh_meta_locked(project.id, touch=False)
                except (OSError, ValueError):
                    # One unreadable project must not stop the sweep, exactly
                    # as store.list() refuses to let one damaged meta take
                    # the whole listing down.
                    logger.warning("could not backfill tool meta for %s", project.id)
                    continue
                healed = self.store.get(project.id)
            if healed is not None and healed.tool_artifact_hash:
                filled += 1
        return filled

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
        recorded_takes = self.store.load_takes(project_id).takes
        history = self.queue.list(project_id, 1000)
        # Keyed by IDENTITY — (node, output hash) — not by node id alone. The
        # newest job for a node id can belong to an output the graph has since
        # moved past (edit, render, undo back onto the cached artifact), and
        # that job does not describe the node: reporting it left the tile
        # `failed` forever with a stale error and no job left to retry, and let
        # a `final` job for an abandoned hash label a cached DRAFT as final.
        # Keying by identity drops it *and* still finds the job that produced
        # what the node is asking for now — so undoing an edit does not demote
        # a finished `final` back to `draft` either. Quality is not part of the
        # hash, so a draft/final pair for one identity still collapses here,
        # newest winning.
        jobs = {(job.spec.node_id, job.spec.output_hash): job for job in reversed(history)}
        # Trusted: a placeholder must read as work still to do, not as a
        # finished draft the user can ship.
        cached = self._trusted_cache(project_id, history)
        # Frozen pins hash against their existing artifact (see compiler).
        memo: dict[str, str] = dict(self._frozen_pins(graph, history, cached))
        # The compiler skips these, so no job will ever exist for them. The
        # board has to agree, or the tile spins on "queued" forever waiting
        # for work that was deliberately never enqueued.
        skipped = orphaned_nodes(graph)
        # Same contract as `skipped`, different reason: the compiler enqueues
        # neither, so the board must not report either as `queued`.
        blocked = unready_nodes(graph)

        def node_state(node_id: str) -> dict | None:
            node = graph.nodes.get(node_id)
            if node is None:
                return None  # removed via patch — the card shows what's left
            out_hash = graph.output_hash(node_id, memo)
            # Only a job for the node's CURRENT identity describes it (see the
            # keying above).
            job = jobs.get((node_id, out_hash))
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
            elif node_id in skipped:
                # Deliberately not rendered — a scene conditioned on an
                # uploaded image rewires the clip's keyframe port to the
                # asset, leaving this node feeding nothing. Ranked below a
                # live job so a render already in flight when the user
                # conditioned the scene still reports itself honestly.
                status = "skipped"
            elif node_id in blocked:
                # Ranked below a live job for the same reason `skipped` is: a
                # render still in flight when the user cleared the prompt
                # reports itself honestly until it lands.
                status = "blocked"
            elif out_hash in cached:
                # A file the user supplied is not a draft of anything. "Draft"
                # promises a cheap first pass that a final render replaces,
                # and an asset is never rendered at all — it arrives finished
                # and stays exactly as it came in.
                asset = node.kind is NodeKind.ASSET
                status = "final" if asset or (job and job.spec.quality == "final") else "draft"
            else:
                status = "queued"
            state = {
                "node_id": node_id,
                "status": status,
                "progress": job.progress if job else 0.0,
                "error": job.error if job else None,
                # Non-fatal signals from the job that produced this output.
                # Advisory by design: when the job has aged out of history
                # the cached artifact stands and the notice is gone, the same
                # trade `error` already makes.
                "notices": [notice.model_dump() for notice in job.notices] if job else [],
                "artifact_hash": out_hash if out_hash in cached else None,
                # Transient params are omitted, not just unused: the desktop
                # polls this through every render, and base_screenplay is a
                # whole screenplay riding along each time.
                "params": {k: v for k, v in node.params.items() if k not in TRANSIENT_PARAMS},
                "seed": node.seed,
                # The advanced inspector edits these directly.
                "model": node.model,
                "pinned": node.pinned,
            }
            # Alternate takes a regenerate moved past (distinct from a split
            # scene's sequential clip_takes below). The node's live identity
            # is listed too, marked current, so a picker is one flat row.
            records = recorded_takes.get(node_id, [])
            if records:
                takes = [
                    {
                        "output_hash": r.output_hash,
                        "seed": r.seed,
                        # The model the take was rendered with. Selecting a
                        # take restores its whole identity, model included,
                        # so without this a picker cannot tell a client
                        # which takes put a cloud model back on the node -
                        # and the MCP surface has to refuse exactly those.
                        "model": r.model,
                        "at": r.at,
                        "available": r.output_hash in cached,
                        "current": r.output_hash == out_hash,
                    }
                    for r in records
                ]
                if not any(t["current"] for t in takes):
                    takes.append(
                        {
                            "output_hash": out_hash,
                            "seed": node.seed,
                            "model": node.model,
                            "at": None,
                            "available": out_hash in cached,
                            "current": True,
                        }
                    )
                state["takes"] = takes
            return state

        scenes = []
        raw_ids = {n.split(".")[0] for n in graph.nodes if "." in n and n.endswith(".clip")}
        scene_ids = sorted(raw_ids, key=scene_sort_key)

        def keyframe_source(sid: str) -> str | None:
            """The node actually feeding this scene's clip on the keyframe port.

            Normally the generated `{sid}.keyframe` — that is what the
            template wires up — but a scene conditioned on an uploaded image
            has the ASSET there instead, and the generated node is left
            orphaned. Reported as its own slot rather than by rewriting
            `keyframe`, because both nodes still matter and to different
            readers: the card draws the picture the clip will actually use,
            while the flowchart indexes node status out of these same slots
            and would otherwise lose the generated node's "not needed"
            entirely (see `orphaned_nodes` above, and NodeCanvas's
            statusIndex).
            """
            for edge in graph.inputs_of(f"{sid}.clip"):
                if edge.port == KEYFRAME_PORT:
                    return edge.src
            return None

        for sid in scene_ids:
            card = {
                "scene_id": sid,
                "keyframe": node_state(f"{sid}.keyframe"),
                "clip": node_state(f"{sid}.clip"),
                "narration": node_state(f"{sid}.narration"),
            }
            # Only when it is NOT the generated node: the board is polled
            # through every render, so the common case must not ship a second
            # copy of the state directly above it.
            source = keyframe_source(sid)
            if source is not None and source != f"{sid}.keyframe":
                card["still"] = node_state(source)
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
        # Whether this cut burns any titles. Answered here because overlays
        # are timeline PARAMS and the board sends node status, so the client
        # has no way to see them - and it needs to, since an ffmpeg without
        # drawtext (FFmpeg 7 static builds lacking libharfbuzz) fails the
        # export only after the whole ladder has re-rendered at final
        # quality. A boolean rather than the overlay map: the question the
        # UI asks is "will this need drawtext", not which scenes say what.
        timeline_node = graph.nodes.get("timeline")
        has_onscreen_text = bool(timeline_node and timeline_node.params.get("overlays"))
        return {
            "scenes": scenes,
            "aux": aux,
            "assembled_durations": assembled_durations,
            "has_onscreen_text": has_onscreen_text,
        }
