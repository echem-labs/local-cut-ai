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

import httpx
import pytest
from fastapi.testclient import TestClient

from localcut_engine.api.app import create_app
from localcut_engine.backends.base import GenerationError
from localcut_engine.backends.llm import LLMScriptBackend
from localcut_engine.config import EngineConfig
from localcut_engine.manifest.defaults import DEFAULTS_VERSION, set_default
from localcut_engine.manifest.defaults import _path as _defaults_path
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


def test_a_local_model_name_is_held_to_the_same_rule_as_a_saved_one(client):
    """This is the first route that lets a CALLER name a local model.

    `/edit` takes only `cloud:*` or nothing, so every local name the engine
    has ever sent came from `set_default`, which bounds it at 128 characters
    of `[\\w.:-]`. Forwarding an arbitrary string straight to the LLM server
    because it happens to start with `local:` drops that check on the one
    path that did not inherit it.
    """
    project_id = _project(client)
    node_id = _asset(client, project_id)

    assert _suggest(client, project_id, node_id, model="local:" + "x" * 200).status_code == 422
    assert _suggest(client, project_id, node_id, model="local:has spaces").status_code == 422
    # An empty name is "local:" and nothing else — not a model, and not the
    # same thing as omitting the field.
    assert _suggest(client, project_id, node_id, model="local:").status_code == 422


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


def test_defaults_from_a_newer_build_are_refused_with_a_reason(tmp_path):
    """Asking which model can see now reads the defaults file, so both routes
    inherited an exception neither of them catches.

    `DefaultsTooNew` is a RuntimeError, not a ProviderError, and a 500 tells
    the user nothing about a situation the engine understands exactly:
    `/models/defaults` answers it with 409 and the message naming the format
    version. These two must not be the pair that crashes instead.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock", anthropic_key="k")
    path = _defaults_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": DEFAULTS_VERSION + 1, "defaults": {"vision.llm": "qwen2.5vl"}}),
        encoding="utf-8",
    )

    with TestClient(create_app(config), raise_server_exceptions=False) as newer:
        newer.headers.update({"Authorization": f"Bearer {TOKEN}"})
        # The convention these two are held to, asserted here so the day it
        # changes this test says so rather than quietly agreeing with a 500.
        assert newer.get("/models/defaults").status_code == 409

        seen = newer.get("/vision")
        project_id = _project(newer)
        node_id = _asset(newer, project_id)
        suggested = newer.post(f"/projects/{project_id}/suggest-scene", json={"node_id": node_id})

    assert seen.status_code == 409, seen.text
    assert suggested.status_code == 409, suggested.text
    # Named, so the user knows it is their engine that is behind and that
    # nothing was rewritten underneath them.
    assert "newer version" in suggested.json()["detail"]


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


def test_the_picker_is_offered_only_models_that_can_actually_see(tmp_path, monkeypatch):
    """A vision picker built from the server's model list would offer text-only
    models, and this route validates the SHAPE of a `local:*` name rather than
    its eyesight — so choosing one returns a confident description of a picture
    nothing looked at, at HTTP 200. That is the exact failure the route exists
    to refuse, reintroduced by the control meant to make it convenient.

    Ollama's native `/api/show` is the only trustworthy signal: the
    OpenAI-compatible `/models` surface both servers share reports names alone.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock", anthropic_key="k")
    set_default(config, "vision.llm", "qwen2.5vl")
    seeing = {"qwen2.5vl", "llava"}

    async def list_models(self):
        return ["llama3.2", "llava", "nomic-embed-text", "qwen2.5vl"]

    async def show(self, url, json=None, **kw):
        class Response:
            status_code = 200

            @staticmethod
            def json():
                caps = ["completion"] + (["vision"] if json["model"] in seeing else [])
                return {"capabilities": caps}

        return Response()

    monkeypatch.setattr(LLMScriptBackend, "list_models", list_models)
    monkeypatch.setattr("httpx.AsyncClient.post", show)

    with TestClient(create_app(config)) as live:
        live.headers.update({"Authorization": f"Bearer {TOKEN}"})
        answer = live.get("/vision/models")

    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["local_known"] is True
    # The text-only names are gone; the cloud key the user holds is offered
    # beside the local ones, because switching where a read happens is the
    # whole point of the control.
    assert body["models"] == ["local:llava", "local:qwen2.5vl", "cloud:claude-sonnet-5"]
    assert body["default"] == "local:qwen2.5vl"


def test_a_server_that_cannot_say_which_models_see_offers_none_of_them(tmp_path, monkeypatch):
    """llama.cpp serves the OpenAI-compatible surface but not Ollama's
    `/api/show`, so its names cannot be filtered.

    "I cannot tell which of these can see" and "none of these can see" are
    different answers, and the picker must not render the second when it has
    the first — every name it offered would be a guess. The user's OWN choice
    still appears: they vouched for that one in Settings, and a picker that
    silently dropped the model the engine is about to use would be showing
    them something other than the truth.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")
    set_default(config, "vision.llm", "qwen2.5vl")

    async def list_models(self):
        return ["llama3.2", "qwen2.5vl"]

    async def no_show(self, url, json=None, **kw):
        class Response:
            status_code = 404

            @staticmethod
            def json():  # pragma: no cover - never read on a 404
                return {}

        return Response()

    monkeypatch.setattr(LLMScriptBackend, "list_models", list_models)
    monkeypatch.setattr("httpx.AsyncClient.post", no_show)

    with TestClient(create_app(config)) as live:
        live.headers.update({"Authorization": f"Bearer {TOKEN}"})
        body = live.get("/vision/models").json()

    assert body["local_known"] is False
    assert body["models"] == ["local:qwen2.5vl"]


def test_the_picker_says_nothing_can_see_rather_than_guessing(tmp_path, monkeypatch):
    """No local model chosen and no key: the list is empty and the desktop
    shows no picker, which agrees with `/vision` hiding the button."""
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")

    async def unreachable(self):
        raise httpx.HTTPError("no server")

    monkeypatch.setattr(LLMScriptBackend, "list_models", unreachable)

    with TestClient(create_app(config)) as bare:
        bare.headers.update({"Authorization": f"Bearer {TOKEN}"})
        body = bare.get("/vision/models").json()

    assert body == {"models": [], "default": None, "local_known": False}


def test_residency_reports_the_stage_a_spinner_cannot(tmp_path, monkeypatch):
    """The read is one opaque POST, and the minutes in it are the model
    loading rather than the picture being looked at. Without this the client
    has nothing truthful to say for the whole wait.
    """
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")

    async def resident(self):
        return {"gemma3:4b"}

    monkeypatch.setattr(LLMScriptBackend, "resident_models", resident)

    with TestClient(create_app(config)) as live:
        live.headers.update({"Authorization": f"Bearer {TOKEN}"})
        assert live.get("/vision/residency", params={"model": "local:gemma3:4b"}).json() == {
            "loaded": True
        }
        assert live.get("/vision/residency", params={"model": "local:qwen2.5vl"}).json() == {
            "loaded": False
        }
        # A cloud read has no local stage to report, and an unbounded string
        # is refused here exactly as it is on the read itself.
        assert live.get("/vision/residency", params={"model": "cloud:x"}).json() == {"loaded": None}
        assert live.get("/vision/residency", params={"model": "local:bad name!"}).status_code == 422


def test_a_server_that_cannot_say_is_not_reported_as_not_loaded(tmp_path, monkeypatch):
    """`None` and `False` send the client to different sentences: "still
    loading" promises a stage change, and a server that cannot answer will
    never deliver one — leaving the dialog claiming progress forever."""
    config = EngineConfig(data_dir=tmp_path, token=TOKEN, backend="mock")

    async def cannot_say(self):
        return None

    monkeypatch.setattr(LLMScriptBackend, "resident_models", cannot_say)

    with TestClient(create_app(config)) as live:
        live.headers.update({"Authorization": f"Bearer {TOKEN}"})
        assert live.get("/vision/residency", params={"model": "local:qwen2.5vl"}).json() == {
            "loaded": None
        }


def test_the_ask_carries_the_length_the_scene_will_actually_run():
    """Narration IS the scene's runtime — the clip runs as long as the speech.

    Told nothing about length, a small local model wrote a five-word fragment
    for a five-second shot, which assembles to a scene over before it is seen.
    The budget has to be derived from the same default `_compile_add_scene`
    mints the clip with, or the words are measured against a length the clip
    does not have.
    """
    from localcut_engine.backends.llm import narration_word_budget
    from localcut_engine.graph.editor import suggest_scene_prompt
    from localcut_engine.graph.templates import DEFAULT_CLIP_S

    prompt = suggest_scene_prompt({}, DEFAULT_CLIP_S)

    assert f"{narration_word_budget(DEFAULT_CLIP_S)} words" in prompt
    assert "5 seconds" in prompt
    # A fragment is the specific failure, so the ask names it.
    assert "fragment" in prompt


def test_the_ask_spells_out_the_project_rather_than_dumping_its_graph():
    """The subject, the style and the voice already written, in prose.

    A JSON view asked the model to parse a machine format AND infer the
    video's subject from a key inside it, before it got to the job. The
    smaller local models this path exists to use did that badly — which is
    how narration came back continuing a sentence from a scene it half-read.
    """
    from localcut_engine.graph.editor import suggest_scene_prompt

    view = {
        "brief": {"prompt": "a city of glass", "style_preset": "cinematic"},
        "scenes": [
            {
                "scene_id": "s1",
                "nodes": [{"kind": "narration", "params": {"text": "The towers wake at dawn."}}],
            },
            {
                "scene_id": "s2",
                "nodes": [{"kind": "narration", "params": {"text": "Light runs down every face."}}],
            },
        ],
    }

    prompt = suggest_scene_prompt(view, 5.0)

    assert "a city of glass" in prompt
    assert "cinematic" in prompt
    # The lines already spoken, so the new one continues a voice.
    assert "The towers wake at dawn." in prompt
    assert "Light runs down every face." in prompt
    # And no raw graph: node ids and param envelopes are noise to the model
    # and crowd out the picture, which is the thing being described.
    assert "scene_id" not in prompt
    assert "node_id" not in prompt


def test_a_project_with_no_narration_yet_is_told_so():
    """An empty quote block would read as "the scenes before this say
    nothing", which invites a model to write a continuation of silence."""
    from localcut_engine.graph.editor import suggest_scene_prompt

    prompt = suggest_scene_prompt({"brief": {"prompt": "a city of glass"}}, 5.0)

    assert "first scene with words" in prompt
    assert "The scenes before this one say" not in prompt
