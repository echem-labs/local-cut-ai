"""Proposing a scene from a picture the user dropped in.

A dropped image gives the app a shot but no words, and `add_scene` leaves
prompt and narration blank — which the compiler reads as "not ready" and
never enqueues. So a scene made from a photo does nothing at all until
somebody writes those two fields. This route offers to write them.

Read-only by design: it returns the two strings and lands nothing. The
client applies them with the ordinary `add_scene` patch op, so there is no
new mutation path, no new node kind, and nothing here that can edit a graph.

Local or cloud, and it never guesses. A vision model on the LLM server is
preferred when the user has chosen one — free, private, and choosing it was
an explicit act — with a BYOK key second. What it must never do is fall back
to a model that cannot see: answering from the project's text alone would
return a confident description of a photo nothing ever looked at, at HTTP
200, indistinguishable from a real reading.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from localcut_engine.api.app import create_app
from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.llm import LLMScriptBackend
from localcut_engine.config import EngineConfig
from localcut_engine.manifest.defaults import set_default
from localcut_engine.providers.textgen import AnthropicTextGen, ProviderError

TOKEN = "test-token"
PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"


@pytest.fixture
def client(tmp_path):
    # A BYOK key and no local vision model: the cloud path, which most of
    # these exercise. Without the key every case would stop at the 400 that
    # reports having nothing that can see.
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


def test_a_local_vision_model_is_served_by_the_local_llm_server(client, monkeypatch):
    # A machine with a vision model on Ollama should never have to spend a
    # cloud key to describe a picture. The route reaches the same local
    # server `/edit` uses, and hands it the name the user chose.
    project_id = _project(client)
    node_id = _asset(client, project_id)
    seen = {}

    async def fake_describe(self, system, prompt, image, max_tokens=4096, model=None):
        seen["model"] = model
        seen["bytes"] = image.read_bytes()
        return json.dumps({"narration": "n", "prompt": "p"})

    monkeypatch.setattr(LLMScriptBackend, "describe", fake_describe)

    response = _suggest(client, project_id, node_id, model="local:qwen2.5vl")

    assert response.status_code == 200, response.text
    assert seen["model"] == "local:qwen2.5vl"
    # The actual picture, not merely word that one exists.
    assert seen["bytes"] == PNG


def test_it_refuses_a_model_that_routes_nowhere(client):
    project_id = _project(client)
    node_id = _asset(client, project_id)

    response = _suggest(client, project_id, node_id, model="qwen2.5vl")

    assert response.status_code == 422
    assert "local" in response.json()["detail"]


def test_the_local_path_never_falls_back_to_the_model_that_cannot_see(tmp_path):
    """The trap this whole seam exists to avoid.

    `LLMScriptBackend.resolve_model` answers an unnamed model with the SCRIPT
    default — a text-only model on nearly every machine. Letting `describe`
    use it would send the prompt without the picture and return a confident
    account of an image nothing ever looked at, at HTTP 200, indistinguishable
    from a real reading.
    """
    backend = LLMScriptBackend(base_url="http://127.0.0.1:11434/v1", model="qwen3:14b")

    with pytest.raises(GenerationError, match="vision"):
        asyncio.run(backend.describe(system="s", prompt="p", image=tmp_path / "shot.png"))


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


def test_a_configured_local_model_is_preferred_over_a_cloud_key(tmp_path, monkeypatch):
    """Choosing a local model in Settings is an explicit act, and it is free.

    Reaching past it for a key the user also happens to hold would spend
    money on a job they have already said they want done at home — and send
    the picture off the machine to do it.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock", anthropic_key="k")
    set_default(config, "vision.llm", "qwen2.5vl")
    seen = {}

    async def local_describe(self, system, prompt, image, max_tokens=4096, model=None):
        seen["model"] = model
        return json.dumps({"narration": "n", "prompt": "p"})

    async def cloud_describe(self, system, prompt, image, max_tokens=4096):  # pragma: no cover
        raise AssertionError("the cloud key must not be spent when a local model is set")

    monkeypatch.setattr(LLMScriptBackend, "describe", local_describe)
    monkeypatch.setattr(AnthropicTextGen, "describe", cloud_describe)

    with TestClient(create_app(config)) as local:
        local.headers.update({"Authorization": f"Bearer {TOKEN}"})
        project_id = _project(local)
        node_id = _asset(local, project_id)
        response = local.post(f"/projects/{project_id}/suggest-scene", json={"node_id": node_id})

    assert response.status_code == 200, response.text
    assert seen["model"] == "local:qwen2.5vl"


def test_a_caller_that_may_not_spend_can_still_use_the_local_model(tmp_path, monkeypatch):
    """The spend gate guards the user's money, and a local model costs none.

    Refusing here would deny an agent with no spending rights a job that
    bills nobody and never leaves the machine.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    set_default(config, "vision.llm", "qwen2.5vl")

    async def local_describe(self, system, prompt, image, max_tokens=4096, model=None):
        return json.dumps({"narration": "n", "prompt": "p"})

    monkeypatch.setattr(LLMScriptBackend, "describe", local_describe)

    with TestClient(create_app(config)) as local:
        local.headers.update({"Authorization": f"Bearer {TOKEN}"})
        project_id = _project(local)
        node_id = _asset(local, project_id)
        response = local.post(
            f"/projects/{project_id}/suggest-scene",
            json={"node_id": node_id},
            headers={"x-localcut-cloud-spend": "deny"},
        )

    assert response.status_code == 200, response.text


def test_vision_reports_nothing_on_a_machine_that_cannot_see(tmp_path):
    # The desktop shows its "write these from the image" button on this one
    # answer, rather than deriving the rule a second time in TypeScript —
    # where it could not see a local model at all.
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    with TestClient(create_app(config)) as bare:
        bare.headers.update({"Authorization": f"Bearer {TOKEN}"})
        body = bare.get("/vision").json()

    assert body["model"] is None
    assert body["kind"] is None
    assert "Settings" in body["reason"]


def test_vision_names_the_local_model_when_one_is_set(tmp_path):
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock", anthropic_key="k")
    set_default(config, "vision.llm", "qwen2.5vl")
    with TestClient(create_app(config)) as local:
        local.headers.update({"Authorization": f"Bearer {TOKEN}"})
        body = local.get("/vision").json()

    assert body == {"model": "local:qwen2.5vl", "kind": "local", "reason": None}


def test_vision_falls_back_to_a_cloud_key(client):
    body = client.get("/vision").json()

    assert body["kind"] == "cloud"
    assert body["model"].startswith("cloud:")
