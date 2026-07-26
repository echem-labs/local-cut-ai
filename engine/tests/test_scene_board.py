"""What the scene board reports for work that will never happen.

The compiler deliberately skips a node that feeds nothing — conditioning a
scene on an uploaded image rewires the clip's keyframe port to the asset, so
the generated keyframe becomes an input to nothing and is not enqueued. The
board did not know that, and its fallback for "no job, no artifact" is
`queued`: the tile spun forever, waiting on work nobody was ever going to
create.
"""

from localcut_engine.graph.model import Node, NodeKind
from localcut_engine.graph.patch import PatchOp, apply_patch
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import SCENE_NODE_STATUSES, ProjectService
from localcut_engine.events import EventBus


def _service(tmp_path) -> tuple[ProjectService, str]:
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)
    return service, project.id


def _keyframe(board: dict) -> dict:
    return board["scenes"][0]["keyframe"]


def test_a_generated_keyframe_starts_queued(tmp_path):
    service, project_id = _service(tmp_path)
    assert _keyframe(service.scene_board(project_id))["status"] == "queued"


def test_conditioning_a_scene_marks_its_keyframe_skipped(tmp_path):
    """The regression: this read `queued` forever."""
    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="asset-abc", port="keyframe")])
    service.store.save_graph(project_id, graph)

    assert _keyframe(service.scene_board(project_id))["status"] == "skipped"


def test_disconnecting_the_asset_puts_the_keyframe_back_to_work(tmp_path):
    """The status tracks the graph, not a one-way flag: freeing the port
    re-wires the generated keyframe, which is real work again."""
    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="asset-abc", port="keyframe")])
    service.store.save_graph(project_id, graph)
    assert _keyframe(service.scene_board(project_id))["status"] == "skipped"

    apply_patch(graph, [PatchOp(op="disconnect", node_id="s1.clip", port="keyframe")])
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
        ),
    )
    service.store.save_graph(project_id, graph)

    assert _keyframe(service.scene_board(project_id))["status"] == "queued"


def test_the_clip_itself_is_never_skipped(tmp_path):
    """A clip is the thing being made; it has no consumer either, and calling
    it orphaned would stop the whole scene rendering."""
    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="asset-abc", port="keyframe")])
    service.store.save_graph(project_id, graph)

    assert service.scene_board(project_id)["scenes"][0]["clip"]["status"] != "skipped"


def test_every_status_the_board_emits_is_declared(tmp_path):
    """SCENE_NODE_STATUSES is a wire contract the desktop mirrors; a status
    produced but not declared would reach the UI with no colour and no
    label."""
    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="asset-abc", port="keyframe")])
    service.store.save_graph(project_id, graph)

    board = service.scene_board(project_id)
    seen = set()
    for scene in board["scenes"]:
        for slot in ("keyframe", "clip", "narration"):
            if scene.get(slot):
                seen.add(scene[slot]["status"])
    for node in board["aux"].values():
        seen.add(node["status"])

    assert seen, "the board reported no nodes at all"
    assert seen <= set(SCENE_NODE_STATUSES), (
        f"undeclared: {sorted(seen - set(SCENE_NODE_STATUSES))}"
    )


def _put_job(service, project_id, node_id, out_hash, status, error=None, quality="draft"):
    """A history row for `node_id` claiming to have produced `out_hash`."""
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.jobs.models import Job

    job = Job(
        project_id=project_id,
        spec=JobSpec(
            node_id=node_id,
            kind=NodeKind.KEYFRAME,
            output_hash=out_hash,
            params={},
            model=None,
            seed=0,
            input_hashes={},
            quality=quality,
        ),
    )
    service.queue.put(job)
    job.status = status
    job.error = error
    service.queue.update(job)
    return job


def test_a_job_for_an_abandoned_hash_does_not_describe_the_node(tmp_path):
    """Edit a node, let the render fail, undo back onto the cached artifact.
    The newest job for that node id belongs to the identity the graph has
    since moved past — reporting it left the tile `failed` forever, with a
    stale error and no job left to retry, while `artifact_hash` simultaneously
    served a perfectly good artifact."""
    from localcut_engine.jobs.models import JobStatus

    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    current = graph.output_hash("s1.keyframe", {})

    # The artifact for the node's CURRENT identity exists and is cacheable.
    generated = service.store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{current}.keyframe.png").write_bytes(b"x")

    # …and a failed job survives for the hash the graph briefly had.
    _put_job(service, project_id, "s1.keyframe", "f" * 64, JobStatus.FAILED, error="boom")

    state = _keyframe(service.scene_board(project_id))
    assert state["status"] == "draft", state
    assert state["error"] is None
    assert state["artifact_hash"] == current


def test_a_job_for_the_current_hash_still_describes_the_node(tmp_path):
    """The identity check must not silence real state: a failure for the hash
    the graph is actually asking for is the node's status."""
    from localcut_engine.jobs.models import JobStatus

    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    current = graph.output_hash("s1.keyframe", {})
    _put_job(service, project_id, "s1.keyframe", current, JobStatus.FAILED, error="boom")

    state = _keyframe(service.scene_board(project_id))
    assert state["status"] == "failed"
    assert state["error"] == "boom"


def test_a_cached_draft_is_not_labelled_final_by_an_abandoned_job(tmp_path):
    """Quality is not part of the hash, so a `final` job for a DIFFERENT
    identity used to promote a cached draft's label to 'final' — a draft
    artifact presented as a finished render."""
    from localcut_engine.jobs.models import JobStatus

    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    current = graph.output_hash("s1.keyframe", {})
    generated = service.store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{current}.keyframe.png").write_bytes(b"x")

    _put_job(service, project_id, "s1.keyframe", "e" * 64, JobStatus.DONE, quality="final")

    assert _keyframe(service.scene_board(project_id))["status"] == "draft"


def test_an_abandoned_job_does_not_demote_the_final_that_matches(tmp_path):
    """The other half of the identity check, and the reason it cannot just
    drop the newest job and stop looking.

    Finalize a scene, edit it, let the re-render fail, undo back onto the
    finished artifact. The newest job for the node describes the abandoned
    hash — but a `final` job for the hash the node is asking for *now* is
    still in history, and it is the one that made the artifact. Discarding
    the whole node's history relabelled that finished render as a `draft`,
    inviting the user to pay for a final they had already run."""
    from localcut_engine.jobs.models import JobStatus

    service, project_id = _service(tmp_path)
    graph = service.store.load_graph(project_id)
    current = graph.output_hash("s1.keyframe", {})
    generated = service.store.generated_dir(project_id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{current}.keyframe.png").write_bytes(b"x")

    # The final that produced the cached artifact, then the failed re-render
    # of an edit the user has since undone.
    _put_job(service, project_id, "s1.keyframe", current, JobStatus.DONE, quality="final")
    _put_job(service, project_id, "s1.keyframe", "f" * 64, JobStatus.FAILED, error="boom")

    state = _keyframe(service.scene_board(project_id))
    assert state["status"] == "final", state
    assert state["error"] is None
    assert state["artifact_hash"] == current
