"""Alternate takes. Regenerate used to overwrite a node's identity in
place: the displaced artifact stayed on disk (content-addressed) but
nothing referenced it, so "the previous take" was unreachable one click
after it existed. Now the displaced identity is recorded in takes.json and
select_take swaps it back — a metadata operation that resolves to the
artifact already in generated/, never a re-render.
"""

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.model import Node, NodeKind
from localcut_engine.graph.patch import PatchOp, apply_patch
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import TAKE_LIMIT, ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


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


def _clip_state(service: ProjectService, project_id: str) -> dict:
    return service.scene_board(project_id)["scenes"][0]["clip"]


def test_regenerate_keeps_the_displaced_identity_selectable(tmp_path):
    service, pid = _service(tmp_path)
    old_hash = service.store.load_graph(pid).output_hash("s1.clip")

    service.regenerate(pid, "s1.clip")

    records = service.store.load_takes(pid).takes["s1.clip"]
    assert [r.output_hash for r in records] == [old_hash]
    takes = _clip_state(service, pid)["takes"]
    assert len(takes) == 2  # the record plus the live identity
    (current,) = [t for t in takes if t["current"]]
    assert current["output_hash"] != old_hash


def test_selecting_a_take_lands_on_its_cached_artifact(tmp_path):
    service, pid = _service(tmp_path)
    graph = service.store.load_graph(pid)
    old_hash = graph.output_hash("s1.clip")
    old_seed = graph.nodes["s1.clip"].seed
    service.store.generated_dir(pid).mkdir(parents=True, exist_ok=True)
    (service.store.generated_dir(pid) / f"{old_hash}.mp4").write_bytes(b"clip")

    service.regenerate(pid, "s1.clip")
    dirty = service.patch(pid, [PatchOp(op="select_take", node_id="s1.clip", take=old_hash)])

    assert "s1.clip" in dirty
    graph = service.store.load_graph(pid)
    assert graph.nodes["s1.clip"].seed == old_seed
    assert graph.output_hash("s1.clip") == old_hash
    # The artifact was on disk under that hash, so the take is served from
    # cache: the board reads it as a finished draft, not queued work.
    assert _clip_state(service, pid)["status"] == "draft"


def test_switching_takes_is_a_round_trip(tmp_path):
    service, pid = _service(tmp_path)
    first = service.store.load_graph(pid).output_hash("s1.clip")
    service.regenerate(pid, "s1.clip")
    second = service.store.load_graph(pid).output_hash("s1.clip")

    service.patch(pid, [PatchOp(op="select_take", node_id="s1.clip", take=first)])
    # Selecting parked the identity it displaced, so the newer take is a
    # recorded destination now too.
    service.patch(pid, [PatchOp(op="select_take", node_id="s1.clip", take=second)])
    assert service.store.load_graph(pid).output_hash("s1.clip") == second


def test_selecting_a_take_is_undoable(tmp_path):
    service, pid = _service(tmp_path)
    first = service.store.load_graph(pid).output_hash("s1.clip")
    service.regenerate(pid, "s1.clip")
    second = service.store.load_graph(pid).output_hash("s1.clip")

    service.patch(pid, [PatchOp(op="select_take", node_id="s1.clip", take=first)])
    service.undo(pid)
    assert service.store.load_graph(pid).output_hash("s1.clip") == second


def test_an_unrecorded_take_is_refused(tmp_path):
    service, pid = _service(tmp_path)
    with pytest.raises(ValueError, match="no recorded take"):
        service.patch(pid, [PatchOp(op="select_take", node_id="s1.clip", take="a" * 64)])


def test_takes_are_capped(tmp_path):
    service, pid = _service(tmp_path)
    for _ in range(TAKE_LIMIT + 3):
        service.regenerate(pid, "s1.clip")
    assert len(service.store.load_takes(pid).takes["s1.clip"]) == TAKE_LIMIT


def test_assets_and_scripts_have_no_takes():
    graph = prompt_template_graph("p")
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    for node_id in ("script", "asset-abc"):
        with pytest.raises(ValueError, match="do not have takes"):
            apply_patch(graph, [PatchOp(op="select_take", node_id=node_id, params={}, seed=0)])


def test_select_take_strips_server_owned_params():
    """Direct apply_patch discipline: even a hand-built select_take cannot
    smuggle the consent flag the upload route stamps."""
    graph = expand_screenplay(
        prompt_template_graph("p"),
        Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
        ),
    )
    apply_patch(
        graph,
        [
            PatchOp(
                op="select_take",
                node_id="s1.narration",
                params={"text": "hi", "voice_consent": True},
                seed=3,
            )
        ],
    )
    node = graph.nodes["s1.narration"]
    assert "voice_consent" not in node.params
    assert node.params["text"] == "hi" and node.seed == 3
