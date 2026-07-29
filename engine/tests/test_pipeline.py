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

    # Both halves of the link are recorded, so each side can name the other.
    assert promoted.promoted_from == tool.id
    assert store.get(tool.id).promoted_to == [promoted.id]
    assert store.get(promoted.id).promoted_from == tool.id


async def test_promoting_the_same_session_twice_records_both_videos(rig):
    """A script is worth more than one attempt, and promote_tool has never
    stopped a second run. A single `promoted_to` would let the newer video
    erase the older one's provenance, so the session keeps every id it
    produced, in the order it produced them."""
    store, queue, service = rig
    tool = service.create_tool("script", {"prompt": "octopus hearts"})
    await wait_for(
        lambda: any(
            j.spec.node_id == "script" and j.status is JobStatus.DONE
            for j in queue.list(tool.id, 10)
        )
    )
    first = service.promote_tool(tool.id)
    second = service.promote_tool(tool.id)

    assert first.id != second.id
    assert store.get(tool.id).promoted_to == [first.id, second.id]
    assert store.get(first.id).promoted_from == tool.id
    assert store.get(second.id).promoted_from == tool.id


async def test_promotion_provenance_survives_a_later_meta_refresh(rig):
    """The link lives in meta.json, which _refresh_meta_locked rewrites on
    every job completion. That path re-reads before it writes, so provenance
    has to come back out the other side -- otherwise the first keyframe to
    finish would quietly erase where the video came from."""
    store, queue, service = rig
    tool = service.create_tool("script", {"prompt": "octopus hearts"})
    await wait_for(
        lambda: any(
            j.spec.node_id == "script" and j.status is JobStatus.DONE
            for j in queue.list(tool.id, 10)
        )
    )
    promoted = service.promote_tool(tool.id)
    await wait_for(
        lambda: bool(service.scene_board(promoted.id)["aux"].get("export", {}).get("artifact_hash"))
    )
    assert store.get(promoted.id).promoted_from == tool.id
    assert store.get(tool.id).promoted_to == [promoted.id]


@pytest.mark.parametrize(
    ("tool", "node_id"),
    [("image", "image"), ("thumbnail", "thumbnail"), ("clip", "clip")],
)
async def test_a_tool_session_that_rendered_a_still_gets_a_thumbnail(rig, tool, node_id):
    """A tool session has no scenes, so the `{scene}.keyframe` rule finds
    nothing and its Home tile fell back to the generic tool glyph forever --
    a finished image looking exactly like a finished voiceover. The still it
    rendered itself is the thumbnail; the clip tool's is its conditioning
    keyframe, the one frame of the video that already exists as an image."""
    store, queue, service = rig
    session = service.create_tool(tool, {"prompt": "a lighthouse at dusk"})

    await wait_for(
        lambda: any(
            j.spec.node_id == node_id and j.status is JobStatus.DONE
            for j in queue.list(session.id, 10)
        )
    )
    meta = store.get(session.id)
    assert meta is not None
    assert meta.thumb_hash, f"{tool} session has no thumb_hash"
    # A hash the tile cannot fetch is the same blank tile with extra steps.
    assert store.resolve_artifact(session.id, meta.thumb_hash) is not None


@pytest.mark.parametrize("tool", ["script", "thumbnail", "voiceover", "image", "music", "clip"])
async def test_a_finished_tool_session_records_its_artifact_on_the_meta(rig, tool):
    """Whether a session finished has to be answerable from meta.json alone.

    The desktop derives it from `GET /jobs`, which returns the newest 200 job
    rows across ALL projects -- so a session's own rows age out behind a
    couple of full renders and its tile falls back to "Draft" while its
    download link still works. Job history is the wrong place to ask a
    question about a project that is arbitrarily old.
    """
    store, queue, service = rig
    params = {"text": "one small step"} if tool == "voiceover" else {"prompt": "a lighthouse"}
    session = service.create_tool(tool, params)
    node_id = tool

    await wait_for(
        lambda: any(
            j.spec.node_id == node_id and j.status is JobStatus.DONE
            for j in queue.list(session.id, 10)
        )
    )
    meta = store.get(session.id)
    assert meta is not None
    assert meta.tool_artifact_hash, f"{tool} session recorded no artifact"
    assert store.resolve_artifact(session.id, meta.tool_artifact_hash) is not None


async def test_an_unfinished_tool_session_records_no_artifact(rig):
    """The field means "this produced something", so it must stay empty
    until that is true -- otherwise the tile calls a session ready before
    there is anything to download."""
    store, _queue, service = rig
    session = service.create_tool("image", {"prompt": "a lighthouse"})
    # Read before the scheduler can finish it: created_at is stamped by
    # create_tool, and meta is written there too.
    meta = store.get(session.id)
    assert meta is not None and meta.tool_artifact_hash is None


async def test_a_tool_session_with_no_still_keeps_its_glyph(rig):
    """The other half: voiceover/music/script render no image, so there is
    nothing to point thumb_hash at. It must stay None rather than borrow
    some unrelated artifact the tile would fail to decode."""
    store, queue, service = rig
    session = service.create_tool("voiceover", {"text": "one small step"})

    await wait_for(
        lambda: any(
            j.spec.node_id == "voiceover" and j.status is JobStatus.DONE
            for j in queue.list(session.id, 10)
        )
    )
    meta = store.get(session.id)
    assert meta is not None and meta.thumb_hash is None


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
    assert queue.claim_next().id == first.id
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
    path.write_text(json.dumps({"duration": 123.4, "video": [{"scene": "s1", "duration": 41.5}]}))
    service.patch(project.id, [])  # meta refresh path
    assert store.get(project.id).duration_s == 123.4
    # The board carries the per-scene actuals so the timeline strip can
    # agree with the assembled cut it plays.
    assert service.scene_board(project.id)["assembled_durations"] == {"s1": 41.5}


async def test_narration_edit_syncs_caption_texts(rig):
    """Captions anchor to the narration text — a patched narration must
    refresh the captions node's ground truth, or the exported captions
    would verbatim contradict the re-rendered audio."""
    store, queue, service = rig
    project = service.create_from_prompt("the secret life of tide pools", target_duration_s=24)
    await wait_for(lambda: bool(service.scene_board(project.id)["scenes"]))

    service.patch(
        project.id,
        [
            PatchOp(
                op="set_params",
                node_id="s1.narration",
                params={"text": "Our sun is a star.", "voice": "narrator"},
            )
        ],
    )
    graph = store.load_graph(project.id)
    assert graph.nodes["captions"].params["texts"]["s1"] == "Our sun is a star."


async def test_natural_language_edit_syncs_caption_texts(rig):
    """The NL edit box rewrites narration through a different entry point
    than patch(); captions must follow the new words there too, or the
    burned-in text contradicts what the voice says."""
    from localcut_engine.graph.editor import Edit, EditPlan

    store, queue, service = rig
    project = service.create_from_prompt("the secret life of tide pools", target_duration_s=24)
    await wait_for(lambda: bool(service.scene_board(project.id)["scenes"]))

    result = service.apply_edit_plan(
        project.id,
        EditPlan(
            summary="fix the line",
            edits=[
                Edit(action="update", node_id="s1.narration", params={"text": "Our sun is a star."})
            ],
        ),
        scope="project",
    )
    graph = store.load_graph(project.id)
    assert graph.nodes["s1.narration"].params["text"] == "Our sun is a star."
    assert graph.nodes["captions"].params["texts"]["s1"] == "Our sun is a star."
    assert "captions" in result["dirty"]


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


def test_requeue_moves_a_job_to_the_back_of_the_fifo(tmp_path):
    """The scheduler re-stamps a job whose inputs aren't ready yet so the
    producer can run first. claim_next orders by the created_at COLUMN, so
    the upsert has to carry it — otherwise the same job is re-selected
    forever, and that requeue path has no await: the run loop spins and
    starves the event loop for the whole process."""
    from conftest import make_spec
    from localcut_engine.graph.model import NodeKind
    from localcut_engine.jobs.models import Job, JobStatus

    queue = JobQueue(tmp_path / "queue.db")
    waiting = queue.put(
        Job(project_id="p", spec=make_spec(NodeKind.EXPORT, output_hash="e" * 64), created_at=1.0)
    )
    producer = queue.put(
        Job(project_id="p", spec=make_spec(NodeKind.TIMELINE, output_hash="t" * 64), created_at=2.0)
    )
    claimed = queue.claim_next()
    assert claimed.id == waiting.id

    waiting.created_at = 3.0  # what the scheduler does when inputs are missing
    waiting.status = JobStatus.QUEUED
    queue.update(waiting)
    assert queue.claim_next().id == producer.id


async def test_healing_never_deletes_a_pinned_artifact(rig):
    """Healing an optional-input consumer must skip pinned nodes.

    A pin resolves through its frozen_hash, so deleting the artifact stored
    under that hash does not merely "refresh" the node — it destroys the
    only copy the pin points at, the pin then stops resolving, and the node
    re-renders. That is the exact opposite of what the user asked for.
    """
    from localcut_engine.graph.model import CAPTIONS_PORT

    store, queue, service = rig
    project = service.create_from_prompt("tide pools at dusk", target_duration_s=24)

    def export_hash():
        return service.scene_board(project.id)["aux"].get("export", {}).get("artifact_hash")

    await wait_for(lambda: bool(export_hash()))

    graph = store.load_graph(project.id)
    assert any(e.port == CAPTIONS_PORT and e.dst == "export" for e in graph.edges), (
        "fixture assumption: captions feeds export through the optional port"
    )

    service.patch(project.id, [PatchOp(op="pin", node_id="export")])
    graph = store.load_graph(project.id)
    frozen = graph.nodes["export"].frozen_hash
    assert frozen and frozen in store.cached_hashes(project.id)
    before = sorted(p.name for p in store.generated_dir(project.id).iterdir())

    # A captions job completing is what triggers the heal for `export`. Use
    # the real one the scheduler ran, not a hand-built stand-in.
    captions_job = next(j for j in queue.list(project.id, 1000) if j.spec.node_id == "captions")
    service._heal_optional_consumers(captions_job)

    assert frozen in store.cached_hashes(project.id), "healing deleted the pinned artifact"
    assert sorted(p.name for p in store.generated_dir(project.id).iterdir()) == before


async def test_edit_plan_with_no_ops_still_persists_a_caption_resync(rig):
    """The caption resync can dirty the graph on its own. Enqueueing work
    derived from a graph that was never saved would render under a hash the
    stored graph can never recompute — so the render is orphaned and the
    work re-enqueues forever."""
    from localcut_engine.graph.editor import EditPlan

    store, queue, service = rig
    project = service.create_from_prompt("kelp forests", target_duration_s=24)
    await wait_for(lambda: "captions" in store.load_graph(project.id).nodes)

    # Drift the ground truth, the way a graph written by an older sync would.
    graph = store.load_graph(project.id)
    graph.nodes["captions"].params["texts"] = {}
    store.save_graph(project.id, graph)
    expected = {
        node_id.removesuffix(".narration"): str(node.params.get("text", ""))
        for node_id, node in graph.nodes.items()
        if node_id.endswith(".narration")
    }
    assert expected, "fixture assumption: the project has narration nodes"

    # A plan that compiles to nothing: every edit names a node that isn't there.
    plan = EditPlan.model_validate(
        {
            "summary": "",
            "edits": [{"action": "update", "node_id": "nope", "params": {"text": "x"}}],
        }
    )
    result = service.apply_edit_plan(project.id, plan, scope="script")
    assert result["ops"] == 0

    assert store.load_graph(project.id).nodes["captions"].params["texts"] == expected


async def test_backfill_repairs_tool_metas_written_by_an_older_build(rig):
    """The quick-tool meta fields are only ever written by a REFRESH, and a
    refresh only happens on a write. A session that finished before this
    build existed is never written again, so it would keep reporting "draft"
    and a generic glyph forever -- and history is made of exactly those old
    sessions, so the feature would miss the population it is for."""
    store, queue, service = rig
    session = service.create_tool("image", {"prompt": "a lighthouse"})
    await wait_for(
        lambda: any(
            j.spec.node_id == "image" and j.status is JobStatus.DONE
            for j in queue.list(session.id, 10)
        )
    )
    video = service.create_from_prompt("tide pools", target_duration_s=24)

    # A meta as an older build left it: neither field had been invented.
    stale = store.get(session.id)
    was_updated_at = stale.updated_at
    stale.tool_artifact_hash = None
    stale.thumb_hash = None
    store.save_meta(stale)

    assert service.backfill_tool_metas() == 1
    healed = store.get(session.id)
    assert healed.tool_artifact_hash
    assert healed.thumb_hash
    assert store.resolve_artifact(session.id, healed.tool_artifact_hash) is not None

    # A repair is not activity. Stamping updated_at here would jump every
    # old session to "just now" on the first launch after upgrading, which
    # is precisely the ordering the history list is sorted by.
    assert healed.updated_at == was_updated_at
    # Idempotent, and it leaves real projects alone.
    assert service.backfill_tool_metas() == 0
    assert store.get(video.id).tool_artifact_hash is None
