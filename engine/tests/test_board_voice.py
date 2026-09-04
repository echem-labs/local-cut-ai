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


def test_the_voices_route_says_whether_cloning_can_run(tmp_path):
    """The clone control commits the whole project in one move: consenting
    and picking a sample rewrites EVERY narration node to the clone model, so
    an engine without the optional runtime fails all of them together and
    clearing it means editing each node by hand in the advanced inspector.
    A client can only decline that trade if it can ask first.

    chatterbox-tts is not a dependency of this engine — it is optional by
    design, resolved lazily like ComfyUI or Ollama — so on a stock install
    this answers false and the desktop hides the control.
    """
    from starlette.testclient import TestClient

    from localcut_engine.api.app import create_app
    from localcut_engine.backends.chatterbox import ChatterboxBackend
    from localcut_engine.config import EngineConfig

    config = EngineConfig(data_dir=tmp_path, token="t", backend="local,mock")
    with TestClient(create_app(config)) as http:
        body = http.get("/voices", headers={"Authorization": "Bearer t"}).json()

    assert "cloning" in body, "the route no longer reports whether cloning can run"
    # It is the runtime's presence, not a guess: whatever this machine has,
    # the route has to agree with it.
    assert body["cloning"] == ChatterboxBackend.package_installed()


def test_cloning_availability_is_not_the_stock_voice_pack(tmp_path):
    """`available` is about Kokoro's pack and `cloning` is about a different
    backend and a different optional runtime — collapsing them would hide the
    clone control on every machine with no stock voices installed, and offer
    it on every machine that has them."""
    from starlette.testclient import TestClient

    from localcut_engine.api.app import create_app
    from localcut_engine.config import EngineConfig

    config = EngineConfig(data_dir=tmp_path, token="t", backend="mock")
    with TestClient(create_app(config)) as http:
        body = http.get("/voices", headers={"Authorization": "Bearer t"}).json()

    # A mock-only chain serves neither, and must still answer both keys.
    assert body["available"] is False
    assert body["cloning"] is False
