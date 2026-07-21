"""End-to-end on the mock backend: one prompt → script → expanded graph →
all scene/audio/assembly jobs done → export artifact exists. This is the
Phase-0 spine minus real models.
"""

import asyncio

import pytest

from localcut_engine.backends.base import BackendRegistry
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.patch import PatchOp
from localcut_engine.jobs.models import JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService


@pytest.fixture
async def rig(tmp_path):
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)
    backends = BackendRegistry()
    backends.register(MockBackend())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=events,
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
        on_job_done=service.on_job_done,
    )
    service.scheduler = scheduler
    scheduler.start()
    yield store, queue, service
    await scheduler.stop()


async def wait_for(predicate, timeout=15.0, interval=0.05):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(interval)


async def test_prompt_to_export(rig):
    store, queue, service = rig
    project = service.create_from_prompt("the secret life of tide pools", target_duration_s=24)

    def export_done() -> bool:
        board = service.scene_board(project.id)
        export = board["aux"].get("export")
        return bool(export and export["artifact_hash"])

    await wait_for(export_done)

    board = service.scene_board(project.id)
    assert board["scenes"], "screenplay expansion produced no scenes"
    for scene in board["scenes"]:
        assert scene["clip"]["status"] in ("draft", "final")
        assert scene["keyframe"]["artifact_hash"]
    assert not [j for j in queue.list(project.id) if j.status is JobStatus.FAILED]

    export_hash = board["aux"]["export"]["artifact_hash"]
    assert store.resolve_artifact(project.id, export_hash).exists()


async def test_regenerate_only_dirties_one_scene(rig):
    store, queue, service = rig
    project = service.create_from_prompt("desert wildlife at night", target_duration_s=24)

    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    jobs_before = len(queue.list(project.id, 1000))

    board = service.scene_board(project.id)
    first_scene = board["scenes"][0]["scene_id"]
    service.regenerate(project.id, f"{first_scene}.clip")

    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    new_jobs = queue.list(project.id, 1000)[: len(queue.list(project.id, 1000)) - jobs_before]
    new_node_ids = {j.spec.node_id for j in new_jobs}
    # Only the regenerated clip + downstream assembly re-ran; other scenes cached.
    assert f"{first_scene}.clip" in new_node_ids
    assert not any(n.endswith(".keyframe") for n in new_node_ids)
    other_clips = {f"{s['scene_id']}.clip" for s in board["scenes"] if s["scene_id"] != first_scene}
    assert not (new_node_ids & other_clips)


async def test_finalize_enqueues_over_active_draft(tmp_path):
    """Quality is excluded from the content hash, so the in-flight dedupe
    must key on (hash, quality) — or finalize silently ships drafts."""
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)  # no scheduler: jobs stay queued
    project = service.create_from_prompt("tide pools", target_duration_s=24)

    assert len(queue.list(project.id, 100)) == 1  # draft script queued
    assert service.finalize(project.id) == 1  # final not deduped away by the draft
    qualities = {(j.spec.node_id, j.spec.quality) for j in queue.list(project.id, 100)}
    assert qualities == {("script", "draft"), ("script", "final")}
    # Same-quality re-enqueue is still deduped.
    graph = store.load_graph(project.id)
    assert service._enqueue_dirty(project.id, graph) == 0


async def test_cancel_project_stops_inflight_jobs(tmp_path):
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)  # no scheduler: jobs stay queued
    p1 = service.create_from_prompt("one")
    p2 = service.create_from_prompt("two")

    assert service.delete(p1.id)
    assert store.get(p1.id) is None
    assert all(j.status is JobStatus.CANCELLED for j in queue.list(p1.id, 100))
    assert all(j.status is JobStatus.QUEUED for j in queue.list(p2.id, 100))


async def test_script_regenerate_applies_new_screenplay(rig):
    """The re-run's screenplay must land in the scene nodes — not re-render
    the old content while the new script is discarded."""
    store, queue, service = rig
    project = service.create_from_prompt("tide pools at noon", target_duration_s=24)

    def export_hash():
        return service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")

    await wait_for(lambda: bool(export_hash()))
    board = service.scene_board(project.id)
    old_text = board["scenes"][0]["narration"]["params"]["text"]

    # A new prompt yields a different mock screenplay on the script re-run.
    service.patch(
        project.id,
        [PatchOp(op="set_params", node_id="script", params={"prompt": "volcanoes at dawn"})],
    )
    await wait_for(
        lambda: (
            service.scene_board(project.id)["scenes"][0]["narration"]["params"]["text"] != old_text
        )
    )
    board = service.scene_board(project.id)
    assert "volcanoes at dawn" in board["scenes"][0]["narration"]["params"]["text"]


async def test_script_tool_promotes_to_full_project(rig):
    """Quick Tool session → full project: the generated screenplay seeds the
    new project's script node as a cached artifact (no LLM re-run)."""
    store, queue, service = rig
    tool = service.create_tool("script", {"prompt": "octopus hearts", "aspect": "9:16"})
    assert tool.mode == "tool:script"

    await wait_for(
        lambda: any(
            j.spec.node_id == "script" and j.status is JobStatus.DONE
            for j in queue.list(tool.id, 10)
        )
    )
    promoted = service.promote_tool(tool.id)
    assert promoted.id != tool.id and promoted.mode == "prompt"

    await wait_for(
        lambda: bool(service.scene_board(promoted.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    # The script arrived pre-cached: the promoted project never ran an LLM job.
    assert not [j for j in queue.list(promoted.id, 1000) if j.spec.node_id == "script"]
    assert service.scene_board(promoted.id)["scenes"]


async def test_beginner_mode_gates_stages_until_approved(rig):
    store, queue, service = rig
    project = service.create_from_prompt(
        "volcano documentary", target_duration_s=24, mode="beginner"
    )

    def kinds_run() -> set[str]:
        return {j.spec.kind.value for j in queue.list(project.id, 1000)}

    # Script runs and expands, but nothing past the first checkpoint.
    await wait_for(lambda: "script" in kinds_run())
    await wait_for(lambda: bool(service.scene_board(project.id)["scenes"]))
    assert kinds_run() == {"script"}

    service.approve(project.id, "script")
    await wait_for(lambda: "keyframe" in kinds_run() and "narration" in kinds_run())
    assert "clip" not in kinds_run()  # storyboard not approved yet

    service.approve(project.id, "storyboard")
    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    assert store.get(project.id).approvals == ["script", "storyboard"]


async def test_queue_recovers_interrupted_jobs(tmp_path):
    queue = JobQueue(tmp_path / "q.db")
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    job = Job(
        project_id="p1",
        spec=JobSpec(
            node_id="n1",
            kind=NodeKind.CLIP,
            output_hash="abc",
            params={},
            model=None,
            seed=0,
            input_hashes={},
        ),
        status=JobStatus.RENDERING,
    )
    queue.put(job)
    queue.close()

    recovered = JobQueue(tmp_path / "q.db")
    assert recovered.get(job.id).status is JobStatus.QUEUED
    recovered.close()


async def test_pin_freezes_output_across_upstream_edits(rig):
    """Pin semantics: an upstream edit re-renders everything except pinned
    nodes, and downstream jobs consume the pinned node's frozen artifact."""
    from localcut_engine.graph.patch import PatchOp

    store, queue, service = rig
    project = service.create_from_prompt("coral reefs after dark", target_duration_s=24)

    def export_hash():
        return service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")

    await wait_for(lambda: bool(export_hash()))
    board = service.scene_board(project.id)
    frozen_kf = board["scenes"][0]["keyframe"]["artifact_hash"]
    kf_jobs_before = len(
        [j for j in queue.list(project.id, 1000) if j.spec.node_id == "s1.keyframe"]
    )

    service.patch(project.id, [PatchOp(op="pin", node_id="s1.keyframe")])
    first_export = export_hash()
    service.patch(
        project.id,
        [PatchOp(op="set_params", node_id="script", params={"style_preset": "noir"})],
    )
    await wait_for(lambda: export_hash() not in (None, first_export))

    board = service.scene_board(project.id)
    kf_jobs_after = len(
        [j for j in queue.list(project.id, 1000) if j.spec.node_id == "s1.keyframe"]
    )
    assert kf_jobs_after == kf_jobs_before, "pinned keyframe re-rendered"
    assert board["scenes"][0]["keyframe"]["artifact_hash"] == frozen_kf
    # The clip downstream of the pin re-rendered and still completed, i.e.
    # it resolved its keyframe input to the frozen artifact.
    assert board["scenes"][0]["clip"]["status"] in ("draft", "final")
    assert not [j for j in queue.list(project.id, 1000) if j.status is JobStatus.FAILED]


async def test_package_generates_thumbnail_and_publish_kit(rig):
    """POST-style packaging: thumbnail + title/description/hashtags join the
    graph as nodes and render like everything else."""
    import json as jsonlib

    store, queue, service = rig
    project = service.create_from_prompt("northern lights explained", target_duration_s=12)
    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    assert set(service.package(project.id)) == {"thumbnail", "metadata"}

    def packaged() -> bool:
        aux = service.scene_board(project.id)["aux"]
        return all((aux.get(n) or {}).get("artifact_hash") for n in ("thumbnail", "metadata"))

    await wait_for(packaged)
    aux = service.scene_board(project.id)["aux"]
    kit_path = store.resolve_artifact(project.id, aux["metadata"]["artifact_hash"])
    kit = jsonlib.loads(kit_path.read_text())
    assert {"title", "description", "hashtags"} <= set(kit)
    thumb = store.resolve_artifact(project.id, aux["thumbnail"]["artifact_hash"])
    assert thumb.suffix == ".png"
    # The publish-kit script job must not have re-expanded the graph.
    assert "s1.clip" in store.load_graph(project.id).nodes
    # Idempotent: a second package call reuses the same nodes.
    service.package(project.id)
    assert len([n for n in store.load_graph(project.id).nodes if n == "thumbnail"]) == 1


async def test_package_thumbnail_runs_after_script_approval_in_beginner_mode(rig):
    """Packaging is script-derived: once the script checkpoint passes, the
    thumbnail must render without waiting for the storyboard gate — it used
    to be silently dropped."""
    store, queue, service = rig
    project = service.create_from_prompt("city gardens", target_duration_s=12, mode="beginner")
    await wait_for(
        lambda: any(
            j.spec.node_id == "script" and j.status is JobStatus.DONE
            for j in queue.list(project.id, 100)
        )
    )
    service.approve(project.id, "script")
    service.package(project.id)

    def thumbnail_done() -> bool:
        aux = service.scene_board(project.id)["aux"]
        return bool((aux.get("thumbnail") or {}).get("artifact_hash"))

    await wait_for(thumbnail_done)
    # The storyboard gate still holds for scene clips.
    assert not any(j.spec.node_id.endswith(".clip") for j in queue.list(project.id, 1000))


async def test_finalize_upgrades_unpinned_clip_models(rig):
    """The final ladder can switch the clip *model* (LTX drafts → Wan
    finals); pinned clips keep the identity of their approved artifact."""
    from localcut_engine.graph.patch import PatchOp

    store, queue, service = rig
    project = service.create_from_prompt("glaciers in motion", target_duration_s=12)
    await wait_for(
        lambda: bool(service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    scene_ids = [s["scene_id"] for s in service.scene_board(project.id)["scenes"]]
    pinned_clip = f"{scene_ids[-1]}.clip"
    service.patch(project.id, [PatchOp(op="pin", node_id=pinned_clip)])

    enqueued = service.finalize(project.id, "local:wan2.2-i2v-14b-fp8")
    assert enqueued > 0
    graph = store.load_graph(project.id)
    assert graph.nodes[f"{scene_ids[0]}.clip"].model == "local:wan2.2-i2v-14b-fp8"
    assert graph.nodes[pinned_clip].model is None  # pinned = untouched

    def all_final() -> bool:
        board = service.scene_board(project.id)
        return all(s["clip"]["status"] in ("final", "pinned") for s in board["scenes"]) and not [
            j for j in queue.list(project.id, 1000) if j.status is JobStatus.FAILED
        ]

    await wait_for(all_final)


def test_update_unless_cancelled_never_resurrects_a_cancel(tmp_path):
    """Once a job row is CANCELLED, a scheduler status persist must be refused,
    not write it back to a running/done state — the guard has to be atomic
    because project deletion cancels jobs from a worker thread."""
    from conftest import make_spec

    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    queue = JobQueue(tmp_path / "q.db")
    job = Job(project_id="p", spec=make_spec(NodeKind.CLIP))
    queue.put(job)

    # Still queued: a running persist is allowed.
    job.status = JobStatus.RENDERING
    assert queue.update_unless_cancelled(job) is True
    assert queue.get(job.id).status is JobStatus.RENDERING

    # The user (or a project delete on another thread) cancels it.
    assert queue.cancel(job.id) is True

    # A late progress/DONE persist is refused and leaves CANCELLED intact.
    job.status = JobStatus.DONE
    assert queue.update_unless_cancelled(job) is False
    assert queue.get(job.id).status is JobStatus.CANCELLED


def test_cancel_refuses_a_job_that_already_finished(tmp_path):
    """The atomic cancel must not cancel a job that already reached a terminal
    state — a completed render outranks a late cancel, in either arrival order."""
    from conftest import make_spec

    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    queue = JobQueue(tmp_path / "q.db")
    job = Job(project_id="p", spec=make_spec(NodeKind.CLIP))
    queue.put(job)
    job.status = JobStatus.DONE
    queue.update(job)
    assert queue.cancel(job.id) is False  # DONE is terminal — not cancellable
    assert queue.get(job.id).status is JobStatus.DONE


def test_cancel_project_cancels_only_in_flight_jobs(tmp_path):
    """cancel_project marks every queued/rendering job of the project CANCELLED
    and leaves terminal jobs and other projects untouched; a later scheduler
    persist for a cancelled job is then refused."""
    from conftest import make_spec

    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    queue = JobQueue(tmp_path / "q.db")
    rendering = Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="a" * 64))
    queue.put(rendering)
    rendering.status = JobStatus.RENDERING
    queue.update(rendering)
    done = Job(project_id="p", spec=make_spec(NodeKind.CLIP, output_hash="b" * 64))
    queue.put(done)
    done.status = JobStatus.DONE
    queue.update(done)
    other = Job(project_id="q", spec=make_spec(NodeKind.CLIP, output_hash="c" * 64))
    queue.put(other)  # different project — must stay untouched

    assert queue.cancel_project("p") == 1  # only the in-flight (rendering) job
    assert queue.get(rendering.id).status is JobStatus.CANCELLED
    assert queue.get(done.id).status is JobStatus.DONE  # terminal, not re-cancelled
    assert queue.get(other.id).status is JobStatus.QUEUED  # other project untouched

    rendering.status = JobStatus.DONE
    assert queue.update_unless_cancelled(rendering) is False
    assert queue.get(rendering.id).status is JobStatus.CANCELLED


async def test_fifo_survives_equal_timestamps(tmp_path):
    """created_at is a float clock read and tight enqueue loops can produce
    ties — pops must still follow insertion (= topological) order."""
    from conftest import make_spec

    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    queue = JobQueue(tmp_path / "q.db")
    stamp = 1_000_000.0
    first = Job(
        project_id="p1",
        spec=make_spec(NodeKind.KEYFRAME, node_id="s1.keyframe", output_hash="b" * 64),
        created_at=stamp,
    )
    second = Job(
        project_id="p1",
        spec=make_spec(NodeKind.CLIP, node_id="s1.clip", output_hash="c" * 64),
        created_at=stamp,
    )
    queue.put(first)
    queue.put(second)
    assert queue.next_queued().id == first.id
    queue.close()


async def test_consumer_requeues_behind_inflight_producer(tmp_path):
    """A consumer popped before its producer (an ordering hiccup) goes back
    to QUEUED while the producer is still in flight — and only fails once
    nothing active can produce the missing artifact."""
    from conftest import make_spec

    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job

    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    backends = BackendRegistry()
    backends.register(MockBackend())
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=events,
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
    )

    kf_hash = "b" * 64
    producer = Job(
        project_id="p1",
        spec=make_spec(NodeKind.KEYFRAME, node_id="s1.keyframe", output_hash=kf_hash),
    )
    consumer = Job(
        project_id="p1",
        spec=make_spec(
            NodeKind.CLIP,
            node_id="s1.clip",
            output_hash="c" * 64,
            input_hashes={"keyframe": kf_hash},
        ),
    )
    queue.put(producer)
    queue.put(consumer)

    await scheduler._execute(consumer)
    assert queue.get(consumer.id).status is JobStatus.QUEUED

    # Producer failed → the same gap is now a real dead end.
    producer.status = JobStatus.FAILED
    queue.put(producer)
    await scheduler._execute(consumer)
    failed = queue.get(consumer.id)
    assert failed.status is JobStatus.FAILED
    assert "missing upstream artifacts" in (failed.error or "")
    queue.close()


async def test_meta_duration_prefers_assembled_timeline(rig):
    """The Home-grid duration badge must match the assembled cut, not the
    screenplay's planned sum — narration timing stretches scenes at
    assembly, so the two can disagree by many seconds."""
    import json

    store, queue, service = rig
    project = service.create_from_prompt("cut length authority", target_duration_s=24)

    def timeline_done() -> bool:
        board = service.scene_board(project.id)
        timeline = board["aux"].get("timeline")
        return bool(timeline and timeline["artifact_hash"])

    await wait_for(timeline_done)

    board = service.scene_board(project.id)
    path = store.resolve_artifact(project.id, board["aux"]["timeline"]["artifact_hash"])
    path.write_text(
        json.dumps({"duration": 123.4, "video": [{"scene": "s1", "duration": 41.5}]})
    )
    service.patch(project.id, [])  # meta refresh path
    assert store.get(project.id).duration_s == 123.4
    # The board carries the per-scene actuals so the timeline strip can
    # agree with the assembled cut it plays.
    assert service.scene_board(project.id)["assembled_durations"] == {"s1": 41.5}


async def test_replan_supersedes_stale_queued_jobs(tmp_path):
    """A seed bump re-plans a node under a new hash; the previously queued
    job for that node is garbage — cancel it instead of letting it render
    an artifact nothing references (or fail against missing inputs)."""
    events = EventBus()
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, events)  # no scheduler: jobs stay queued
    project = service.create_from_prompt("city timelapse")

    first = queue.list(project.id, 100)
    assert [j.spec.node_id for j in first] == ["script"]
    service.regenerate(project.id, "script")

    jobs = queue.list(project.id, 100)
    queued = [j for j in jobs if j.status is JobStatus.QUEUED]
    cancelled = [j for j in jobs if j.status is JobStatus.CANCELLED]
    assert len(queued) == 1 and queued[0].spec.node_id == "script"
    assert queued[0].spec.output_hash != first[0].spec.output_hash
    assert [j.id for j in cancelled] == [first[0].id]
