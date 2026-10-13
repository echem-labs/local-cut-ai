"""Story-graph templates, treated as the untrusted documents they are.

A template is the one artifact of this project designed to travel between
machines and, eventually, between people who have never met (doc 08's
marketplace waits on this format). So the tests that matter are not "does a
round trip work" — they are "what does a hostile or merely wrong document
do", because every one of those answers becomes a security property the
moment a template arrives from someone else.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from localcut_engine.backends.base import BackendRegistry
from localcut_engine.backends.mock import MockBackend
from localcut_engine.events import EventBus
from localcut_engine.graph.compiler import orphaned_nodes, unready_nodes
from localcut_engine.graph.model import GRAPH_VERSION, Edge, Node, NodeKind, StoryGraph
from localcut_engine.graph.patch import PatchOp, apply_patch
from localcut_engine.graph.template_io import (
    MAX_NODES,
    TEMPLATE_VERSION,
    TemplateError,
    build_graph,
    cloud_models,
    from_template,
    to_template,
)
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph, tool_graph
from localcut_engine.jobs.models import JobStatus
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.jobs.scheduler import Scheduler
from localcut_engine.project.store import ProjectStore
from localcut_engine.schema import Scene, Screenplay
from localcut_engine.service import ProjectService


def _graph() -> StoryGraph:
    """A miniature of the real shape: a script feeding a scene's keyframe,
    which feeds its clip."""
    graph = StoryGraph()
    graph.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "a documentary"}))
    graph.add_node(Node(id="s1.keyframe", kind=NodeKind.KEYFRAME, params={"prompt": "a shore"}))
    graph.add_node(Node(id="s1.clip", kind=NodeKind.CLIP, params={"motion": "slow pan"}))
    graph.connect("script", "s1.keyframe")
    graph.connect("s1.keyframe", "s1.clip", port="keyframe")
    return graph


def _document(**overrides) -> dict:
    doc = to_template(_graph(), name="Shore").model_dump(mode="json")
    doc.update(overrides)
    return doc


# -- what travels ------------------------------------------------------------


def test_a_template_round_trips_the_graph_it_describes():
    template = from_template(_document())
    graph = build_graph(template)

    assert set(graph.nodes) == {"script", "s1.keyframe", "s1.clip"}
    assert graph.nodes["s1.clip"].params == {"motion": "slow pan"}
    assert {(e.src, e.dst, e.port) for e in graph.edges} == {
        ("script", "s1.keyframe", "default"),
        ("s1.keyframe", "s1.clip", "keyframe"),
    }


def test_an_upload_does_not_travel_and_neither_does_the_edge_that_used_it():
    """The half that matters. A scene conditioned on the user's own photo has
    its generated keyframe displaced from the clip's `keyframe` port — drop
    the asset but keep the edge and the template describes a clip wired to a
    node that isn't there. Drop only the edge and the port is empty, because
    `connect` REPLACED the generated keyframe's edge rather than adding a
    second one: the clip imports with nothing to animate and never renders.
    The generated keyframe has to go back on the port the asset held."""
    graph = _graph()
    graph.add_node(Node(id="asset-1", kind=NodeKind.ASSET, params={"sha256": "a" * 64}))
    # Conditioning: the asset displaces the generated keyframe.
    graph.edges = [e for e in graph.edges if not (e.dst == "s1.clip" and e.port == "keyframe")]
    graph.connect("asset-1", "s1.clip", port="keyframe")

    template = to_template(graph, name="Conditioned")

    assert "asset-1" not in template.nodes
    assert template.dropped_assets == 1, "the export has to say something was left behind"
    assert not [e for e in template.edges if "asset-1" in (e.src, e.dst)]
    assert ("s1.keyframe", "s1.clip", "keyframe") in {
        (e.src, e.dst, e.port) for e in template.edges
    }
    # And the graph it builds is renderable: nothing points at the missing node.
    build_graph(template).topological_order()


def _conditioned_on_uploads() -> StoryGraph:
    """What the app leaves behind when a project uses the user's own media: a
    screenplay expanded into scenes, the first long enough to split into two
    takes, then an uploaded still wired into both takes and an uploaded track
    into the timeline's music port. Wired through `apply_patch`, so each
    `connect` displaces what held the port exactly as a real edit does."""
    graph = prompt_template_graph("a hummingbird", target_duration_s=20)
    expand_screenplay(
        graph,
        Screenplay(
            title="Conditioned",
            hook="",
            scenes=[
                Scene(id="s1", narration="line 1", visual="shot 1", duration_s=12.0),
                Scene(id="s2", narration="line 2", visual="shot 2", duration_s=5.0),
            ],
        ),
    )
    graph.add_node(Node(id="asset-still", kind=NodeKind.ASSET, params={"sha256": "a" * 64}))
    graph.add_node(Node(id="asset-track", kind=NodeKind.ASSET, params={"sha256": "b" * 64}))
    apply_patch(
        graph,
        [
            PatchOp(op="connect", node_id="s1.clip", src="asset-still", port="keyframe"),
            PatchOp(op="connect", node_id="s1.clip2", src="asset-still", port="keyframe"),
            PatchOp(op="connect", node_id="timeline", src="asset-track", port="music"),
        ],
    )
    return graph


def test_an_export_gives_back_every_port_an_upload_held():
    """Each take of the conditioned scene draws from the scene's generated
    keyframe again, and the timeline from the generated music bed. Without
    that, the clips import with an empty `keyframe` port and wait forever;
    the timeline, the captions and the export wait on them."""
    template = to_template(_conditioned_on_uploads(), name="Conditioned")

    held = {(e.dst, e.port): e.src for e in template.edges}
    clips = sorted(nid for nid, node in template.nodes.items() if node.kind is NodeKind.CLIP)
    assert {clip: held.get((clip, "keyframe")) for clip in clips} == {
        "s1.clip": "s1.keyframe",
        "s1.clip2": "s1.keyframe",
        "s2.clip": "s2.keyframe",
    }
    assert held.get(("timeline", "music")) == "music"

    imported = build_graph(from_template(template.model_dump(mode="json")))
    assert unready_nodes(imported) == set(), "a node in the imported graph can never render"
    assert orphaned_nodes(imported) == set(), "a generated node imports feeding nothing"


def test_an_export_puts_back_only_a_node_the_template_has():
    """The Quick Tool clip with a start frame wires the frame in and removes
    the generated keyframe in the same patch, so there is nothing to give
    the port back to. An edge invented from `keyframe` would point at a node
    the document does not carry, and import refuses that outright."""
    graph = tool_graph("clip", {"prompt": "a wave"})
    graph.add_node(Node(id="asset-1", kind=NodeKind.ASSET, params={"sha256": "a" * 64}))
    apply_patch(
        graph,
        [
            PatchOp(op="connect", node_id="clip", src="asset-1", port="keyframe"),
            PatchOp(op="remove_node", node_id="keyframe"),
        ],
    )

    template = to_template(graph, name="Start frame")

    assert template.edges == []
    assert set(from_template(template.model_dump(mode="json")).nodes) == {"clip"}


def test_an_export_takes_a_narration_off_the_voice_it_cannot_carry():
    """Cloning puts every narration on `local:chatterbox` and wires the
    consented sample into its `voice_ref` port. The sample stays behind and
    no template may wire that port, so a narration still set to clone
    imports as one the cloning backend refuses on every render ("cloned
    narration needs a consented voice sample"), and nothing it feeds is ever
    assembled. Exported, it speaks in the stock voice its params name."""
    graph = _graph()
    graph.add_node(
        Node(
            id="s1.narration",
            kind=NodeKind.NARRATION,
            params={"text": "hello", "voice": "warm"},
            model="local:chatterbox",
        )
    )
    graph.add_node(
        Node(
            id="asset-voice",
            kind=NodeKind.ASSET,
            params={"sha256": "c" * 64, "voice_consent": True},
        )
    )
    graph.connect("script", "s1.narration")
    graph.connect("asset-voice", "s1.narration", port="voice_ref")

    template = to_template(graph, name="Cloned")

    assert template.nodes["s1.narration"].model is None
    assert template.nodes["s1.narration"].params["voice"] == "warm"


def test_a_pin_does_not_travel():
    """A pin freezes one artifact by hash. There is no artifact in a
    template, so importing one would freeze against a hash that will never
    exist and the node would never render."""
    graph = _graph()
    graph.nodes["s1.keyframe"].pinned = True
    graph.nodes["s1.keyframe"].frozen_hash = "f" * 64

    template = to_template(graph, name="Pinned")

    assert template.nodes["s1.keyframe"].pinned is False
    assert template.nodes["s1.keyframe"].frozen_hash is None


def test_server_owned_params_travel_in_neither_direction():
    """`voice_consent` is the affirmation the upload route stamps. A template
    that could set it would forge consent for a cloned voice — so it is
    stripped on export AND re-stripped on import, because a hand-written
    document never went through export at all."""
    graph = _graph()
    graph.nodes["s1.clip"].params["voice_consent"] = True
    graph.nodes["s1.clip"].params["sha256"] = "b" * 64

    exported = to_template(graph, name="Forged")
    assert "voice_consent" not in exported.nodes["s1.clip"].params
    assert "sha256" not in exported.nodes["s1.clip"].params

    forged = _document()
    forged["nodes"]["s1.clip"]["params"]["voice_consent"] = True
    assert "voice_consent" not in from_template(forged).nodes["s1.clip"].params


def test_a_null_param_travels_in_neither_direction():
    """A template is the other document node params arrive from outside on,
    so it re-establishes the same rule the patch route does: a node never
    holds a null.

    An imported null is a value every reader acts on and no later edit can
    clear — `set_params` removes only what THAT op cleared. The one with
    teeth is `captions`, read as `params.get("captions", "burn")`: a template
    carrying `{"captions": null}` builds a project that silently exports
    without the captions it was asked for.
    """
    graph = _graph()
    graph.nodes["s1.clip"].params["fps"] = None

    assert "fps" not in to_template(graph, name="Null").nodes["s1.clip"].params

    incoming = _document()
    incoming["nodes"]["s1.clip"]["params"]["captions"] = None
    params = from_template(incoming).nodes["s1.clip"].params
    assert "captions" not in params
    assert params.get("captions", "burn") == "burn"  # ffmpeg.py's own expression


def test_the_cloud_models_a_template_would_spend_on_are_listed():
    """A template built around a cloud model is legitimate, but rendering it
    spends the importer's money on the author's choice of provider. That has
    to be visible before the project exists, not on the first bill."""
    graph = _graph()
    graph.nodes["s1.clip"].model = "cloud:veo-3.1-fast"
    graph.nodes["s1.keyframe"].model = "local:sdxl"

    assert cloud_models(to_template(graph, name="Pricey")) == ["cloud:veo-3.1-fast"]
    assert cloud_models(to_template(_graph(), name="Local")) == []


# -- what is refused ---------------------------------------------------------


def test_a_template_from_a_newer_engine_is_refused_not_reduced():
    """Every model here is pydantic extra='ignore', so a newer document
    validates by silently dropping whatever this build does not know — and
    then renders as something other than what the author published."""
    with pytest.raises(TemplateError, match="newer version"):
        from_template(_document(template_version=TEMPLATE_VERSION + 1))


def test_a_cycle_is_refused_before_it_can_reach_a_project():
    """output_hash recurses through inputs; a cycle makes every later read of
    the project 500 forever. It must never be persisted."""
    doc = _document()
    doc["edges"].append({"src": "s1.clip", "dst": "script", "port": "default"})

    with pytest.raises(TemplateError, match="cycle"):
        from_template(doc)


def test_an_edge_to_a_node_that_is_not_there_is_refused():
    doc = _document()
    doc["edges"].append({"src": "ghost", "dst": "s1.clip", "port": "default"})

    with pytest.raises(TemplateError, match="ghost"):
        from_template(doc)


def test_a_node_whose_key_and_id_disagree_is_refused():
    """The dict key is what every other part of the engine addresses; a
    document where the two disagree imports one node under the other's name,
    and which one wins depends on who reads it."""
    doc = _document()
    doc["nodes"]["s1.clip"]["id"] = "somewhere-else"

    with pytest.raises(TemplateError, match="does not match its key"):
        from_template(doc)


def test_an_asset_node_in_an_incoming_template_is_refused():
    """Export drops them; a hand-written document can still name one. Its
    file is not in the document, so importing it makes a node that points at
    nothing and a scene that renders nothing with no error."""
    doc = _document()
    doc["nodes"]["asset-1"] = {"id": "asset-1", "kind": "asset", "params": {}}

    with pytest.raises(TemplateError, match="uploaded assets"):
        from_template(doc)


def test_a_template_whose_graph_is_from_a_newer_engine_is_refused_too():
    """The nodes carry their own version, and it is the one that decides
    whether this build understands them. build_graph stamps GRAPH_VERSION on
    what it writes, so a newer document accepted here would be recorded as a
    graph THIS build wrote — the silent reduction the format check exists to
    prevent, one field over."""
    with pytest.raises(TemplateError, match="graph 2"):
        from_template(_document(graph_version=GRAPH_VERSION + 1))


def test_two_edges_cannot_feed_one_input():
    """An input port holds one connection — the invariant `connect` keeps by
    displacing whatever was there. Nothing downstream re-checks it: the
    compiler folds a node's inputs into a {port: hash} dict, so the second
    edge vanishes from the output identity while still sitting in the graph,
    and which one survives depends on list order."""
    doc = _document()
    doc["edges"].append({"src": "script", "dst": "s1.clip", "port": "keyframe"})

    with pytest.raises(TemplateError, match="more than one edge"):
        from_template(doc)


def test_a_template_cannot_wire_a_voice_ref_port():
    """voice_ref is the consent chokepoint: only a consented voice-sample
    ASSET may feed it, and the cloning backend trusts the graph rather than
    re-checking. An asset can never travel in a template, so a voice_ref edge
    in one is never legitimate however it was produced."""
    doc = _document()
    doc["nodes"]["s1.narration"] = {
        "id": "s1.narration",
        "kind": "narration",
        "params": {},
        "model": "local:chatterbox",
    }
    doc["edges"].append({"src": "s1.keyframe", "dst": "s1.narration", "port": "voice_ref"})

    with pytest.raises(TemplateError, match="voice_ref"):
        from_template(doc)


def test_a_template_with_no_nodes_is_refused():
    with pytest.raises(TemplateError, match="no nodes"):
        from_template(_document(nodes={}))


def test_an_enormous_template_is_refused_before_it_is_validated():
    """The cap is checked on the raw dict, not after pydantic has built every
    Node: validating 100k nodes in order to reject them is the same work as
    accepting them, on a route a client reaches."""
    doc = _document()
    doc["nodes"] = {
        f"n{i}": {"id": f"n{i}", "kind": "keyframe", "params": {}} for i in range(MAX_NODES + 1)
    }

    with pytest.raises(TemplateError, match=f"limit is {MAX_NODES}"):
        from_template(doc)


def test_junk_is_refused_with_a_reason_rather_than_a_traceback():
    with pytest.raises(TemplateError, match="not valid JSON"):
        from_template("{not json")
    with pytest.raises(TemplateError, match="JSON object"):
        from_template([1, 2, 3])
    with pytest.raises(TemplateError, match="whole number"):
        from_template(_document(template_version="1"))


def test_an_unknown_node_kind_is_refused():
    """Kinds are a closed set — a document naming one this build cannot
    execute would compile to a job no backend claims."""
    doc = _document()
    doc["nodes"]["s1.clip"]["kind"] = "mystery"

    with pytest.raises(TemplateError, match="kind"):
        from_template(doc)


# -- and the project it becomes ---------------------------------------------


def test_a_project_from_a_template_plans_its_whole_graph(tmp_path):
    """Nothing is cached in a new project, so every node is work to do. A
    template that imported to zero jobs would sit on the board reading
    `queued` with nothing running — the same failure duplicate() guards."""
    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    service = ProjectService(store, queue, EventBus())

    template = from_template(_document())
    project = service.create_from_template(template, title="From a template")

    assert project.title == "From a template"
    assert store.load_graph(project.id).nodes.keys() == {"script", "s1.keyframe", "s1.clip"}
    # Every node, not just the roots: the compiler plans the whole graph and
    # the scheduler holds each job until its inputs land.
    assert {job.spec.node_id for job in queue.list(project.id, 10)} == {
        "script",
        "s1.keyframe",
        "s1.clip",
    }


def test_the_template_name_is_the_title_when_none_is_given(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())

    project = service.create_from_template(from_template(_document()))

    assert project.title == "Shore"


def test_exporting_carries_the_presets_a_new_project_needs(tmp_path):
    """Aspect and duration are project meta, not graph nodes — a template
    without them imports as a 9:16 60s project whatever it was authored as."""
    store = ProjectStore(tmp_path / "projects")
    service = ProjectService(store, JobQueue(tmp_path / "queue.db"), EventBus())
    source = store.create(
        title="Wide", graph=_graph(), mode="advanced", aspect="16:9", duration_s=90.0
    )

    document = service.export_template(source.id)
    template = from_template(document)

    assert (template.aspect, template.duration_s, template.mode) == ("16:9", 90.0, "advanced")
    copy = service.create_from_template(template)
    assert (copy.aspect, copy.duration_s, copy.mode) == ("16:9", 90.0, "advanced")


def test_edges_are_copies_so_two_projects_never_share_one(tmp_path):
    """build_graph runs once per import; a shared Edge object would make an
    edit to one project mutate the other."""
    template = from_template(_document())
    first, second = build_graph(template), build_graph(template)

    first.edges[0].port = "rewired"

    assert second.edges[0].port == "default"
    assert template.edges[0].port == "default"


def test_an_edge_list_over_the_cap_is_refused():
    doc = _document()
    doc["edges"] = [{"src": "script", "dst": "s1.clip", "port": f"p{i}"} for i in range(2001)]

    with pytest.raises(TemplateError, match="more than"):
        from_template(doc)


def test_edges_survive_export_with_their_ports(tmp_path):
    """Ports are the whole wiring. An export that flattened them to `default`
    would import a graph where the keyframe feeds the clip's default input
    and no backend finds its conditioning image."""
    template = to_template(_graph(), name="Ports")
    ports = {(e.src, e.dst): e.port for e in template.edges}

    assert ports[("s1.keyframe", "s1.clip")] == "keyframe"


def test_a_graph_with_no_edges_is_a_valid_template():
    """Quick Tool micro-projects are a single node with no wiring at all."""
    graph = StoryGraph()
    graph.add_node(Node(id="thumbnail", kind=NodeKind.THUMBNAIL, params={"prompt": "x"}))

    template = from_template(to_template(graph, name="Tool").model_dump(mode="json"))

    assert list(template.nodes) == ["thumbnail"]
    assert template.edges == []


def test_a_template_document_is_plain_json(tmp_path):
    """It has to survive a file, a clipboard and an HTTP body — so no enums,
    no tuples, nothing that needs this codebase to deserialize."""
    import json

    document = to_template(_graph(), name="Portable").model_dump(mode="json")

    assert json.loads(json.dumps(document)) == document
    assert document["nodes"]["s1.clip"]["kind"] == "clip"  # a string, not NodeKind
    assert isinstance(document["edges"][0], dict)
    assert Edge.model_validate(document["edges"][0])


# -- presets: the fields a template sets on the PROJECT, not on the graph -----
#
# `/projects` bounds all three of these on the way in. A template is a second
# route to the same fields, so anything it can set that the create route
# refuses is a project state no supported flow can otherwise produce.


def test_a_template_cannot_carry_a_mode_the_engine_does_not_have():
    """`mode` is not decoration. Project.tsx renders a `tool:` project as a
    one-node Quick Tool shell instead of the workspace, and
    ProjectService._on_job_done refuses to expand a tool session's screenplay
    into scenes at all. A shared document that could set it to an unknown
    `tool:` kind would import as a project that draws as a broken tool and
    never grows past its script node."""
    with pytest.raises(TemplateError, match="unknown project mode"):
        from_template(_document(mode="tool:exfiltrate"))

    with pytest.raises(TemplateError, match="unknown project mode"):
        from_template(_document(mode="kiosk"))


def test_the_modes_a_project_really_has_still_travel():
    """The check is a bound, not a new restriction: every mode the engine
    itself sets has to survive an export/import round trip."""
    for mode in ("prompt", "beginner", "advanced", "flowchart", "tool:script", "tool:thumbnail"):
        assert from_template(_document(mode=mode)).mode == mode


def test_an_aspect_outside_the_export_table_is_refused():
    """/projects refuses one because an unknown aspect renders as the default
    one silently. Accepting it here would make a template the only way to get
    a project whose stated aspect and rendered aspect disagree."""
    with pytest.raises(TemplateError, match="unsupported aspect"):
        from_template(_document(aspect="21:9"))

    assert from_template(_document(aspect="16:9")).aspect == "16:9"
    assert from_template(_document(aspect=None)).aspect is None


def test_a_duration_that_is_not_a_number_of_seconds_is_refused():
    """json.loads accepts NaN and Infinity, and either poisons the length
    arithmetic and the project tile that reports it. The bound is deliberately
    NOT the create route's 5-1200s target range: this field is the assembled
    cut length, and a three-second Quick Tool cut is legitimately under it."""
    for bad in (float("nan"), float("inf"), -1.0):
        with pytest.raises(TemplateError, match="number of seconds"):
            from_template(_document(duration_s=bad))

    assert from_template(_document(duration_s=3.2)).duration_s == 3.2


def test_the_size_cap_applies_to_a_parsed_document_too():
    """Every route that reaches from_template hands in a dict — FastAPI parsed
    the request body, the CLI parsed the file — so a cap that only measured
    `str | bytes` fired in tests and nowhere else. Node and edge counts do not
    catch this: three nodes whose params are megabytes apiece pass all of
    them, and the document is then written to graph.json at that size."""
    document = _document()
    document["nodes"]["s1.clip"]["params"]["motion"] = "x" * (2 << 20)

    with pytest.raises(TemplateError, match="larger than"):
        from_template(document)


def test_a_document_nested_too_deeply_is_refused_not_crashed():
    """The size guard is the last thing between an untrusted document and
    pydantic, and it was itself unbounded in one dimension: `iterencode` with
    a `default=` runs CPython's pure-Python encoder, which recurses per level.
    json.loads (C, iterative) parses far deeper, so a ~12 KB document reached
    the guard and raised RecursionError — a RuntimeError, caught by neither
    `except TemplateError` in the route nor anything else, so the reply was a
    500 with a traceback instead of the reason this function exists to give."""
    document = _document()
    document["deep"] = json.loads("[" * 3000 + "]" * 3000)

    with pytest.raises(TemplateError, match="nested too deeply"):
        from_template(document)


def test_an_imported_narration_node_carries_this_builds_version():
    """A template is a document this build did not write, and the importer
    enqueues against the graph it returns — so a narration node arriving
    with an older behaviour version (or none) would render at one address
    and be re-addressed by the first load afterwards, orphaning the audio
    the import just paid for. Migrating on the way in is what makes the
    import's own render the one that counts.
    """
    from localcut_engine.graph.model import NARRATION_VERSION

    graph = _graph()
    graph.add_node(
        Node(id="s1.narration", kind=NodeKind.NARRATION, params={"text": "hi", "voice": "warm"})
    )
    graph.connect("script", "s1.narration")
    document = to_template(graph, name="t").model_dump()
    # A template written before the field existed at all.
    document["nodes"]["s1.narration"]["params"].pop("narration_version", None)

    built = build_graph(from_template(document))

    assert built.nodes["s1.narration"].params["narration_version"] == NARRATION_VERSION
    assert built.output_hash("s1.narration") != graph.output_hash("s1.narration")


# -- a template has to import as the graph it describes ----------------------


def _service(tmp_path):
    from localcut_engine.events import EventBus
    from localcut_engine.jobs.queue import JobQueue
    from localcut_engine.project.store import ProjectStore
    from localcut_engine.service import ProjectService

    store = ProjectStore(tmp_path / "projects")
    queue = JobQueue(tmp_path / "queue.db")
    return ProjectStore(tmp_path / "projects"), queue, ProjectService(store, queue, EventBus())


def test_a_template_round_trips_the_authors_edits(tmp_path):
    """Export then import has to reproduce the project, not re-derive it.

    The script node is what re-derived it: with no artifact it re-rendered on
    import, and `expand_screenplay` rebuilt the scene structure from whatever
    the importer's own model wrote — so a scene the author deleted came back,
    a narration line they rewrote reverted, and nothing said so.
    """
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.graph.template_io import from_template
    from localcut_engine.schema import Scene, Screenplay

    store, _queue, service = _service(tmp_path)

    screenplay = Screenplay(
        title="Template fidelity probe",
        hook="",
        scenes=[
            Scene(id=f"s{n}", narration=f"line {n}", visual=f"shot {n}", duration_s=5.0)
            for n in (1, 2, 3)
        ],
    )
    graph = prompt_template_graph("a hummingbird", target_duration_s=30)
    expand_screenplay(graph, screenplay)
    project = store.create(title="source", graph=graph, mode="prompt")

    # The author's two edits: a scene removed, and a narration line rewritten.
    graph = store.load_graph(project.id)
    for node_id in [n for n in graph.nodes if n.startswith("s2.")]:
        graph.nodes.pop(node_id)
    graph.edges = [
        e for e in graph.edges if not (e.src.startswith("s2.") or e.dst.startswith("s2."))
    ]
    graph.nodes["s1.narration"].params["text"] = "CUSTOM NARRATION MARKER"
    store.save_graph(project.id, graph)

    # Seed the script artifact so the export can carry it, the way a rendered
    # project would.
    script_hash = graph.output_hash("script")
    generated = store.generated_dir(project.id)
    generated.mkdir(parents=True, exist_ok=True)
    (generated / f"{script_hash}.screenplay.json").write_text(
        screenplay.model_dump_json(), encoding="utf-8"
    )

    document = service.export_template(project.id, name="probe")
    assert document["screenplay"] is not None, "the template did not carry the screenplay"

    imported = service.create_from_template(from_template(document), title="copy")
    copied = store.load_graph(imported.id)

    assert "s2.clip" not in copied.nodes, "a deleted scene came back"
    assert copied.nodes["s1.narration"].params["text"] == "CUSTOM NARRATION MARKER"
    # And the script node is cached, so nothing will re-render it and undo
    # any of the above.
    assert store.resolve_artifact(imported.id, copied.output_hash("script")) is not None


def test_a_screenplay_is_only_seeded_onto_a_real_script_node(tmp_path):
    """A template is an untrusted document, and the seed writes a file at a
    node's content address. A node named "script" of another kind would take
    the screenplay artifact for its OWN hash, so it would read as cached and
    hand a screenplay to the renderer as its output. The seed must key on the
    node's KIND, not on the name "script" being present.
    """
    from localcut_engine.graph.template_io import from_template

    store, _queue, service = _service(tmp_path)

    # A hostile document: a music node wearing the name "script", carrying a
    # screenplay it wants written at that node's address.
    document = _document()
    document["nodes"] = {"script": {"id": "script", "kind": "music", "params": {"prompt": "a bed"}}}
    document["edges"] = []
    document["screenplay"] = {"title": "planted", "hook": "", "scenes": []}

    project = service.create_from_template(from_template(document), title="hostile")
    graph = store.load_graph(project.id)

    assert graph.nodes["script"].kind is NodeKind.MUSIC
    # Nothing was planted at the music node's address.
    assert store.resolve_artifact(project.id, graph.output_hash("script")) is None
    assert list(store.generated_dir(project.id).glob("*.screenplay.json")) == []


def test_a_template_without_a_screenplay_still_imports(tmp_path):
    """A v1 document, or a project whose script never rendered. The scenes
    still arrive; the script simply has to render on first use."""
    from localcut_engine.graph.templates import prompt_template_graph
    from localcut_engine.graph.template_io import from_template

    store, _queue, service = _service(tmp_path)
    project = store.create(
        title="source",
        graph=prompt_template_graph("a hummingbird", target_duration_s=30),
        mode="prompt",
    )
    document = service.export_template(project.id, name="probe")
    assert document["screenplay"] is None

    imported = service.create_from_template(from_template(document), title="copy")
    assert "script" in store.load_graph(imported.id).nodes


@pytest.fixture
async def mock_rig(tmp_path):
    """A service with a scheduler on the mock chain, so a project renders."""
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


async def _until_exported(service: ProjectService, project_id: str) -> dict:
    async with asyncio.timeout(15.0):
        while True:
            board = service.scene_board(project_id)
            if (board["aux"].get("export") or {}).get("artifact_hash"):
                return board
            await asyncio.sleep(0.05)


async def test_a_project_made_with_uploads_exports_a_template_that_renders(mock_rig):
    """The round trip through the service, on a rendered project: its
    screenplay travels, so the imported script arrives cached and nothing
    re-expands the scenes to repair the wiring. Whatever the export wrote is
    the graph the importer gets."""
    store, queue, service = mock_rig
    # 20s on the mock is two 10s scenes, and 10s splits into two takes.
    source = service.create_from_prompt("tide pools", target_duration_s=20)
    await _until_exported(service, source.id)
    still = service.add_asset(source.id, "still.png", b"\x89PNG\r\n\x1a\n" + b"x" * 32)
    track = service.add_asset(source.id, "track.wav", b"RIFF" + b"x" * 32)
    service.patch(
        source.id,
        [
            PatchOp(op="connect", node_id="s1.clip", src=still["node_id"], port="keyframe"),
            PatchOp(op="connect", node_id="s1.clip2", src=still["node_id"], port="keyframe"),
            PatchOp(op="connect", node_id="timeline", src=track["node_id"], port="music"),
        ],
    )

    document = service.export_template(source.id)
    assert document["screenplay"] is not None
    copy = service.create_from_template(from_template(document))

    board = service.scene_board(copy.id)
    states = [
        state
        for card in board["scenes"]
        for state in (
            card["keyframe"],
            card["clip"],
            card["narration"],
            *card.get("clip_takes", []),
        )
    ] + list(board["aux"].values())
    assert {
        s["node_id"]: s["status"] for s in states if s["status"] in ("blocked", "skipped")
    } == {}

    board = await _until_exported(service, copy.id)
    assert not [job for job in queue.list(copy.id, 1000) if job.status is JobStatus.FAILED]
    timeline = store.resolve_artifact(copy.id, board["aux"]["timeline"]["artifact_hash"])
    assert "music" in json.loads(timeline.read_text(encoding="utf-8"))["inputs"]
