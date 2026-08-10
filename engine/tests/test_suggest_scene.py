"""Proposing a scene from a picture the user dropped in.

A dropped image gives the app a shot but no words, and `add_scene` leaves
prompt and narration blank — which the compiler reads as "not ready" and
never enqueues. So a scene made from a photo does nothing at all until
somebody writes those two fields. This route offers to write them.

Read-only by design: it returns the two strings and lands nothing. The
client applies them with the ordinary `add_scene` patch op, so there is no
new mutation path, no new node kind, and nothing here that can edit a graph.

Cloud-only, and it says so rather than falling back. There is no local
vision model in the manifest, and answering from the project's text alone
would return a confident description of a photo nothing ever looked at.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from localcut_engine.api.app import create_app
from localcut_engine.config import EngineConfig
from localcut_engine.providers.textgen import AnthropicTextGen, ProviderError

TOKEN = "test-token"
PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"


@pytest.fixture
def client(tmp_path):
    # A BYOK key present, because this route is cloud-only: without one
    # every case below would stop at the 400 that reports its absence.
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock", anthropic_key="k")
    with TestClient(create_app(config)) as client:
        client.headers.update({"Authorization": f"Bearer {TOKEN}"})
        yield client


def _project(client) -> str:
    response = client.post("/projects", json={"title": "t", "prompt": "a city of glass"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _asset(client, project_id: str) -> str:
    response = client.post(
        f"/projects/{project_id}/assets", params={"filename": "shot.png"}, content=PNG
    )
    assert response.status_code == 200, response.text
    return response.json()["node_id"]


def _suggest(client, project_id: str, node_id: str, **over) -> dict:
    body = {"node_id": node_id, "model": "cloud:claude-sonnet-5", **over}
    return client.post(f"/projects/{project_id}/suggest-scene", json=body)


def test_it_writes_the_two_fields_a_new_scene_needs(client, monkeypatch):
    project_id = _project(client)
    node_id = _asset(client, project_id)
    seen = {}

    async def fake_describe(self, system, prompt, image, max_tokens=4096):
        seen["prompt"] = prompt
        seen["bytes"] = image.read_bytes()
        return json.dumps({"narration": "The glass city wakes.", "prompt": "a glass tower at dawn"})

    monkeypatch.setattr(AnthropicTextGen, "describe", fake_describe)

    response = _suggest(client, project_id, node_id)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "narration": "The glass city wakes.",
        "prompt": "a glass tower at dawn",
    }
    # The model is handed the actual picture, not merely told one exists.
    assert seen["bytes"] == PNG
    # …and the project's own words, so the suggestion belongs to THIS video
    # rather than describing a photo in isolation.
    assert "city of glass" in seen["prompt"]


def test_it_refuses_a_local_model_rather_than_answering_blind(client):
    # There is no local vision model. Quietly using the text LLM would return
    # a confident description of a picture nothing ever looked at.
    project_id = _project(client)
    node_id = _asset(client, project_id)

    response = _suggest(client, project_id, node_id, model="local:qwen3:14b")

    assert response.status_code == 422
    assert "cloud" in response.json()["detail"]


def test_omitting_the_model_uses_a_provider_the_user_has_configured(client, monkeypatch):
    # The desktop must not carry model names — they drift, and a renderer
    # that hardcodes one ships a dead string until the next release. Asking
    # without naming a model means "whichever vision provider I pay for".
    project_id = _project(client)
    node_id = _asset(client, project_id)
    seen = {}

    async def fake_describe(self, system, prompt, image, max_tokens=4096):
        seen["model"] = self.model
        return json.dumps({"narration": "n", "prompt": "p"})

    monkeypatch.setattr(AnthropicTextGen, "describe", fake_describe)

    response = _suggest(client, project_id, node_id, model=None)

    assert response.status_code == 200, response.text
    assert seen["model"].startswith("claude")


def test_with_no_provider_at_all_it_says_what_is_missing(tmp_path):
    # Not a 502: nothing failed. The user has no key, which they fix in
    # Settings — and the message has to name that rather than blame a model.
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    with TestClient(create_app(config)) as bare:
        bare.headers.update({"Authorization": f"Bearer {TOKEN}"})
        project_id = _project(bare)
        node_id = _asset(bare, project_id)

        response = bare.post(f"/projects/{project_id}/suggest-scene", json={"node_id": node_id})

    assert response.status_code == 400
    assert "Settings" in response.json()["detail"]


def test_it_refuses_when_the_caller_may_not_spend_the_key(client, monkeypatch):
    project_id = _project(client)
    node_id = _asset(client, project_id)

    async def fake_describe(self, system, prompt, image, max_tokens=4096):  # pragma: no cover
        raise AssertionError("must not reach the provider")

    monkeypatch.setattr(AnthropicTextGen, "describe", fake_describe)

    response = client.post(
        f"/projects/{project_id}/suggest-scene",
        json={"node_id": node_id, "model": "cloud:claude-sonnet-5"},
        headers={"x-localcut-cloud-spend": "deny"},
    )

    assert response.status_code == 403


def test_a_missing_key_is_the_clients_problem_not_a_bad_gateway(client, monkeypatch):
    # Resolving the provider is a precondition: no key is something the user
    # fixes in Settings, and reporting it as 502 blames the model instead.
    project_id = _project(client)
    node_id = _asset(client, project_id)

    def no_key(config, model):
        raise ProviderError("anthropic API key not configured")

    monkeypatch.setattr("localcut_engine.api.app.textgen_for_model", no_key)

    response = _suggest(client, project_id, node_id)

    assert response.status_code == 400
    assert "key" in response.json()["detail"]


def test_a_model_that_answers_with_nonsense_is_a_bad_gateway(client, monkeypatch):
    project_id = _project(client)
    node_id = _asset(client, project_id)

    async def fake_describe(self, system, prompt, image, max_tokens=4096):
        return "I'm afraid I can't do that"

    monkeypatch.setattr(AnthropicTextGen, "describe", fake_describe)

    assert _suggest(client, project_id, node_id).status_code == 502


def test_an_unknown_node_is_a_404(client):
    project_id = _project(client)

    assert _suggest(client, project_id, "asset-000000000000").status_code == 404


def test_a_node_that_is_not_an_image_is_refused(client, monkeypatch):
    # The script node is not a picture. Sending its artifact to a vision model
    # would spend a request to be told so.
    project_id = _project(client)

    response = _suggest(client, project_id, "script")

    assert response.status_code == 422
    assert "image" in response.json()["detail"]
