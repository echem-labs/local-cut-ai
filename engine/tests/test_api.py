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
