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
