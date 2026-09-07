"""Which voice a narration node actually speaks in.

A narration node carries a style brief - "narrator", "clear", "deep male" -
and the brief is a wish, not a voice. `pick_voice` maps it onto one of five
keywords and a brief matching none of them lands on the pack default, so
"narrator" is read by Sarah and nothing in the params says so. A client
showing `params.voice` names something that may never have spoken, which is
what the voiceover tool's badge did: it read "narrator" over Sarah's voice.

The mapping is the narration backend's own vocabulary, so the board reports
the answer rather than shipping the table across the boundary for a client
to re-implement.
"""

from localcut_engine.backends.base import BackendRegistry
from localcut_engine.backends.kokoro import KokoroBackend
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.model import Node, NodeKind, StoryGraph
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
from localcut_engine.service import ProjectService


def _kokoro(tmp_path) -> KokoroBackend:
    """A backend whose weights are on disk, which is all `supports` reads.

    Nothing here synthesizes: resolving a brief is a table lookup, and
    building the 325 MB session to answer it is exactly what the route that
    enumerates the pack avoids too.
    """
    (tmp_path / "models" / "tts").mkdir(parents=True)
    (tmp_path / "models" / "tts" / "kokoro-v1.0.onnx").write_bytes(b"")
    (tmp_path / "models" / "tts" / "voices-v1.0.bin").write_bytes(b"")
    return KokoroBackend(tmp_path / "models")


def _service(tmp_path, backends: BackendRegistry | None, params: dict) -> tuple[dict, str]:
    graph = StoryGraph()
    graph.add_node(Node(id="voiceover", kind=NodeKind.NARRATION, params=params))
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus(), backends=backends)
    project = store.create(title="t", graph=graph, mode="tool:voiceover")
    return service.scene_board(project.id)["aux"]["voiceover"], project.id


def test_a_brief_reports_the_voice_it_resolves_to(tmp_path):
    registry = BackendRegistry()
    registry.register(_kokoro(tmp_path))
    state, _ = _service(tmp_path, registry, {"text": "hi", "voice": "british"})
    assert state["resolved_voice"] == "bf_emma"


def test_a_brief_matching_no_keyword_reports_the_fallback_it_lands_on(tmp_path):
    """The one that started this: the voiceover tool's own default brief.

    "narrator" names no keyword in the table, so it falls to the pack
    default - and a badge showing the brief says "narrator" over a voice
    the user has no way to learn the name of.
    """
    registry = BackendRegistry()
    registry.register(_kokoro(tmp_path))
    state, _ = _service(tmp_path, registry, {"text": "hi", "voice": "narrator"})
    assert state["resolved_voice"] == "af_sarah"


def test_a_picked_voice_is_what_speaks_whatever_the_brief_says(tmp_path):
    registry = BackendRegistry()
    registry.register(_kokoro(tmp_path))
    state, _ = _service(
        tmp_path, registry, {"text": "hi", "voice": "british", "voice_id": "jf_alpha"}
    )
    # The pick outranks the brief at render, so it has to outrank it here
    # too - otherwise the board names the voice that did NOT speak.
    assert state["resolved_voice"] == "jf_alpha"


def test_a_chain_that_narrates_elsewhere_names_no_voice(tmp_path):
    """Kokoro's voices are Kokoro's vocabulary alone.

    The same reason `/voices` reports `available: false` off that backend:
    naming `af_sarah` over audio the mock tier produced would be a
    fabricated provenance, and null is a state the client already renders.
    """
    registry = BackendRegistry()
    registry.register(MockBackend())
    state, _ = _service(tmp_path, registry, {"text": "hi", "voice": "british"})
    assert state["resolved_voice"] is None


def test_an_engine_with_no_registry_names_no_voice(tmp_path):
    # The board is built in tests and tools without one; it must answer
    # rather than raise.
    state, _ = _service(tmp_path, None, {"text": "hi", "voice": "british"})
    assert state["resolved_voice"] is None


def test_a_consented_re_upload_stamps_the_existing_asset(tmp_path):
    """The node id is the content hash, so a file first dropped in as a plain
    asset already has a node. The affirmation then answered 200 and changed
    nothing: the node stayed unstamped, the voice_ref chokepoint went on
    refusing it, and there was no way to fix that from the UI."""
    from localcut_engine.events import EventBus
    from localcut_engine.graph.model import VOICE_REF_PORT
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import prompt_template_graph
    from localcut_engine.jobs.queue import JobQueue
    from localcut_engine.project.store import ProjectStore
    from localcut_engine.service import ProjectService

    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, EventBus())
    project = store.create(
        title="t",
        graph=prompt_template_graph("a hummingbird", target_duration_s=30),
        mode="prompt",
    )

    data = b"RIFF....WAVEfmt "
    plain = service.add_asset(project.id, "sample.wav", data)
    graph = store.load_graph(project.id)
    assert "voice_consent" not in graph.nodes[plain["node_id"]].params

    # The same bytes again, this time with the affirmation.
    consented = service.add_asset(project.id, "sample.wav", data, voice=True)
    assert consented["node_id"] == plain["node_id"], "the id is the content hash"

    graph = store.load_graph(project.id)
    assert graph.nodes[consented["node_id"]].params.get("voice_consent") is True

    # And the chokepoint now accepts it, which is the whole point.
    graph.add_node(Node(id="n1", kind=NodeKind.NARRATION, params={"text": "hello"}))
    apply_patch(
        graph,
        [
            PatchOp(
                op="connect",
                node_id="n1",
                src=consented["node_id"],
                port=VOICE_REF_PORT,
            )
        ],
    )
    assert any(e.dst == "n1" and e.port == VOICE_REF_PORT for e in graph.edges)

    # The stamped bytes are readable at the node's new address: consent is
    # part of its identity, so the asset re-addresses.
    assert store.resolve_artifact(project.id, consented["hash"]) is not None
