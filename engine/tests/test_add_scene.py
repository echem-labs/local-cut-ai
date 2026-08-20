"""The add_scene patch op. Scenes used to exist only via script expansion,
so "+ add a scene" had no engine path at all. The op compiles, inside the
service, into the same primitive ops every other edit uses — apply_patch's
cycle check and consent gate cover the new subgraph for free — and the
screenplay stays the source of truth: like a scene the NL editor removed,
an added scene lives until the script itself re-renders.
"""

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.compiler import orphaned_nodes, unready_nodes
from localcut_engine.graph.model import KEYFRAME_PORT, Node, NodeKind
from localcut_engine.graph.patch import PatchOp
from localcut_engine.graph.templates import MAX_CLIP_S, expand_screenplay, prompt_template_graph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


def _service(tmp_path, scenes: int = 1) -> tuple[ProjectService, str]:
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    screenplay = Screenplay(
        title="t",
        scenes=[
            Scene(id=f"s{i}", duration_s=4.0, narration=f"line {i}", visual="v", motion="m")
            for i in range(1, scenes + 1)
        ],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    project = store.create(title="t", graph=graph)
    return service, project.id


def _add(service, project_id, **kwargs) -> set[str]:
    op = PatchOp(
        op="add_scene",
        params={k: v for k, v in kwargs.items() if k != "after"},
        after=kwargs.get("after"),
    )
    return service.patch(project_id, [op])


def test_add_scene_builds_the_full_member_subgraph(tmp_path):
    service, pid = _service(tmp_path)
    dirty = _add(
        service, pid, prompt="a lighthouse at dusk", narration="the light turns", duration_s=6
    )

    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.keyframe"].params["prompt"] == "a lighthouse at dusk"
    assert graph.nodes["s2.clip"].params["duration_s"] == 6.0
    assert graph.nodes["s2.narration"].params["text"] == "the light turns"
    # Same aspect as the rest of the pipeline, not a hardcoded default.
    assert (
        graph.nodes["s2.keyframe"].params["aspect"] == graph.nodes["s1.keyframe"].params["aspect"]
    )
    edges = {(e.src, e.dst, e.port) for e in graph.edges}
    assert ("script", "s2.keyframe", "default") in edges
    assert ("script", "s2.narration", "default") in edges
    assert ("s2.keyframe", "s2.clip", "keyframe") in edges
    assert ("s2.clip", "timeline", "s2") in edges
    assert ("s2.narration", "timeline", "s2.audio") in edges
    assert graph.nodes["timeline"].params["order"] == ["s1", "s2"]
    # The captions ground truth follows the narration set (patch syncs it).
    assert graph.nodes["captions"].params["texts"]["s2"] == "the light turns"
    assert {"s2.keyframe", "s2.clip", "s2.narration"} <= dirty
    # The board grows a card for it.
    board = service.scene_board(pid)
    assert [card["scene_id"] for card in board["scenes"]] == ["s1", "s2"]


def test_add_scene_inserts_after_a_named_scene(tmp_path):
    service, pid = _service(tmp_path, scenes=2)
    _add(service, pid, prompt="x", after="s1")
    order = service.store.load_graph(pid).nodes["timeline"].params["order"]
    assert order == ["s1", "s3", "s2"]


def test_add_scene_skips_ids_with_leftover_timeline_state(tmp_path):
    """Trims/transitions are keyed by scene id and survive a scene's
    removal — a recycled id would inherit a removed scene's edits."""
    service, pid = _service(tmp_path, scenes=2)
    service.patch(
        pid,
        [PatchOp(op="set_params", node_id="timeline", params={"trims": {"s2": {"in": 1.0}}})],
    )
    for member in ("s2.keyframe", "s2.clip", "s2.narration"):
        service.patch(pid, [PatchOp(op="remove_node", node_id=member)])

    _add(service, pid, prompt="x")
    graph = service.store.load_graph(pid)
    assert "s3.clip" in graph.nodes and "s2.clip" not in graph.nodes


def test_two_adds_in_one_patch_do_not_collide(tmp_path):
    service, pid = _service(tmp_path)
    service.patch(pid, [PatchOp(op="add_scene", params={"prompt": "a"}), PatchOp(op="add_scene")])
    graph = service.store.load_graph(pid)
    assert "s2.clip" in graph.nodes and "s3.clip" in graph.nodes
    assert graph.nodes["timeline"].params["order"] == ["s1", "s2", "s3"]


def test_add_scene_duration_stays_a_single_clip(tmp_path):
    """Past MAX_CLIP_S a scene splits into sequential takes, which is
    expansion's construction, not a patch op's — the op clamps instead."""
    service, pid = _service(tmp_path)
    _add(service, pid, duration_s=30)
    assert service.store.load_graph(pid).nodes["s2.clip"].params["duration_s"] == MAX_CLIP_S


def test_add_scene_requires_a_timeline(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    project = store.create(title="t", graph=prompt_template_graph("p"))
    with pytest.raises(ValueError, match="timeline"):
        service.patch(project.id, [PatchOp(op="add_scene")])


def test_add_scene_with_unknown_after_is_refused(tmp_path):
    service, pid = _service(tmp_path)
    with pytest.raises(ValueError, match="unknown scene"):
        _add(service, pid, after="s9")


def test_added_scene_speaks_with_the_project_voice(tmp_path):
    service, pid = _service(tmp_path)
    _add(service, pid, narration="hello")
    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.narration"].params.get("voice") == graph.nodes[
        "s1.narration"
    ].params.get("voice")


def test_added_scene_inherits_an_explicitly_picked_voice(tmp_path):
    """`voice_id` outranks the style brief, so inheriting only `voice` lets
    the new scene fall back to whatever the brief resolves to and speak in a
    different voice from every scene around it — the failure the brief
    propagation above exists to prevent, reached through the field that
    beats it."""
    service, pid = _service(tmp_path)
    graph = service.store.load_graph(pid)
    service.patch(
        pid,
        [
            PatchOp(
                op="set_params",
                node_id="s1.narration",
                params={**graph.nodes["s1.narration"].params, "voice_id": "bm_george"},
            )
        ],
    )
    _add(service, pid, narration="hello")
    graph = service.store.load_graph(pid)
    assert graph.nodes["s2.narration"].params.get("voice_id") == "bm_george"


def test_add_scene_is_undoable(tmp_path):
    service, pid = _service(tmp_path)
    _add(service, pid, prompt="x")
    service.undo(pid)
    graph = service.store.load_graph(pid)
    assert "s2.clip" not in graph.nodes
    assert [card["scene_id"] for card in service.scene_board(pid)["scenes"]] == ["s1"]


def test_a_scene_with_nothing_written_in_it_renders_nothing(tmp_path):
    """The desktop's "+ add a scene" card sends the op with no params at all,
    because the whole point is that you write the prompt afterwards. That
    queued a narration with empty text -- which both TTS backends refuse
    outright -- so the tile went red seconds after it appeared, before the
    user had typed anything, and the keyframe burned a full image generation
    on an empty prompt. Nothing in the new scene may reach the queue, and the
    board has to say why rather than spin on `queued` for work that will
    never be created."""
    service, pid = _service(tmp_path)
    before = {job.spec.node_id for job in service.queue.list(pid)}

    _add(service, pid)  # exactly what the desktop sends: no prompt, no narration

    queued = {job.spec.node_id for job in service.queue.list(pid)} - before
    assert not {"s2.keyframe", "s2.clip", "s2.narration"} & queued, (
        f"an unwritten scene reached the queue: {sorted(queued)}"
    )

    board = service.scene_board(pid)
    card = next(c for c in board["scenes"] if c["scene_id"] == "s2")
    assert card["keyframe"]["status"] == "blocked"
    assert card["narration"]["status"] == "blocked"
    assert card["clip"]["status"] == "blocked"


def test_writing_the_scene_lets_it_render(tmp_path):
    """The other half: `blocked` is a state the user leaves by typing, not a
    permanent refusal. Filling in the prompt and the narration has to put the
    whole scene -- and the assembly the cone had stopped -- back in the queue."""
    service, pid = _service(tmp_path)
    _add(service, pid)
    before = {job.spec.node_id for job in service.queue.list(pid)}
    service.patch(
        pid,
        [
            PatchOp(op="set_params", node_id="s2.keyframe", params={"prompt": "a lighthouse"}),
            PatchOp(op="set_params", node_id="s2.narration", params={"text": "the light turns"}),
        ],
    )

    # The queue, not the absence of a word. `blocked` is ranked below every
    # job state on the board, so `!= "blocked"` is also what a node that was
    # STILL never enqueued reports -- it falls through to `queued`, the
    # board's answer for "no job, no artifact", which is the exact tile-spins-
    # forever failure this pair of tests exists to catch. Asserting on the
    # queue is asserting on the thing that actually has to happen.
    queued = {job.spec.node_id for job in service.queue.list(pid)} - before
    assert {"s2.keyframe", "s2.narration"} <= queued, (
        f"writing the scene did not enqueue it: {sorted(queued)}"
    )

    board = service.scene_board(pid)
    card = next(c for c in board["scenes"] if c["scene_id"] == "s2")
    assert card["keyframe"]["status"] == "queued"
    assert card["narration"]["status"] == "queued"
    # And the cone it had stopped is moving again: the export is downstream of
    # every scene, so it is the one that proves the whole assembly recovered.
    assert board["aux"]["export"]["status"] != "blocked"


def test_a_null_in_the_op_is_an_unwritten_scene_not_the_word_none(tmp_path):
    """`add_scene` reads its own params before the ops it compiles to reach
    `stored_params`, and it reads them through `str(...)` with a default
    written for an ABSENT key.

    `str(None)` is the string "None", so a null -- which is exactly what an
    LLM emits into `ops` for a field it has not filled in -- minted a scene
    whose keyframe rendered that word, whose narration spoke it, and which
    `unready_nodes` read as written rather than blocked. The scene was
    enqueued and billed for.
    """
    service, pid = _service(tmp_path)
    service.patch(
        pid,
        [PatchOp(op="add_scene", params={"prompt": None, "narration": None, "motion": None})],
    )

    graph = service.store.load_graph(pid)
    # Blank, which is what "not written yet" is spelled as everywhere else --
    # not "None", and not a stored null either.
    assert graph.nodes["s2.keyframe"].params["prompt"] == ""
    assert graph.nodes["s2.clip"].params["motion"] == ""
    assert graph.nodes["s2.narration"].params["text"] == ""

    # And the board says so: nobody has written this scene, so nothing is
    # queued for it -- the same state "+ Add scene" with no params gives.
    card = next(c for c in service.scene_board(pid)["scenes"] if c["scene_id"] == "s2")
    assert card["keyframe"]["status"] == "blocked"
    assert card["narration"]["status"] == "blocked"


def test_a_node_added_with_no_inputs_is_not_enqueued_to_fail(tmp_path):
    """U4's Add node puts an empty, UNWIRED node on the canvas -- that is the
    whole point of it, you wire it up and fill it in afterwards.

    `unready_nodes` already refuses to enqueue a node whose own content is
    empty, for exactly this reason: a scene nobody has written must not go
    red seconds after it appears. A clip's missing piece is an INPUT rather
    than a param, so it slipped past that guard, reached the queue, and the
    ffmpeg backend raised "still clip needs a keyframe input" on arrival --
    the node the user had just added was red before they could wire it.
    """
    service, pid = _service(tmp_path)
    service.patch(
        pid,
        [
            PatchOp(
                op="add_node",
                node_id="clip-1",
                node=Node(id="clip-1", kind=NodeKind.CLIP),
            )
        ],
    )

    graph = service.store.load_graph(pid)
    assert "clip-1" in graph.nodes  # it IS added; it is just not runnable yet
    assert "clip-1" in unready_nodes(graph)
    # And nothing was queued for it, so nothing can fail for it.
    assert all(job.spec.node_id != "clip-1" for job in service.queue.list(pid, 1000))


def test_wiring_the_keyframe_in_makes_the_added_clip_runnable(tmp_path):
    """The other half: refusing to enqueue must not be a dead end. Wire the
    input the backend needs and the node becomes ordinary work."""
    service, pid = _service(tmp_path)
    service.patch(
        pid,
        [PatchOp(op="add_node", node_id="clip-1", node=Node(id="clip-1", kind=NodeKind.CLIP))],
    )
    service.patch(
        pid,
        [PatchOp(op="connect", node_id="clip-1", src="s1.keyframe", port=KEYFRAME_PORT)],
    )

    graph = service.store.load_graph(pid)
    assert "clip-1" not in unready_nodes(graph)


def test_a_scene_built_on_an_uploaded_image_never_renders_a_keyframe(tmp_path):
    """`src` wires the picture in as part of the SAME op that mints the scene.

    Sending `add_scene` and then a `connect` is two patches, and the first
    one ends in `_enqueue_dirty`: the generated keyframe still feeds the clip
    at that moment, so it is queued, rendered and paid for before the second
    patch displaces it. `orphaned_nodes` exists to stop exactly that waste
    and cannot, because the node is not orphaned yet.

    Doing it in one op also makes the whole thing atomic. Two patches can
    half-succeed, leaving a wordless scene the user's next attempt duplicates.
    """
    service, pid = _service(tmp_path)
    asset = service.add_asset(pid, "shot.png", b"\x89PNG\r\n\x1a\n" + b"x" * 32)

    dirty = service.patch(
        pid,
        [
            PatchOp(
                op="add_scene",
                src=asset["node_id"],
                params={"prompt": "a slow push in", "narration": "the city wakes"},
            )
        ],
    )

    sid = next(n for n in dirty if n.endswith(".clip")).split(".")[0]
    graph = service.store.load_graph(pid)
    # The clip draws from the user's picture, not from a generated one.
    assert [e.src for e in graph.inputs_of(f"{sid}.clip") if e.port == KEYFRAME_PORT] == [
        asset["node_id"]
    ]
    # The generated node is still there for the flowchart to mark "not
    # needed" — but it feeds nothing, so it is never enqueued.
    assert f"{sid}.keyframe" in graph.nodes
    assert f"{sid}.keyframe" in orphaned_nodes(graph)
    assert all(job.spec.node_id != f"{sid}.keyframe" for job in service.queue.list(pid, 1000))


def test_add_scene_refuses_a_keyframe_source_that_is_not_there(tmp_path):
    """A `src` naming nothing must refuse the whole op rather than build a
    scene wired to a node that does not exist."""
    service, pid = _service(tmp_path)

    with pytest.raises((KeyError, ValueError)):
        service.patch(pid, [PatchOp(op="add_scene", src="asset-000000000000")])

    graph = service.store.load_graph(pid)
    assert not [n for n in graph.nodes if n.startswith("s2.")]


def test_an_added_scene_takes_both_voice_fields_from_one_scene(tmp_path):
    """`voice_id` outranks the brief, so the two have to be inherited
    together. Resolving them with independent scans takes the brief from
    the first scene that has one and the pick from whatever later scene was
    overridden, minting a pair that exists on no scene and giving the new
    scene the overridden scene's voice while its neighbours keep theirs.
    """
    service, pid = _service(tmp_path, scenes=3)
    graph = service.store.load_graph(pid)
    service.patch(
        pid,
        [
            PatchOp(op="set_params", node_id="s1.narration", params={"voice": "energetic host"}),
            PatchOp(op="set_params", node_id="s3.narration", params={"voice_id": "bm_george"}),
        ],
    )
    _add(service, pid, narration="hello")

    graph = service.store.load_graph(pid)
    added = graph.nodes["s4.narration"].params
    source = graph.nodes["s1.narration"].params
    assert (added.get("voice"), added.get("voice_id")) == (
        source.get("voice"),
        source.get("voice_id"),
    )
