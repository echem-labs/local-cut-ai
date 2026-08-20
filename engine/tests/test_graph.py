from localcut_engine.graph import templates
from localcut_engine.graph.compiler import compile_graph
from localcut_engine.graph.model import Node, NodeKind, StoryGraph
from localcut_engine.graph.patch import PatchOp, apply_patch
from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph, tool_graph
from localcut_engine.backends.mock import mock_screenplay

import pytest


def small_graph() -> StoryGraph:
    g = StoryGraph()
    g.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "octopus"}))
    g.add_node(Node(id="kf", kind=NodeKind.KEYFRAME, params={"prompt": "eye"}))
    g.add_node(Node(id="clip", kind=NodeKind.CLIP, params={"motion": "push"}))
    g.connect("script", "kf")
    g.connect("kf", "clip", port="keyframe")
    return g


def test_output_hash_stable_and_input_sensitive():
    g = small_graph()
    h1 = g.output_hash("clip")
    assert h1 == small_graph().output_hash("clip")
    g.nodes["script"].params["prompt"] = "changed"
    assert g.output_hash("clip") != h1  # upstream change propagates


def test_seed_changes_hash_but_not_siblings():
    g = small_graph()
    kf_before = g.output_hash("kf")
    g.nodes["clip"].seed = 7
    assert g.output_hash("kf") == kf_before


def test_topological_order_and_cycle_detection():
    g = small_graph()
    order = g.topological_order()
    assert order.index("script") < order.index("kf") < order.index("clip")
    g.edges.append(type(g.edges[0])(src="clip", dst="script"))
    with pytest.raises(ValueError, match="cycle"):
        g.topological_order()


def test_compile_skips_cached_nodes():
    g = small_graph()
    memo: dict[str, str] = {}
    cached = {g.output_hash("script", memo), g.output_hash("kf", memo)}
    plan = compile_graph(g, cached)
    assert [j.node_id for j in plan.jobs] == ["clip"]
    assert set(plan.cached) == {"script", "kf"}


def test_pinned_node_not_recompiled_even_when_dirty():
    g = small_graph()
    frozen_hash = g.output_hash("kf")  # artifact rendered before the edit
    g.nodes["kf"].pinned = True
    g.nodes["script"].params["prompt"] = "new prompt"  # dirties kf's hash
    plan = compile_graph(g, cache_hashes=set(), frozen={"kf": frozen_hash})
    assert "kf" not in [j.node_id for j in plan.jobs]
    # Downstream hashes against the frozen artifact, not the would-be new
    # keyframe — so its input actually resolves to a file that exists.
    clip_job = next(j for j in plan.jobs if j.node_id == "clip")
    assert clip_job.input_hashes["keyframe"] == frozen_hash


def test_unfrozen_pinned_node_renders_once():
    g = small_graph()
    g.nodes["kf"].pinned = True  # pinned before it ever rendered
    plan = compile_graph(g, cache_hashes=set(), frozen={})
    assert "kf" in [j.node_id for j in plan.jobs]


def test_patch_dirties_downstream_cone():
    g = small_graph()
    dirty = apply_patch(g, [PatchOp(op="set_params", node_id="kf", params={"prompt": "x"})])
    assert dirty == {"kf", "clip"}
    assert g.nodes["kf"].params["prompt"] == "x"


def test_pin_dirties_nothing():
    g = small_graph()
    assert apply_patch(g, [PatchOp(op="pin", node_id="kf")]) == set()
    assert g.nodes["kf"].pinned


def test_pin_snapshots_output_identity_on_the_node():
    """The freeze must not depend on job history (which is windowed): the
    hash is captured on the node at pin time and cleared on unpin."""
    g = small_graph()
    expected = g.output_hash("kf")
    apply_patch(g, [PatchOp(op="pin", node_id="kf")])
    assert g.nodes["kf"].frozen_hash == expected
    # An upstream edit must not move the snapshot.
    apply_patch(g, [PatchOp(op="set_params", node_id="script", params={"prompt": "new"})])
    assert g.nodes["kf"].frozen_hash == expected
    apply_patch(g, [PatchOp(op="unpin", node_id="kf")])
    assert g.nodes["kf"].frozen_hash is None


def test_node_ids_are_constrained():
    """Patch bodies must not smuggle in ids the API's path params reject."""
    with pytest.raises(ValueError):
        Node(id=".leading-dot", kind=NodeKind.CLIP)
    with pytest.raises(ValueError):
        Node(id="a" * 200, kind=NodeKind.CLIP)


def test_expansion_writes_caption_ground_truth_and_caps_music():
    """Captions carry each scene's narration verbatim — that param is what
    stops the aligner captioning a misheard homophone. Music is a loopable
    bed, so its request stays capped however long the video is."""
    g = prompt_template_graph("solar flares", target_duration_s=1200)
    screenplay = mock_screenplay("solar flares", 1200, "9:16", seed=0)
    expand_screenplay(g, screenplay)
    assert g.nodes["captions"].params["texts"] == {
        scene.id: scene.narration for scene in screenplay.scenes
    }
    # The bed is looped by assembly, so it is capped at MAX_MUSIC_S — not
    # merely at what the generator would accept.
    assert g.nodes["music"].params["target_duration_s"] == templates.MAX_MUSIC_S


def test_mock_screenplay_scenes_validate_across_duration_range():
    """The API accepts 5–1200s; every target in range must yield scenes the
    schema accepts (duration_s ≤ 60) — the 10-scene cap alone would not."""
    for target in (5, 24, 60, 600, 601, 900, 1200):
        screenplay = mock_screenplay("solar flares", target, "9:16", seed=0)
        assert all(scene.duration_s <= 60 for scene in screenplay.scenes)
        total = sum(scene.duration_s for scene in screenplay.scenes)
        assert abs(total - target) < len(screenplay.scenes)  # rounding only


def test_template_expansion_builds_full_pipeline():
    g = prompt_template_graph("why octopuses have three hearts", target_duration_s=40)
    screenplay = mock_screenplay("why octopuses have three hearts", 40, "9:16", seed=0)
    expand_screenplay(g, screenplay)
    assert "timeline" in g.nodes and "export" in g.nodes and "music" in g.nodes
    scene_clips = [n for n in g.nodes if n.endswith(".clip")]
    assert len(scene_clips) == len(screenplay.scenes) >= 2
    order = g.topological_order()
    assert order.index("timeline") < order.index("export")


def test_conditioning_edge_survives_reexpansion_and_disconnect_restores():
    """A clip whose keyframe port was rewired to an uploaded asset must keep
    that source when the screenplay re-expands; disconnecting frees the port
    for the next expansion to re-wire the generated keyframe."""
    from localcut_engine.graph.model import Node, NodeKind
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    graph.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))

    dirty = apply_patch(
        graph, [PatchOp(op="connect", node_id="s1.clip", src="asset-abc", port="keyframe")]
    )
    assert "s1.clip" in dirty and "timeline" in dirty

    def keyframe_sources():
        return [e.src for e in graph.edges if e.dst == "s1.clip" and e.port == "keyframe"]

    assert keyframe_sources() == ["asset-abc"]
    expand_screenplay(graph, screenplay)  # re-script must not displace the asset
    assert keyframe_sources() == ["asset-abc"]

    apply_patch(graph, [PatchOp(op="disconnect", node_id="s1.clip", port="keyframe")])
    assert keyframe_sources() == []
    expand_screenplay(graph, screenplay)  # …and the free port re-wires normally
    assert keyframe_sources() == ["s1.keyframe"]


def test_connect_rejects_cycles_and_self_loops():
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)

    import pytest

    # A self-loop and a back-edge (timeline is downstream of s1.clip) both
    # raise before any edge is added — the graph never persists a cycle.
    with pytest.raises(ValueError, match="cycle"):
        apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="s1.clip", port="x")])
    with pytest.raises(ValueError, match="cycle"):
        apply_patch(graph, [PatchOp(op="connect", node_id="script", src="timeline", port="x")])
    # The graph is still acyclic and readable.
    assert graph.topological_order()


def test_voice_ref_rejects_unconsented_sources():
    from localcut_engine.graph.model import Node, NodeKind
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    import pytest

    screenplay = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
    )
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    graph.add_node(Node(id="img", kind=NodeKind.ASSET, params={"sha256": "x"}))  # no consent
    graph.add_node(
        Node(id="voice", kind=NodeKind.ASSET, params={"sha256": "y", "voice_consent": True})
    )

    with pytest.raises(ValueError, match="consented voice-sample"):
        apply_patch(
            graph, [PatchOp(op="connect", node_id="s1.narration", src="img", port="voice_ref")]
        )
    # A wav from another node (not an asset) is likewise refused.
    with pytest.raises(ValueError, match="consented voice-sample"):
        apply_patch(
            graph,
            [PatchOp(op="connect", node_id="s1.narration", src="s1.keyframe", port="voice_ref")],
        )
    # The consented sample is accepted.
    apply_patch(
        graph, [PatchOp(op="connect", node_id="s1.narration", src="voice", port="voice_ref")]
    )
    assert any(e.src == "voice" and e.port == "voice_ref" for e in graph.edges)


def test_conditioning_applies_to_every_take_of_a_split_scene():
    """A scene conditioned on an asset that later splits into takes animates
    all takes from the asset, not the generated keyframe for the new ones."""
    from localcut_engine.graph.model import Node, NodeKind
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("p")
    short = Screenplay(
        title="t", scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")]
    )
    expand_screenplay(graph, short)
    graph.add_node(Node(id="img", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(graph, [PatchOp(op="connect", node_id="s1.clip", src="img", port="keyframe")])

    # The narration grows so the scene now needs two takes.
    long = Screenplay(
        title="t",
        scenes=[Scene(id="s1", duration_s=14.0, narration="much longer", visual="v", motion="m")],
    )
    expand_screenplay(graph, long)
    assert "s1.clip2" in graph.nodes  # split happened
    for take in ("s1.clip", "s1.clip2"):
        srcs = [e.src for e in graph.edges if e.dst == take and e.port == "keyframe"]
        assert srcs == ["img"], f"{take} should animate from the asset, got {srcs}"


def test_set_params_cannot_forge_voice_consent():
    """The consent flag is server-owned: a client set_params must not be able
    to stamp it onto an asset, or the voice_ref guard is bypassable."""
    from localcut_engine.graph.model import Node, NodeKind
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    import pytest

    graph = expand_screenplay(
        prompt_template_graph("p"),
        Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
        ),
    )
    # An audio-as-image asset that never went through the consent gate.
    graph.add_node(Node(id="sneak", kind=NodeKind.ASSET, params={"sha256": "z"}))
    apply_patch(graph, [PatchOp(op="set_params", node_id="sneak", params={"voice_consent": True})])
    assert "voice_consent" not in graph.nodes["sneak"].params  # forge stripped

    # And so the wire is still refused.
    with pytest.raises(ValueError, match="consented voice-sample"):
        apply_patch(
            graph, [PatchOp(op="connect", node_id="s1.narration", src="sneak", port="voice_ref")]
        )


def test_add_node_cannot_forge_voice_consent():
    """The reserved-param strip must also cover add_node — otherwise a client
    can create an asset node carrying a forged voice_consent and defeat the
    voice_ref guard without ever calling set_params."""
    from localcut_engine.graph.model import Node, NodeKind
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    import pytest

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
                op="add_node",
                node_id="forged",
                node=Node(
                    id="forged",
                    kind=NodeKind.ASSET,
                    params={"sha256": "z", "voice_consent": True},
                ),
            )
        ],
    )
    assert "voice_consent" not in graph.nodes["forged"].params  # forge stripped
    with pytest.raises(ValueError, match="consented voice-sample"):
        apply_patch(
            graph, [PatchOp(op="connect", node_id="s1.narration", src="forged", port="voice_ref")]
        )


def test_unpin_dirties_node_and_its_cone():
    """Unpinning can change a node's effective output (it stops resolving to
    the frozen artifact), so it must dirty the node and its downstream cone —
    a bare 'continue' would report nothing dirty and leave stale artifacts."""
    from localcut_engine.graph.patch import PatchOp, apply_patch
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.schema import Scene, Screenplay

    graph = expand_screenplay(
        prompt_template_graph("p"),
        Screenplay(
            title="t",
            scenes=[Scene(id="s1", duration_s=4.0, narration="hi", visual="v", motion="m")],
        ),
    )
    assert (
        apply_patch(graph, [PatchOp(op="pin", node_id="s1.clip")]) == set()
    )  # pin dirties nothing
    dirty = apply_patch(graph, [PatchOp(op="unpin", node_id="s1.clip")])
    assert "s1.clip" in dirty
    assert graph.downstream_of("s1.clip") <= dirty  # the whole cone re-renders
    assert not graph.nodes["s1.clip"].pinned


def test_reexpansion_keeps_user_only_narration_params():
    """Speech speed has no screenplay source, so re-expansion must not wipe
    it — the node hash would revert and serve the pre-edit audio."""
    g = prompt_template_graph("tide pools", target_duration_s=24)
    screenplay = mock_screenplay("tide pools", 24, "9:16", seed=0)
    expand_screenplay(g, screenplay)
    g.nodes["s1.narration"].params["speed"] = 0.8
    edited = g.output_hash("s1.narration")

    expand_screenplay(g, mock_screenplay("tide pools", 24, "9:16", seed=0))
    assert g.nodes["s1.narration"].params.get("speed") == 0.8
    assert g.output_hash("s1.narration") == edited


def test_reexpansion_keeps_user_only_export_params():
    """The encode choices are the user's, not the screenplay's. Only
    `captions` survived re-expansion, so a frame rate or resolution picked
    in the board menu reverted to Auto the next time the script rendered —
    silently, with the menu still showing the old choice until it refreshed."""
    g = prompt_template_graph("tide pools", target_duration_s=24)
    screenplay = mock_screenplay("tide pools", 24, "9:16", seed=0)
    expand_screenplay(g, screenplay)
    export = g.nodes["export"]
    export.params.update({"captions": "sidecar", "fps": 60, "resolution": 1080, "video_kbps": 9000})
    edited = g.output_hash("export")

    expand_screenplay(g, mock_screenplay("tide pools", 24, "9:16", seed=0))
    assert g.nodes["export"].params["captions"] == "sidecar"
    assert g.nodes["export"].params["fps"] == 60
    assert g.nodes["export"].params["resolution"] == 1080
    assert g.nodes["export"].params["video_kbps"] == 9000
    assert g.output_hash("export") == edited


def test_music_tool_honours_the_request_up_to_the_generator_ceiling():
    """The standalone tool is not the looped assembly bed, so it keeps the
    length the user asked for — but never past what the generator accepts,
    or the job just fails."""
    g = tool_graph("music", {"prompt": "lofi", "target_duration_s": 300})
    assert g.nodes["music"].params["target_duration_s"] == 300

    g = tool_graph("music", {"prompt": "lofi", "target_duration_s": 1200})
    assert g.nodes["music"].params["target_duration_s"] == templates.GENERATOR_MAX_MUSIC_S


def test_every_quick_tool_compiles_to_at_least_one_job():
    """A Quick Tool's node IS its deliverable, so nothing in the graph is
    orphaned. The `image` tool is a bare KEYFRAME with no outgoing edge, and
    KEYFRAME is not a terminal kind — it compiled to zero jobs, so the tool
    produced nothing, forever, with no error anywhere to say so."""
    for tool, extra in (
        ("script", {}),
        ("thumbnail", {}),
        ("voiceover", {"text": "hello"}),
        ("image", {}),
        ("music", {}),
        ("clip", {}),
    ):
        plan = compile_graph(tool_graph(tool, {"prompt": "a subject", **extra}))
        assert plan.jobs, f"{tool} tool compiled to no jobs at all"


def test_a_displaced_keyframe_is_still_orphaned_inside_a_clip_tool():
    """The exemption is for graphs with no deliverable, not a blanket pass:
    conditioning the clip tool on an uploaded image must still stop the
    generated keyframe from rendering a picture nobody will see."""
    g = tool_graph("clip", {"prompt": "a subject"})
    g.add_node(Node(id="asset-abc", kind=NodeKind.ASSET, params={"sha256": "x"}))
    apply_patch(g, [PatchOp(op="connect", node_id="clip", src="asset-abc", port="keyframe")])

    assert [job.node_id for job in compile_graph(g).jobs] == ["clip"]


def test_the_script_node_cannot_be_removed():
    """The one removal with no way back, and one-way twice over.

    Every other pipeline node — timeline, export, captions, music, the scene
    subgraphs — is rebuilt by expand_screenplay next time the script renders,
    because _ensure_node is idempotent on purpose. That repair runs FROM the
    script node and expand_screenplay raises without one, so removing it does
    not merely delete a node: it deletes the mechanism that made every other
    deletion recoverable. Nothing in the app adds a node back — the LLM
    editor's whole vocabulary is update and remove_scene.
    """
    g = small_graph()

    with pytest.raises(ValueError, match="cannot be removed"):
        apply_patch(g, [PatchOp(op="remove_node", node_id="script")])

    assert "script" in g.nodes


def test_every_other_node_still_removes():
    """The guard is one node, not a policy about structural nodes: the rest
    are recoverable, so refusing them would be inventing a rule the advanced
    and flowchart modes have not asked for."""
    g = small_graph()

    apply_patch(g, [PatchOp(op="remove_node", node_id="kf")])

    assert set(g.nodes) == {"script", "clip"}


def test_removing_the_script_is_refused_even_mid_patch():
    """Ops apply in order and mutate as they go, so a refusal on op 3 has
    already let ops 1 and 2 through. The point is that the script survives,
    which is what makes the rest rebuildable."""
    g = small_graph()

    with pytest.raises(ValueError, match="cannot be removed"):
        apply_patch(
            g,
            [
                PatchOp(op="set_params", node_id="kf", params={"prompt": "x"}),
                PatchOp(op="remove_node", node_id="script"),
            ],
        )

    assert "script" in g.nodes


def test_clearing_a_param_returns_to_the_unset_hash():
    """ "Back to the default" must land on the identity the node had before
    the value was ever set, or the artifact already rendered for that state
    can never be a cache hit again — an export toggled to 30 fps and back
    to Auto re-encoded the whole video for a result it already had."""
    graph = small_graph()
    pristine = graph.output_hash("clip")

    apply_patch(graph, [PatchOp(op="set_params", node_id="clip", params={"fps": 30})])
    assert graph.output_hash("clip") != pristine  # a real change re-renders

    apply_patch(graph, [PatchOp(op="set_params", node_id="clip", params={"fps": None})])
    assert "fps" not in graph.nodes["clip"].params
    assert graph.output_hash("clip") == pristine


def test_clearing_one_param_leaves_the_others_alone():
    graph = small_graph()
    apply_patch(
        graph,
        [PatchOp(op="set_params", node_id="clip", params={"fps": 30, "resolution": 720})],
    )
    apply_patch(graph, [PatchOp(op="set_params", node_id="clip", params={"fps": None})])
    assert graph.nodes["clip"].params["resolution"] == 720
    assert "fps" not in graph.nodes["clip"].params


def test_no_op_can_store_a_null_on_a_node():
    """The rule above is about the params a node MAY HOLD, not about one op.

    `set_params` was the only route that enforced it, and it is not the only
    route params arrive on. A null that lands by any other door is a value
    every reader then acts on: `params.get("captions", "burn")` returns None,
    so an export silently stops burning the captions it was asked for, and
    nothing can clear the key again — `set_params` drops only what THIS op
    cleared, by design.
    """
    reference = StoryGraph()
    reference.add_node(Node(id="export", kind=NodeKind.EXPORT, params={"captions": "burn"}))
    apply_patch(reference, [PatchOp(op="set_params", node_id="export", params={"captions": None})])
    unset = reference.output_hash("export")

    added = StoryGraph()
    apply_patch(
        added,
        [
            PatchOp(
                op="add_node",
                node_id="export",
                node=Node(id="export", kind=NodeKind.EXPORT, params={"captions": None}),
            )
        ],
    )
    assert added.nodes["export"].params == {}
    assert added.output_hash("export") == unset
    # The read that misfires, spelled out: this is ffmpeg.py's own expression.
    assert added.nodes["export"].params.get("captions", "burn") == "burn"

    # select_take restores a recorded identity wholesale, so a take recorded
    # from a graph that predates this rule must not put the null back.
    selected = StoryGraph()
    selected.add_node(Node(id="export", kind=NodeKind.EXPORT, params={"captions": "burn"}))
    apply_patch(
        selected,
        [PatchOp(op="select_take", node_id="export", params={"captions": None}, seed=0)],
    )
    assert selected.nodes["export"].params == {}
    assert selected.output_hash("export") == unset


def test_add_node_cannot_arrive_pre_pinned_to_an_artifact_the_client_chose():
    """`pinned`/`frozen_hash` are server state on the same node params are.

    The `pin` op computes the hash itself from the live graph and template
    import zeroes both, because a pin is a claim about an artifact that
    exists. A client-supplied pair is that claim forged: `_frozen_pins`
    honours any frozen_hash the project has cached, and every downstream
    node then hashes -- and resolves its input artifact -- against the file
    the caller named rather than against what this graph would produce.
    """
    graph = StoryGraph()
    apply_patch(
        graph,
        [
            PatchOp(
                op="add_node",
                node_id="s1.clip",
                node=Node(
                    id="s1.clip",
                    kind=NodeKind.CLIP,
                    params={"prompt": "a shore"},
                    pinned=True,
                    frozen_hash="deadbeefdeadbeef",
                ),
            )
        ],
    )

    assert graph.nodes["s1.clip"].pinned is False
    assert graph.nodes["s1.clip"].frozen_hash is None


def test_expansion_does_not_replant_a_null_the_user_can_never_clear():
    """The carry-forwards in `expand_screenplay` test for the KEY, not for a
    value, because a legitimately-set param must survive a re-expansion that
    replaces the node's params wholesale.

    A null therefore rode along too -- copied back over the correct default
    on every script render, so `{"captions": None}` planted once turned off
    burned captions permanently. Nothing could clear it: `set_params` drops
    only what THAT op cleared, and the app never sends `captions: null`. The
    export menu went on showing the setting the user asked for while ffmpeg
    read `params.get("captions", "burn")` as None.
    """
    graph = expand_screenplay(prompt_template_graph("p"), mock_screenplay("p", 24, "9:16", seed=0))
    graph.nodes["export"].params["captions"] = None
    graph.nodes["export"].params["fps"] = None
    graph.nodes["timeline"].params["ducking"] = None

    expand_screenplay(graph, mock_screenplay("p", 24, "9:16", seed=0))

    export = graph.nodes["export"].params
    assert export["captions"] == "burn"  # ffmpeg.py's own default, restored
    assert "fps" not in export
    assert "ducking" not in graph.nodes["timeline"].params

    # A real user choice still survives the same re-expansion -- the point of
    # the carry-forward is not lost in fixing it.
    graph.nodes["export"].params["fps"] = 30
    expand_screenplay(graph, mock_screenplay("p", 24, "9:16", seed=0))
    assert graph.nodes["export"].params["fps"] == 30


def test_a_narration_version_bump_re_addresses_cached_audio():
    """The language a voice is phonemized with is derived inside the
    backend, not stored in params — so a change to that rule produces
    different audio for a node whose text, voice and speed are identical,
    and the existence cache would serve the old wav forever. Carrying the
    version in params is what moves the hash, the way edl_version does for
    the timeline.
    """
    from localcut_engine.graph.model import NARRATION_VERSION

    g = StoryGraph()
    g.add_node(Node(id="script", kind=NodeKind.SCRIPT, params={"prompt": "p"}))
    g.add_node(
        Node(
            id="s1.narration",
            kind=NodeKind.NARRATION,
            params={"text": "hi", "voice": "british", "narration_version": NARRATION_VERSION},
        )
    )
    g.connect("script", "s1.narration")
    current = g.output_hash("s1.narration")

    g.nodes["s1.narration"].params["narration_version"] = NARRATION_VERSION - 1
    assert g.output_hash("s1.narration") != current
    # And audio from before the field existed at all is re-addressed too.
    del g.nodes["s1.narration"].params["narration_version"]
    assert g.output_hash("s1.narration") != current


def test_every_narration_node_a_template_builds_carries_its_version():
    """Stamped at creation, not only back-filled on load: a node minted
    without it has its artifact re-addressed the first time the project
    reloads, which orphans the audio the job just rendered."""
    from localcut_engine.graph.model import NARRATION_VERSION

    screenplay = mock_screenplay("octopuses", target_duration_s=30, aspect="16:9", seed=1)
    graphs = [
        expand_screenplay(prompt_template_graph("p"), screenplay),
        tool_graph("voiceover", {"text": "one small step"}),
    ]
    narration_nodes = [
        node for g in graphs for node in g.nodes.values() if node.kind is NodeKind.NARRATION
    ]
    assert narration_nodes, "no narration nodes to check"
    for node in narration_nodes:
        assert node.params.get("narration_version") == NARRATION_VERSION, (
            f"{node.id} was built without narration_version"
        )


def test_a_picked_voice_survives_a_re_expansion():
    """Like speed, an explicitly picked voice has no screenplay source — it
    exists only because the user chose it. Dropping it on re-expansion
    reverts the node hash, so the cached pre-pick audio is served and the
    picker shows the brief's voice again with nothing to say why."""
    from localcut_engine.graph.model import NARRATION_VERSION

    screenplay = mock_screenplay("octopuses", target_duration_s=30, aspect="16:9", seed=1)
    graph = expand_screenplay(prompt_template_graph("p"), screenplay)
    narr_id = next(n.id for n in graph.nodes.values() if n.kind is NodeKind.NARRATION)
    graph.nodes[narr_id].params["voice_id"] = "bm_george"
    graph.nodes[narr_id].params["speed"] = 1.2

    again = expand_screenplay(graph, screenplay)
    assert again.nodes[narr_id].params["voice_id"] == "bm_george"
    assert again.nodes[narr_id].params["speed"] == 1.2
    assert again.nodes[narr_id].params["narration_version"] == NARRATION_VERSION
