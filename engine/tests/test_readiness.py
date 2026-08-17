"""Preflight readiness - what tier will actually serve each node kind.

The chain's silent degradation (spec doc 12) is deliberate at render time;
these tests pin the one place that is required to SAY it: a readiness row
per (kind, model) with a verdict, a stable reason code, and - where the
engine knows one - a machine-actionable fix. Verdicts must flip live, the
same contract the capability tests hold the backends to.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest

from localcut_engine.api.app import _build_backends, create_app
from localcut_engine.backends.base import ServiceProbe
from localcut_engine.backends.llm import LLMScriptBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import NodeKind
from localcut_engine.manifest.defaults import set_default
from localcut_engine.readiness import readiness_rows

_FFMPEG_EXE = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"


def _by_kind(rows: list[dict]) -> dict[str, dict]:
    return {row["kind"]: row for row in rows}


def _planted_ffmpeg(tmp_path) -> str:
    """A discoverable managed ffmpeg — the backend gates on the file, not on
    whether it runs."""
    binary = tmp_path / "bin" / _FFMPEG_EXE
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.touch()
    return str(binary)


def _bare_config(tmp_path) -> EngineConfig:
    """The shipped hybrid chain on a machine with nothing: no Ollama, no
    ComfyUI, no weights, no ffmpeg. Closed-port URLs make probes refuse
    instantly."""
    return EngineConfig(
        data_dir=tmp_path,
        backend="local,mock",
        llm_url="http://127.0.0.1:9/v1",
        comfyui_url="http://127.0.0.1:9",
        ffmpeg_bin=str(tmp_path / "missing" / "ffmpeg"),
    )


async def test_bare_machine_reports_every_fallback_tier(tmp_path):
    """One row per kind, each naming today's silent behavior out loud:
    placeholders for the generative kinds, a hard failure for assembly -
    and a download fix wherever the packaged manifest has a candidate."""
    config = _bare_config(tmp_path)
    backends = _build_backends(config)
    kinds = [
        NodeKind.SCRIPT,
        NodeKind.KEYFRAME,
        NodeKind.CLIP,
        NodeKind.NARRATION,
        NodeKind.CAPTIONS,
        NodeKind.MUSIC,
        NodeKind.EXPORT,
    ]
    rows = _by_kind(await readiness_rows(config, backends, [(kind, None) for kind in kinds]))

    # Ollama down: mock will fabricate a screenplay.
    assert rows["script"]["verdict"] == "placeholder"
    assert rows["script"]["reason"] == "llm_server_down"

    # No weights: mock placeholders, each with the packaged manifest's
    # first downloadable candidate as the fix.
    assert rows["keyframe"]["verdict"] == "placeholder"
    assert rows["keyframe"]["reason"] == "no_model_installed"
    assert rows["keyframe"]["fix"]["type"] == "download"
    assert rows["keyframe"]["fix"]["model_id"] == "sdxl-base-1.0"
    assert rows["keyframe"]["fix"]["size_bytes"] > 0

    assert rows["music"]["verdict"] == "placeholder"
    assert rows["music"]["reason"] == "no_model_installed"
    assert rows["music"]["fix"]["model_id"] == "ace-step-v1-3.5b"

    # No video model AND no ffmpeg: even the still-clip tier is gone.
    assert rows["clip"]["verdict"] == "placeholder"
    assert rows["clip"]["reason"] == "no_model_installed"
    assert rows["clip"]["fix"]["model_id"] == "wan2.2-i2v-14b-fp8"

    assert rows["narration"]["verdict"] == "placeholder"
    assert rows["narration"]["fix"]["model_id"] == "kokoro-82m"
    assert rows["captions"]["verdict"] == "placeholder"
    assert rows["captions"]["fix"]["model_id"] == "faster-whisper-base-en"

    # Assembly never degrades to a placeholder - it fails, and the row
    # says so before the render does.
    assert rows["export"]["verdict"] == "will_fail"
    assert rows["export"]["reason"] == "no_ffmpeg"
    assert rows["export"]["fix"] == {"type": "install_ffmpeg"}


def _tiny_manifest(tmp_path) -> None:
    (tmp_path / "model-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "models": [
                    {
                        "id": "tiny-i2v",
                        "task": "video.i2v",
                        "family": "test",
                        "requirements": {"vram_gb": 1, "disk_gb": 1},
                        "license": {"id": "mit", "commercial": True},
                        "comfy_graph_template": "clip_default.json",
                        "files": [
                            {
                                "url": "http://localhost/w",
                                "dest": "checkpoints/tiny.safetensors",
                                "size": 7,
                            }
                        ],
                    }
                ],
            }
        )
    )


async def test_still_clip_tier_reads_degraded_until_weights_land(tmp_path, monkeypatch):
    """CLIP falling to the ffmpeg still tier is a real-but-degraded render,
    and the verdict flips to ready the moment the download lands - same
    registry, no rebuild, mirroring the capability tests."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    managed_ffmpeg = tmp_path / "bin" / _FFMPEG_EXE
    managed_ffmpeg.parent.mkdir(parents=True)
    managed_ffmpeg.touch()
    _tiny_manifest(tmp_path)

    config = EngineConfig(data_dir=tmp_path, backend="comfy,ffmpeg,mock")
    backends = _build_backends(config)

    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, None)])
    assert row["verdict"] == "degraded"
    assert row["reason"] == "still_clip_tier"
    assert row["fix"] == {"type": "download", "model_id": "tiny-i2v", "size_bytes": 7}

    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")
    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, None)])
    assert row["verdict"] == "ready"
    assert row["reason"] == "ok"
    # What Auto resolves to, named - the honest-Auto label reads this.
    assert row["model"] == "tiny-i2v"
    assert row["backend"] == "comfyui"


async def test_installed_weights_with_comfyui_down_read_comfyui_down(tmp_path):
    """Weights on disk but no ComfyUI answering is a different fact from
    "nothing installed" - the fix is not a download."""
    _tiny_manifest(tmp_path)
    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")
    managed_ffmpeg = tmp_path / "bin" / _FFMPEG_EXE
    managed_ffmpeg.parent.mkdir(parents=True)
    managed_ffmpeg.touch()

    config = EngineConfig(
        data_dir=tmp_path, backend="comfy,ffmpeg,mock", comfyui_url="http://127.0.0.1:9"
    )
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, None)])
    assert row["verdict"] == "degraded"
    assert row["reason"] == "comfyui_down"
    assert row["fix"] is None


async def test_a_named_model_that_is_not_downloaded_will_fail(tmp_path, monkeypatch):
    """A node whose model names known-but-absent weights routes to ComfyUI
    and dies inside it - the row has to say so up front, with the download
    as the fix."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    _tiny_manifest(tmp_path)
    # A second installed model makes the kind claimable at all.
    (tmp_path / "model-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "models": [
                    {
                        "id": "tiny-i2v",
                        "task": "video.i2v",
                        "family": "test",
                        "requirements": {"vram_gb": 1, "disk_gb": 1},
                        "license": {"id": "mit", "commercial": True},
                        "comfy_graph_template": "clip_default.json",
                        "files": [
                            {
                                "url": "http://localhost/w",
                                "dest": "checkpoints/tiny.safetensors",
                                "size": 7,
                            }
                        ],
                    },
                    {
                        "id": "big-i2v",
                        "task": "video.i2v",
                        "family": "test",
                        "requirements": {"vram_gb": 1, "disk_gb": 1},
                        "license": {"id": "mit", "commercial": True},
                        "comfy_graph_template": "clip_default.json",
                        "files": [
                            {
                                "url": "http://localhost/b",
                                "dest": "checkpoints/big.safetensors",
                                "size": 9,
                            }
                        ],
                    },
                ],
            }
        )
    )
    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")

    config = EngineConfig(data_dir=tmp_path, backend="comfy,ffmpeg,mock")
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, "local:big-i2v")])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "no_model_installed"
    assert row["fix"] == {"type": "download", "model_id": "big-i2v", "size_bytes": 9}

    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, "local:tiny-i2v")])
    assert row["verdict"] == "ready"


async def test_script_rows_check_the_server_for_the_resolved_model(tmp_path, monkeypatch):
    """Auto for text.llm means the engine-config model, which the Ollama
    server may simply not have - the one place Auto points at a missing
    model and the job fails loudly. The row names the resolved model."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)

    async def fake_list_models(self) -> list[str]:
        return ["llama3.2"]

    monkeypatch.setattr(LLMScriptBackend, "list_models", fake_list_models)

    config = EngineConfig(data_dir=tmp_path, backend="llm,mock", llm_model="qwen3:14b")
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.SCRIPT, None)])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "llm_model_missing"
    assert row["data"]["model"] == "qwen3:14b"
    assert row["fix"] == {"type": "pick_model", "task": "text.llm"}

    # The persisted text.llm default is consulted live, no rebuild.
    set_default(config, "text.llm", "llama3.2")
    (row,) = await readiness_rows(config, backends, [(NodeKind.SCRIPT, None)])
    assert row["verdict"] == "ready"
    assert row["model"] == "llama3.2"

    # A server that vanished between probe and listing is still "down".
    async def gone(self) -> list[str]:
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(LLMScriptBackend, "list_models", gone)
    (row,) = await readiness_rows(config, backends, [(NodeKind.SCRIPT, None)])
    assert row["verdict"] == "placeholder"
    assert row["reason"] == "llm_server_down"


async def test_cloud_rows_check_the_key_not_the_chain(tmp_path):
    """cloud:* routes by model regardless of the chain; the row's job is the
    key check (execute fails on it today) and honesty about models no
    provider routes or no cloud backend serves."""
    config = _bare_config(tmp_path)
    backends = _build_backends(config)

    (row,) = await readiness_rows(config, backends, [(NodeKind.SCRIPT, "cloud:claude-sonnet-5")])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "cloud_key_missing"
    assert row["data"]["provider"] == "anthropic"
    assert row["fix"] == {"type": "configure_provider", "provider": "anthropic"}

    keyed = EngineConfig(**{**_bare_config(tmp_path).model_dump(), "anthropic_key": "sk-test"})
    keyed_backends = _build_backends(keyed)
    (row,) = await readiness_rows(
        keyed, keyed_backends, [(NodeKind.SCRIPT, "cloud:claude-sonnet-5")]
    )
    assert row["verdict"] == "ready"
    assert row["backend"] == "cloud"

    # A cloud model on a kind the cloud backend does not serve, and a model
    # no provider routes: both fail at execute, so both fail here.
    (row,) = await readiness_rows(
        keyed, keyed_backends, [(NodeKind.MUSIC, "cloud:claude-sonnet-5")]
    )
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "cloud_model_unknown"
    (row,) = await readiness_rows(keyed, keyed_backends, [(NodeKind.SCRIPT, "cloud:bogus-9000")])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "cloud_model_unknown"


@pytest.fixture
async def client(tmp_path):
    config = EngineConfig(data_dir=tmp_path, token="test-token", backend="mock")
    app = create_app(config)
    transport = httpx.ASGITransport(app=app)
    async with (
        transport,
        httpx.AsyncClient(
            transport=transport,
            base_url="http://engine",
            headers={"Authorization": "Bearer test-token"},
        ) as http,
    ):
        async with app.router.lifespan_context(app):
            yield http


def test_pipeline_kinds_match_a_real_expansion():
    """The project route reports an unexpanded graph against PIPELINE_KINDS.
    If the compiler starts building a kind this list omits, the preflight
    goes quiet about exactly the stage that was added."""
    from localcut_engine.graph.templates import expand_screenplay, prompt_template_graph
    from localcut_engine.readiness import PIPELINE_KINDS
    from localcut_engine.schema import Scene, Screenplay

    graph = prompt_template_graph("bees")
    expand_screenplay(
        graph,
        Screenplay(
            title="t",
            hook="h",
            target_duration_s=30,
            aspect="9:16",
            scenes=[Scene(id="s1", duration_s=6, narration="a line of narration", visual="v")],
        ),
    )
    assert {node.kind for node in graph.nodes.values()} == set(PIPELINE_KINDS)


def test_auto_covers_every_task_the_picker_can_show(tmp_path):
    """The picker labels its Auto option per task from this map, so a
    defaultable task missing from it reads "Auto" forever - which is the
    one thing the honest-Auto work exists to stop."""
    from localcut_engine.manifest.defaults import DEFAULTABLE_TASKS
    from localcut_engine.readiness import auto_defaults

    auto = auto_defaults(_bare_config(tmp_path))
    assert set(auto) == set(DEFAULTABLE_TASKS)


def test_auto_answers_with_the_stored_default_ignored(tmp_path):
    """What Auto falls back TO, not what the task resolves to today.

    Choosing Auto discards the stored pick, so a map that answered with it
    would label the option with the very value selecting it throws away.
    """
    from localcut_engine.manifest.defaults import set_default
    from localcut_engine.readiness import auto_defaults

    _tiny_manifest(tmp_path)
    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")
    config = EngineConfig(data_dir=tmp_path, backend="local,mock")

    assert auto_defaults(config)["video.i2v"] == "tiny-i2v"
    assert auto_defaults(config)["text.llm"] == config.llm_model

    # A stored pick changes what renders; it must not change this answer.
    set_default(config, "text.llm", "llama3.2")
    assert auto_defaults(config)["text.llm"] == config.llm_model


def test_auto_for_a_machine_that_cannot_see_is_nothing(tmp_path):
    """vision.llm has no engine-config fallback on purpose (unset means
    "this machine cannot see"), and no node kind produces it - so it is
    also the task no readiness row can ever answer for."""
    from localcut_engine.readiness import auto_defaults

    assert auto_defaults(_bare_config(tmp_path))["vision.llm"] is None


async def test_every_row_names_its_task_and_resolved_model(tmp_path, monkeypatch):
    """Two fields the desktop keys on, and so must never be dropped: the
    task (its per-task surfaces group by it, ready rows included) and the
    model Auto resolved to (the picker reads it to say what Auto means).
    A row missing either is one those surfaces silently skip."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    _tiny_manifest(tmp_path)
    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"weights")

    config = EngineConfig(data_dir=tmp_path, backend="comfy,mock")
    backends = _build_backends(config)
    rows = _by_kind(
        await readiness_rows(config, backends, [(NodeKind.CLIP, None), (NodeKind.MUSIC, None)])
    )
    assert rows["clip"]["verdict"] == "ready"
    assert rows["clip"]["model"] == "tiny-i2v"  # what Auto resolved to
    assert rows["clip"]["data"]["task"] == "video.i2v"
    # A placeholder row carries its task too, or the popover drops the line.
    assert rows["music"]["data"]["task"] == "music.gen"

    # And a row that resolved nothing still names the model the NODE asked
    # for — two scenes pinned to different missing models are two rows, not
    # one row written twice.
    unresolved = await readiness_rows(
        config, backends, [(NodeKind.MUSIC, "local:a"), (NodeKind.MUSIC, "local:b")]
    )
    assert [row["model"] for row in unresolved] == ["local:a", "local:b"]


async def test_a_model_comfyui_cannot_run_is_not_reported_ready(tmp_path, monkeypatch):
    """A node naming a model with no workflow template, or one the manifest
    has never heard of, does NOT render that model: `_template_path` falls
    through to an installed model's graph and quietly renders something
    else. Reachable from the shipped "Add custom model" flow, which leaves
    the template empty."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    (tmp_path / "model-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "models": [
                    {
                        "id": "tiny-i2v",
                        "task": "video.i2v",
                        "family": "test",
                        "requirements": {"vram_gb": 1, "disk_gb": 1},
                        "license": {"id": "mit", "commercial": True},
                        "comfy_graph_template": "clip_default.json",
                        "files": [
                            {
                                "url": "http://localhost/w",
                                "dest": "checkpoints/tiny.safetensors",
                                "size": 7,
                            }
                        ],
                    },
                    {
                        "id": "no-graph",
                        "task": "video.i2v",
                        "family": "test",
                        "requirements": {"vram_gb": 1, "disk_gb": 1},
                        "license": {"id": "mit", "commercial": True},
                        "files": [
                            {
                                "url": "http://localhost/n",
                                "dest": "checkpoints/nograph.safetensors",
                                "size": 5,
                            }
                        ],
                    },
                ],
            }
        )
    )
    models = tmp_path / "models" / "checkpoints"
    models.mkdir(parents=True)
    (models / "tiny.safetensors").write_bytes(b"weights")
    (models / "nograph.safetensors").write_bytes(b"w")

    config = EngineConfig(data_dir=tmp_path, backend="comfy,ffmpeg,mock")
    backends = _build_backends(config)

    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, "local:no-graph")])
    assert row["verdict"] == "degraded"
    assert row["reason"] == "model_ignored"

    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, "local:never-heard-of-it")])
    assert row["verdict"] == "degraded"
    assert row["reason"] == "model_ignored"


async def test_explicit_comfy_kinds_without_weights_is_not_ready(tmp_path, monkeypatch):
    """comfy_kinds as an explicit list bypasses the capability gate, so
    ComfyUI claims the kind with nothing installed and the job dies inside
    it. This is the configuration readiness is most needed in."""
    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    config = EngineConfig(data_dir=tmp_path, backend="comfy,mock", comfy_kinds="keyframe,clip")
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.KEYFRAME, None)])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "no_model_installed"
    assert row["fix"]["model_id"] == "sdxl-base-1.0"


async def test_a_cause_is_never_guessed_from_the_winning_backend(tmp_path):
    """`mock served the script` means the LLM server is down only if an llm
    backend is in the chain; `ffmpeg served the clip` means ComfyUI is down
    only if ComfyUI is there to be down. Neither is true here, and a
    download would not change either — so no fix is offered."""
    config = EngineConfig(
        data_dir=tmp_path,
        backend="ffmpeg,mock",  # no llm, no comfy, no kokoro, no align
        ffmpeg_bin=_planted_ffmpeg(tmp_path),
    )
    backends = _build_backends(config)
    rows = _by_kind(
        await readiness_rows(
            config,
            backends,
            [
                (NodeKind.SCRIPT, None),
                (NodeKind.KEYFRAME, None),
                (NodeKind.NARRATION, None),
                (NodeKind.EXPORT, None),
            ],
        )
    )
    for kind in ("script", "keyframe", "narration"):
        assert rows[kind]["reason"] == "backend_not_configured", kind
        assert rows[kind]["fix"] is None, kind
    # ffmpeg is present, so assembly is genuinely fine.
    assert rows["export"]["verdict"] == "ready"


async def test_an_all_mock_chain_does_not_blame_a_missing_model_for_assembly(tmp_path):
    """The engine's own default backend. There is no model for assembly, so
    "no model installed" is nonsense with no fix to offer."""
    config = EngineConfig(data_dir=tmp_path, backend="mock")
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.EXPORT, None)])
    assert row["verdict"] == "placeholder"
    assert row["reason"] == "backend_not_configured"
    assert row["fix"] is None


async def test_a_cloud_model_the_provider_cannot_serve_will_fail(tmp_path):
    """CloudBackend.supports() claims SCRIPT and CLIP for any cloud model,
    so resolve() alone cannot tell a text model on a clip from a real
    pairing — execute dies in videogen_for_model. The row must not say
    ready just because a key is present."""
    config = EngineConfig(**{**_bare_config(tmp_path).model_dump(), "anthropic_key": "sk-test"})
    backends = _build_backends(config)
    (row,) = await readiness_rows(config, backends, [(NodeKind.CLIP, "cloud:claude-sonnet-5")])
    assert row["verdict"] == "will_fail"
    assert row["reason"] == "cloud_model_unknown"
    # The same model on the kind its provider DOES serve is fine.
    (row,) = await readiness_rows(config, backends, [(NodeKind.SCRIPT, "cloud:claude-sonnet-5")])
    assert row["verdict"] == "ready"


async def test_a_broken_manifest_is_refused_not_blamed_on_a_missing_model(client, tmp_path):
    """Every sibling route answers 503 for an unreadable manifest. A row
    reading "no model installed, no fix" would send the user hunting for a
    download when the fix is a corrupt file. (`client` and this test share
    tmp_path, so the override manifest lands in the engine's data dir.)"""
    assert (await client.get("/readiness")).status_code == 200
    (tmp_path / "model-manifest.json").write_text("{not json")
    response = await client.get("/readiness")
    assert response.status_code == 503
    assert "manifest" in response.json()["detail"]


async def test_readiness_route_scopes_to_kinds(client):
    response = await client.get("/readiness", params={"kinds": "music"})
    assert response.status_code == 200
    rows = response.json()["rows"]
    assert [row["kind"] for row in rows] == ["music"]
    assert rows[0]["verdict"] == "placeholder"

    # No kinds = every job-producing kind, in pipeline order.
    response = await client.get("/readiness")
    kinds = [row["kind"] for row in response.json()["rows"]]
    assert kinds[0] == "script" and "export" in kinds

    response = await client.get("/readiness", params={"kinds": "music,bogus"})
    assert response.status_code == 422


def test_an_unexpanded_project_is_judged_on_the_whole_pipeline():
    """A prompt project's graph is two-stage: until the screenplay lands it
    holds the script node ALONE. Judging only that told a user with nothing
    installed that their project was one script away from fine, while every
    job the expansion was about to queue fell to a placeholder — the exact
    moment this preflight exists for.

    Against the pure rule rather than the route: the mock script backend can
    expand a real project between the POST and the GET, which would let this
    pass without the padding it is here to pin."""
    from localcut_engine.graph.templates import prompt_template_graph, tool_graph
    from localcut_engine.readiness import PIPELINE_KINDS, project_pairs

    fresh = prompt_template_graph("bees")
    assert {node.kind for node in fresh.nodes.values()} == {NodeKind.SCRIPT}
    kinds = [kind for kind, _ in project_pairs(fresh, is_tool_session=False)]
    assert kinds == list(PIPELINE_KINDS)
    assert NodeKind.THUMBNAIL not in kinds  # only the publish kit builds one

    # A tool session's graph is complete on creation — padding it would warn
    # about models the script tool will never touch.
    session = tool_graph("script", {"prompt": "how bees work", "target_duration_s": 60})
    assert [kind for kind, _ in project_pairs(session, is_tool_session=True)] == [NodeKind.SCRIPT]


def test_a_project_is_judged_on_each_distinct_model_once():
    """Per-node overrides are the reason this route exists; two clips on
    different models are two questions, and two clips on the same model are
    one."""
    from localcut_engine.graph.model import Node, StoryGraph
    from localcut_engine.readiness import project_pairs

    graph = StoryGraph()
    graph.add_node(Node(id="script", kind=NodeKind.SCRIPT))
    graph.add_node(Node(id="s1.clip", kind=NodeKind.CLIP, model="local:a"))
    graph.add_node(Node(id="s2.clip", kind=NodeKind.CLIP, model="local:b"))
    graph.add_node(Node(id="s3.clip", kind=NodeKind.CLIP, model="local:a"))
    pairs = project_pairs(graph, is_tool_session=False)
    assert pairs == [
        (NodeKind.SCRIPT, None),
        (NodeKind.CLIP, "local:a"),
        (NodeKind.CLIP, "local:b"),
    ]


async def test_project_readiness_honors_node_overrides(client):
    created = await client.post("/projects", json={"prompt": "a bee documentary"})
    pid = created.json()["id"]
    response = await client.get(f"/projects/{pid}/readiness")
    assert response.status_code == 200
    rows = response.json()["rows"]
    kinds = [row["kind"] for row in rows]
    assert kinds == sorted(set(kinds), key=kinds.index)  # distinct, ordered
    assert "script" in kinds

    # An unknown project answers 404, not an empty report.
    missing = await client.get("/projects/0123456789/readiness")
    assert missing.status_code == 404
