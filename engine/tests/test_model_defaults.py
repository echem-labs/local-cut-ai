"""Per-task default models: the persisted picker behind Settings → Models.

Two consumers make a stored default real rather than decorative: the
capability layer reorders each task's installed queue so the ComfyUI
backend renders with the chosen model when a node names none, and the
script LLM consults it before the engine-config fallback. Tasks whose
backends bind their model at construction (speech.tts, transcribe) are
refused — a knob nothing reads would be a lie.
"""

import json

import httpx
import pytest

from localcut_engine.api.app import create_app
from localcut_engine.backends.llm import LLMScriptBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import NodeKind
from localcut_engine.manifest import capability
from localcut_engine.manifest.defaults import (
    DEFAULTS_VERSION,
    DefaultsTooNew,
    load_defaults,
    set_default,
)


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


async def test_default_lifecycle_over_the_api(client):
    fresh = await client.get("/models/defaults")
    assert fresh.status_code == 200
    assert fresh.json()["defaults"] == {}
    assert "speech.tts" not in fresh.json()["tasks"]

    saved = await client.put("/models/defaults", json={"task": "text.llm", "model": "llama3.2"})
    assert saved.status_code == 200
    assert saved.json()["defaults"] == {"text.llm": "llama3.2"}

    # The script tool's picker reads the effective default from /llm/models —
    # it must reflect the persisted choice, not the engine-config fallback.
    llm = await client.get("/llm/models")
    assert llm.json()["default"] == "llama3.2"

    manifest_backed = await client.put(
        "/models/defaults", json={"task": "video.i2v", "model": "ltx-video-0.9-i2v"}
    )
    assert manifest_backed.status_code == 200

    cleared = await client.put("/models/defaults", json={"task": "text.llm", "model": None})
    assert cleared.json()["defaults"] == {"video.i2v": "ltx-video-0.9-i2v"}


async def test_defaults_validation_over_the_api(client):
    undefaultable = await client.put(
        "/models/defaults", json={"task": "speech.tts", "model": "kokoro-82m"}
    )
    assert undefaultable.status_code == 422

    unknown = await client.put(
        "/models/defaults", json={"task": "video.i2v", "model": "no-such-model"}
    )
    assert unknown.status_code == 404

    # sdxl-base-1.0 exists, but it serves image.gen — storing it under
    # video.i2v would silently render nothing different.
    wrong_task = await client.put(
        "/models/defaults", json={"task": "video.i2v", "model": "sdxl-base-1.0"}
    )
    assert wrong_task.status_code == 422


async def test_defaults_from_a_newer_build_are_refused(client, tmp_path):
    (tmp_path / "model-defaults.json").write_text(
        json.dumps({"version": DEFAULTS_VERSION + 1, "defaults": {}}), encoding="utf-8"
    )
    assert (await client.get("/models/defaults")).status_code == 409
    refused = await client.put("/models/defaults", json={"task": "text.llm", "model": "x"})
    assert refused.status_code == 409


def test_default_model_jumps_the_installed_queue(tmp_path, monkeypatch):
    """installed_comfy_models order IS the choice: _template_for_installed
    renders with the first installed id, so the configured default must
    come first in its task's list."""
    config = EngineConfig(data_dir=tmp_path)
    entry = {
        "family": "test",
        "requirements": {"vram_gb": 1, "disk_gb": 1},
        "license": {"id": "apache-2.0", "commercial": True},
    }
    (tmp_path / "model-manifest.json").write_text(
        json.dumps(
            {
                "models": [
                    {
                        "id": "video-a",
                        "task": "video.i2v",
                        "comfy_graph_template": "a.json",
                        **entry,
                    },
                    {
                        "id": "video-b",
                        "task": "video.i2v",
                        "comfy_graph_template": "b.json",
                        **entry,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(capability, "is_downloaded", lambda entry, models_dir: True)

    assert capability.installed_comfy_models(config)[NodeKind.CLIP] == ["video-a", "video-b"]
    set_default(config, "video.i2v", "video-b")
    assert capability.installed_comfy_models(config)[NodeKind.CLIP] == ["video-b", "video-a"]


def test_capability_survives_a_too_new_defaults_file(tmp_path, monkeypatch):
    """A refused defaults file must not take rendering down — capability
    keeps the manifest order and the routes surface the refusal."""
    config = EngineConfig(data_dir=tmp_path)
    (tmp_path / "model-defaults.json").write_text(
        json.dumps({"version": DEFAULTS_VERSION + 1}), encoding="utf-8"
    )
    with pytest.raises(DefaultsTooNew):
        load_defaults(config)
    monkeypatch.setattr(capability, "is_downloaded", lambda entry, models_dir: True)
    assert isinstance(capability.installed_comfy_models(config), dict)


def test_llm_resolve_model_precedence():
    """Explicit request > persisted default > engine-config model."""
    backend = LLMScriptBackend(model="qwen3:14b", default_model=lambda: "llama3.2")
    assert backend.resolve_model(None) == "llama3.2"
    assert backend.resolve_model("local:mistral") == "mistral"

    unconfigured = LLMScriptBackend(model="qwen3:14b", default_model=lambda: None)
    assert unconfigured.resolve_model(None) == "qwen3:14b"
