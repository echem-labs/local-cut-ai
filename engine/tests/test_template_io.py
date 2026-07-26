"""Story-graph templates, treated as the untrusted documents they are.

A template is the one artifact of this project designed to travel between
machines and, eventually, between people who have never met (doc 08's
marketplace waits on this format). So the tests that matter are not "does a
round trip work" — they are "what does a hostile or merely wrong document
do", because every one of those answers becomes a security property the
moment a template arrives from someone else.
"""

from __future__ import annotations

import pytest

from localcut_engine.events import EventBus
from localcut_engine.graph.model import Edge, Node, NodeKind, StoryGraph
from localcut_engine.graph.template_io import (
    MAX_NODES,
    TEMPLATE_VERSION,
    TemplateError,
    build_graph,
    cloud_models,
    from_template,
    to_template,
)
from localcut_engine.jobs.queue import JobQueue
from localcut_engine.project.store import ProjectStore
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
    node that isn't there. Dropping the edge too puts the keyframe back in
    the render path, so the template produces every scene."""
    graph = _graph()
    graph.add_node(Node(id="asset-1", kind=NodeKind.ASSET, params={"sha256": "a" * 64}))
    # Conditioning: the asset displaces the generated keyframe.
    graph.edges = [e for e in graph.edges if not (e.dst == "s1.clip" and e.port == "keyframe")]
    graph.connect("asset-1", "s1.clip", port="keyframe")

    template = to_template(graph, name="Conditioned")

    assert "asset-1" not in template.nodes
    assert template.dropped_assets == 1, "the export has to say something was left behind"
    assert not [e for e in template.edges if "asset-1" in (e.src, e.dst)]
    # And the graph it builds is renderable: nothing points at the missing node.
    build_graph(template).topological_order()


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
