import asyncio
import hashlib
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from localcut_engine.api.app import create_app
from localcut_engine.config import EngineConfig


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
    bad_node = await client.post(f"/projects/{pid}/nodes/no-such-node/regenerate", json={})
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
        "llm",
        "comfy",
        "kokoro",
        "align",
        "ffmpeg",
        "mock",
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
    for kind in (
        NodeKind.SCRIPT,
        NodeKind.KEYFRAME,
        NodeKind.CLIP,
        NodeKind.MUSIC,
        NodeKind.NARRATION,
        NodeKind.CAPTIONS,
        NodeKind.TIMELINE,
        NodeKind.EXPORT,
    ):
        local.resolve(kind)  # raises if unrouted

    with pytest.raises(ValueError, match="unknown backend"):
        _build_backends(EngineConfig(data_dir=tmp_path, backend="bogus"))


async def test_create_project_validates_aspect_and_duration(client):
    # Unknown aspects silently render as the default one downstream; bad
    # durations only fail later as opaque job errors — both must 422 here.
    bad_aspect = await client.post("/projects", json={"prompt": "x", "aspect": "4:3"})
    assert bad_aspect.status_code == 422
    bad_duration = await client.post("/projects", json={"prompt": "x", "target_duration_s": 0})
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
    voiced = await client.post("/tools", json={"tool": "voiceover", "text": "hello world"})
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


async def test_model_download_api_lifecycle(client, tmp_path):
    """POST /models/{id}/download runs the manifest download in the
    background; GET /models reflects install state throughout."""
    payload = b"localcut-tiny-weights" * 200
    (tmp_path / "weights.bin").write_bytes(payload)
    httpd = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(tmp_path))
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    manifest = {
        "models": [
            {
                "id": "tiny-model",
                "task": "image.gen",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
                "files": [
                    {
                        "url": f"http://127.0.0.1:{httpd.server_address[1]}/weights.bin",
                        "dest": "checkpoints/tiny.bin",
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "size": len(payload),
                    }
                ],
            },
            {
                "id": "weightless",
                "task": "text.llm",
                "family": "test",
                "requirements": {"vram_gb": 0, "disk_gb": 0},
                "license": {"id": "mit", "commercial": True},
            },
        ]
    }
    (tmp_path / "model-manifest.json").write_text(json.dumps(manifest))
    try:
        rows = {r["id"]: r for r in (await client.get("/models")).json()}
        row = rows["tiny-model"]
        assert not row["downloaded"] and row["size_bytes"] == len(payload)

        started = await client.post("/models/tiny-model/download")
        assert started.json()["status"] == "started"
        for _ in range(200):
            rows = {r["id"]: r for r in (await client.get("/models")).json()}
            if rows["tiny-model"]["downloaded"]:
                break
            await asyncio.sleep(0.02)
        assert rows["tiny-model"]["downloaded"]
        assert (tmp_path / "models/checkpoints/tiny.bin").read_bytes() == payload

        # Restarting a completed download is a cheap no-op, not a refetch.
        again = await client.post("/models/tiny-model/download")
        assert again.json()["status"] == "downloaded"

        assert (await client.post("/models/no-such-model/download")).status_code == 404
        assert (await client.post("/models/weightless/download")).status_code == 409
        assert (await client.delete("/models/tiny-model/download")).status_code == 409
    finally:
        httpd.shutdown()


async def test_provider_keys_are_runtime_only(client):
    """PUT /providers/keys updates the live config: omitted fields stay,
    empty string clears — and nothing lands on disk (shell owns keychain)."""
    status = {p["id"]: p["configured"] for p in (await client.get("/providers")).json()}
    assert status["anthropic"] is False

    updated = await client.put("/providers/keys", json={"anthropic_key": "sk-test"})
    assert {p["id"]: p["configured"] for p in updated.json()}["anthropic"] is True

    updated = await client.put("/providers/keys", json={"anthropic_key": "", "fal_key": "fk"})
    status = {p["id"]: p["configured"] for p in updated.json()}
    assert status["anthropic"] is False  # empty string clears
    assert status["fal"] is True


async def test_broken_override_manifest_is_503_not_500(client, tmp_path):
    (tmp_path / "model-manifest.json").write_text("{ not json")
    response = await client.get("/models")
    assert response.status_code == 503
    assert "manifest" in response.json()["detail"]
    response = await client.post("/models/kokoro-82m/download")
    assert response.status_code == 503


async def test_otio_export_conflicts_before_a_real_timeline(client):
    """Mock EDLs (and unrendered timelines) must 409 with a reason — never
    500, never an empty document."""
    created = await client.post("/projects", json={"prompt": "x"})
    response = await client.get(f"/projects/{created.json()['id']}/export/otio")
    assert response.status_code == 409
    assert "timeline" in response.json()["detail"]


async def test_package_conflicts_before_script_renders(client):
    created = await client.post("/projects", json={"prompt": "x", "mode": "beginner"})
    # Beginner mode gates everything behind script approval, so the script
    # itself may still be rendering — but packaging must fail cleanly either
    # way until the screenplay artifact exists.
    response = await client.post(f"/projects/{created.json()['id']}/package")
    assert response.status_code in (200, 409)


async def test_manifest_default_slate_is_downloadable(client):
    """Every default model a backend error message points at must actually
    be fetchable: entries for tasks we ship backends for need files[]."""
    from localcut_engine.manifest.model import ModelManifest

    response = await client.get("/models/manifest")
    manifest = ModelManifest.model_validate(response.json())
    kokoro = next(m for m in manifest.models if m.id == "kokoro-82m")
    assert kokoro.files, "kokoro-82m must be downloadable (backend suggests it)"
    assert all(f.sha256 for f in kokoro.files)


async def test_edit_applies_a_natural_language_plan(client, monkeypatch):
    """POST /edit: the (patched) LLM returns a plan, the compiler applies the
    legal parts, and the graph actually changes. Bad scopes and non-cloud
    model overrides fail before any LLM call; LLM failures are 502s."""
    from localcut_engine.backends.llm import LLMScriptBackend

    created = await client.post("/projects", json={"prompt": "city of glass"})
    pid = created.json()["id"]

    async def scenes() -> list:
        return (await client.get(f"/projects/{pid}")).json()["board"]["scenes"]

    async with asyncio.timeout(15):
        while not await scenes():
            await asyncio.sleep(0.05)

    async def fake_complete(self, prompt, system):
        assert "Project view" in prompt and "city of glass" in prompt
        return json.dumps(
            {
                "summary": "made scene 1 nocturnal",
                "edits": [
                    {
                        "action": "update",
                        "node_id": "s1.keyframe",
                        "params": {"prompt": "night city", "aspect": "1:1"},
                    }
                ],
            }
        )

    monkeypatch.setattr(LLMScriptBackend, "complete", fake_complete)
    response = await client.post(
        f"/projects/{pid}/edit", json={"instruction": "make scene 1 at night"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == "made scene 1 nocturnal"
    assert body["ops"] == 1
    assert "s1.clip" in body["dirty"]  # the downstream cone re-renders
    assert any("not editable" in w for w in body["warnings"])  # aspect blocked

    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["s1.keyframe"]["params"]["prompt"] == "night city"
    assert graph["nodes"]["s1.keyframe"]["params"]["aspect"] != "1:1"

    assert (
        await client.post(f"/projects/{pid}/edit", json={"instruction": "x", "scope": "s99"})
    ).status_code == 404
    assert (
        await client.post(f"/projects/{pid}/edit", json={"instruction": "x", "model": "local:qwen"})
    ).status_code == 422

    async def broken_complete(self, prompt, system):
        return "Sure! I've made those edits for you."

    monkeypatch.setattr(LLMScriptBackend, "complete", broken_complete)
    response = await client.post(f"/projects/{pid}/edit", json={"instruction": "x"})
    assert response.status_code == 502
    assert "unusable" in response.json()["detail"]


async def test_new_quick_tools_create_sessions(client):
    """Image, music, and single-clip generators are one POST each; the clip
    session carries its keyframe conditioning node."""
    boards = {}
    for tool, extra in (("image", {}), ("music", {}), ("clip", {"motion": "orbit"})):
        response = await client.post("/tools", json={"tool": tool, "prompt": f"a {tool}", **extra})
        assert response.status_code == 200
        project = response.json()
        assert project["mode"] == f"tool:{tool}"
        boards[tool] = (await client.get(f"/projects/{project['id']}")).json()["board"]
        assert tool in boards[tool]["aux"]
    assert "keyframe" in boards["clip"]["aux"]
    assert boards["clip"]["aux"]["clip"]["params"]["mode"] == "i2v"
    assert boards["music"]["aux"]["music"]["params"]["brief"] == "a music"
    # Tools still refuse an empty subject.
    assert (await client.post("/tools", json={"tool": "image"})).status_code == 422


async def test_asset_upload_and_i2v_conditioning(client):
    """Upload an image → asset node born cached (no job) → wire it into a
    scene clip's keyframe port; the generated keyframe is displaced and the
    edge survives graph reads."""
    created = await client.post("/projects", json={"prompt": "asset test"})
    pid = created.json()["id"]

    async def scenes() -> list:
        return (await client.get(f"/projects/{pid}")).json()["board"]["scenes"]

    async with asyncio.timeout(15):
        while not await scenes():
            await asyncio.sleep(0.05)

    png = b"\x89PNG\r\n\x1a\n" + b"fake-image-bytes"
    response = await client.post(
        f"/projects/{pid}/assets?filename=hero.png",
        content=png,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 200
    asset = response.json()
    assert asset["node_id"].startswith("asset-")

    # Born cached: an asset never becomes a job.
    jobs = (await client.get(f"/jobs?project_id={pid}")).json()
    assert not [j for j in jobs if j["spec"]["node_id"] == asset["node_id"]]
    board = (await client.get(f"/projects/{pid}")).json()["board"]
    assert board["aux"][asset["node_id"]]["artifact_hash"] == asset["hash"]

    patched = await client.post(
        f"/projects/{pid}/patch",
        json={
            "ops": [
                {"op": "connect", "node_id": "s1.clip", "src": asset["node_id"], "port": "keyframe"}
            ]
        },
    )
    assert patched.status_code == 200
    assert "s1.clip" in patched.json()["dirty"]

    graph = (await client.get(f"/projects/{pid}/graph")).json()
    keyframe_edges = [
        e for e in graph["edges"] if e["dst"] == "s1.clip" and e["port"] == "keyframe"
    ]
    assert keyframe_edges == [{"src": asset["node_id"], "dst": "s1.clip", "port": "keyframe"}]

    # Same bytes again → same node, idempotent.
    again = await client.post(
        f"/projects/{pid}/assets?filename=other-name.png",
        content=png,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert again.json()["node_id"] == asset["node_id"]

    # Wrong type and empty bodies are rejected before touching the store.
    assert (
        await client.post(f"/projects/{pid}/assets?filename=evil.exe", content=b"x")
    ).status_code == 422
    assert (
        await client.post(f"/projects/{pid}/assets?filename=empty.png", content=b"")
    ).status_code == 422
