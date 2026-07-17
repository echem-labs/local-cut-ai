import httpx
import pytest

from localcut_engine.api.app import create_app
from localcut_engine.config import EngineConfig


@pytest.fixture
async def client(tmp_path):
    config = EngineConfig(data_dir=tmp_path, token="test-token", backend="mock")
    app = create_app(config)
    transport = httpx.ASGITransport(app=app)
    async with transport, httpx.AsyncClient(
        transport=transport,
        base_url="http://engine",
        headers={"Authorization": "Bearer test-token"},
    ) as http:
        async with app.router.lifespan_context(app):
            yield http


async def test_health_is_open_and_versioned(client):
    response = await client.get("/health", headers={})
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] and body["api_version"] == 1


async def test_routes_require_token(client):
    response = await client.get("/projects", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401


async def test_create_and_fetch_project(client):
    created = await client.post("/projects", json={"prompt": "a day in a beehive"})
    assert created.status_code == 200
    project_id = created.json()["id"]

    fetched = await client.get(f"/projects/{project_id}")
    assert fetched.status_code == 200
    assert fetched.json()["project"]["id"] == project_id
    assert "aux" in fetched.json()["board"]

    listed = await client.get("/projects")
    assert any(p["id"] == project_id for p in listed.json())


async def test_system_reports_tier_and_recommendations(client):
    response = await client.get("/system")
    assert response.status_code == 200
    body = response.json()
    assert body["hardware"]["tier"] in ("S", "A", "B", "C")
    assert len(body["recommendations"]) >= 5


async def test_manifest_defaults_are_commercial_safe(client):
    response = await client.get("/models/manifest")
    assert response.status_code == 200
    from localcut_engine.manifest.model import ModelManifest

    manifest = ModelManifest.model_validate(response.json())
    assert manifest.lint_defaults() == []  # CI gate: no personal-only defaults


async def test_path_params_reject_non_identifier_input(client):
    # Wildcards / traversal-shaped values must never reach the store layer.
    assert (await client.get("/projects/%2e%2e%2fescape")).status_code in (404, 422)
    created = await client.post("/projects", json={"prompt": "x"})
    pid = created.json()["id"]
    assert (await client.get(f"/projects/{pid}/artifacts/*")).status_code == 422
    assert (await client.get(f"/projects/{pid}/artifacts/{'a' * 64}")).status_code in (404, 422)
    bad_node = await client.post(
        f"/projects/{pid}/nodes/no-such-node/regenerate", json={}
    )
    assert bad_node.status_code == 404


def test_backend_chain_parsing_and_composition(tmp_path):
    """The desktop shell passes --backend as a flag; chains must be accepted
    end-to-end (argparse pattern removed, config expands shorthands, and the
    app factory composes the registry in order with mock as catch-all)."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.config import EngineConfig
    from localcut_engine.graph.model import NodeKind

    assert EngineConfig(backend="llm,comfy,mock").backend_chain == ["llm", "comfy", "mock"]
    assert EngineConfig(backend="local,mock").backend_chain == [
        "llm", "comfy", "kokoro", "align", "ffmpeg", "mock",
    ]

    config = EngineConfig(
        data_dir=tmp_path, backend="llm,comfy,mock", comfy_kinds="keyframe,thumbnail"
    )
    registry = _build_backends(config)
    assert registry.resolve(NodeKind.SCRIPT).name == "llm"
    assert registry.resolve(NodeKind.KEYFRAME).name == "comfyui"
    assert registry.resolve(NodeKind.CLIP).name == "mock"  # not in comfy_kinds
    assert registry.resolve(NodeKind.EXPORT).name == "mock"

    # The full-local chain must resolve every generative kind (no dead lanes).
    local = _build_backends(EngineConfig(data_dir=tmp_path, backend="local"))
    for kind in (NodeKind.SCRIPT, NodeKind.KEYFRAME, NodeKind.CLIP, NodeKind.MUSIC,
                 NodeKind.NARRATION, NodeKind.CAPTIONS, NodeKind.TIMELINE,
                 NodeKind.EXPORT):
        local.resolve(kind)  # raises if unrouted

    with pytest.raises(ValueError, match="unknown backend"):
        _build_backends(EngineConfig(data_dir=tmp_path, backend="bogus"))


async def test_create_project_validates_aspect_and_duration(client):
    # Unknown aspects silently render as the default one downstream; bad
    # durations only fail later as opaque job errors — both must 422 here.
    bad_aspect = await client.post("/projects", json={"prompt": "x", "aspect": "4:3"})
    assert bad_aspect.status_code == 422
    bad_duration = await client.post(
        "/projects", json={"prompt": "x", "target_duration_s": 0}
    )
    assert bad_duration.status_code == 422


async def test_patch_input_errors_are_422_not_500(client):
    created = await client.post("/projects", json={"prompt": "x"})
    pid = created.json()["id"]
    # add_node without a node body raises ValueError in apply_patch.
    response = await client.post(
        f"/projects/{pid}/patch",
        json={"ops": [{"op": "add_node", "node_id": "extra"}]},
    )
    assert response.status_code == 422


def test_data_dir_override_relocates_models_dir(tmp_path, monkeypatch):
    """The CLI rebuilds the config from from_env().model_dump() + overrides;
    a --data-dir override must carry the derived models_dir with it."""
    monkeypatch.delenv("LOCALCUT_DATA_DIR", raising=False)
    monkeypatch.delenv("LOCALCUT_MODELS_DIR", raising=False)
    merged = EngineConfig(
        **{**EngineConfig.from_env().model_dump(), "data_dir": tmp_path / "elsewhere"}
    )
    assert merged.resolved_models_dir == tmp_path / "elsewhere" / "models"


async def test_quick_tools_create_and_validate(client):
    voiced = await client.post(
        "/tools", json={"tool": "voiceover", "text": "hello world"}
    )
    assert voiced.status_code == 200
    assert voiced.json()["mode"] == "tool:voiceover"

    missing = await client.post("/tools", json={"tool": "thumbnail"})
    assert missing.status_code == 422  # thumbnail requires a prompt

    board = await client.get(f"/projects/{voiced.json()['id']}")
    assert "voiceover" in board.json()["board"]["aux"]  # tool node on the board


async def test_promote_requires_a_finished_script(client):
    created = await client.post("/projects", json={"prompt": "x"})
    response = await client.post(f"/projects/{created.json()['id']}/promote")
    assert response.status_code == 409  # full projects aren't tool sessions


async def test_manifest_default_slate_is_downloadable(client):
    """Every default model a backend error message points at must actually
    be fetchable: entries for tasks we ship backends for need files[]."""
    from localcut_engine.manifest.model import ModelManifest

    response = await client.get("/models/manifest")
    manifest = ModelManifest.model_validate(response.json())
    kokoro = next(m for m in manifest.models if m.id == "kokoro-82m")
    assert kokoro.files, "kokoro-82m must be downloadable (backend suggests it)"
    assert all(f.sha256 for f in kokoro.files)
