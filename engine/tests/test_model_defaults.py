"""Per-task default models: the persisted picker behind Settings → Models.

Two consumers make a stored default real rather than decorative: the
capability layer reorders each task's installed queue so the ComfyUI
backend renders with the chosen model when a node names none, and the
script LLM consults it before the engine-config fallback. Tasks whose
backends bind their model at construction (speech.tts, transcribe) are
refused — a knob nothing reads would be a lie.
"""

import asyncio
import contextlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from conftest import pin_hardware

from localcut_engine.api.app import _build_backends, create_app
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
from localcut_engine.manifest.loader import load_manifest
from localcut_engine.readiness import auto_defaults


@contextlib.asynccontextmanager
async def _engine(config: EngineConfig):
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


@pytest.fixture
async def client(tmp_path):
    async with _engine(EngineConfig(data_dir=tmp_path, token="test-token", backend="mock")) as http:
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


class _Ollama:
    """An Ollama on loopback that has pulled `models` and nothing else."""

    def __init__(self, models: list[str]) -> None:
        answers = {
            "/api/version": {"version": "0.35.0"},
            "/v1/models": {"object": "list", "data": [{"id": name} for name in models]},
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                body = answers.get(self.path)
                payload = json.dumps(body or {"error": "not found"}).encode()
                self.send_response(200 if body else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


async def test_auto_is_the_script_model_the_first_run_wizard_recommends(tmp_path, monkeypatch):
    """An 8 GB card does not fit qwen3-14b, so the first-run wizard
    recommends qwen3-8b-q4 and a user who follows it pulls `qwen3:8b`. Auto
    has to mean that model on every surface that names the script model, or
    the first Generate fails at the script, and readiness and Settings ask
    for a model nobody told the user to get."""
    pin_hardware(monkeypatch, 8.0)
    ollama = _Ollama(["qwen3:8b"])
    try:
        config = EngineConfig(
            data_dir=tmp_path, token="test-token", backend="llm,mock", llm_url=ollama.url
        )
        async with _engine(config) as http:
            defaults = (await http.get("/models/defaults")).json()
            programs = (await http.get("/programs")).json()
            (script,) = (await http.get("/readiness", params={"kinds": "script"})).json()["rows"]
            llm = (await http.get("/llm/models")).json()
            system = (await http.get("/system")).json()
        backend = _build_backends(config).find("llm")
        resolved = await asyncio.to_thread(backend.resolve_model, None)
    finally:
        ollama.close()

    assert defaults["auto"]["text.llm"] == "qwen3:8b"
    server = next(row for row in programs["programs"] if row["id"] == "ollama")
    assert server["checks"]["model"] == "qwen3:8b"
    assert server["checks"]["model_present"] is True
    assert (script["verdict"], script["model"]) == ("ready", "qwen3:8b")
    assert llm["default"] == "qwen3:8b"
    # What a script job asks the server for.
    assert resolved == "qwen3:8b"
    # And the model the wizard put in front of the user.
    wizard = next(row for row in system["recommendations"] if row["task"] == "text.llm")
    assert wizard["model"]["id"] == "qwen3-8b-q4"


def test_an_operator_pin_or_a_settings_pick_outranks_the_recommendation(tmp_path, monkeypatch):
    """LOCALCUT_LLM_MODEL is the operator naming the model and a stored
    Settings pick is the user naming it. The hardware decides only when
    neither has."""
    pin_hardware(monkeypatch, 8.0)
    pinned = EngineConfig(data_dir=tmp_path / "pinned", backend="llm,mock", llm_model="qwen3:14b")
    assert auto_defaults(pinned)["text.llm"] == "qwen3:14b"
    assert _build_backends(pinned).find("llm").resolve_model(None) == "qwen3:14b"

    config = EngineConfig(data_dir=tmp_path, backend="llm,mock")
    set_default(config, "text.llm", "llama3.2")
    assert _build_backends(config).find("llm").resolve_model(None) == "llama3.2"
    # Auto is what choosing Auto in the picker goes back to.
    assert auto_defaults(config)["text.llm"] == "qwen3:8b"


def test_auto_survives_the_serve_commands_rebuild_of_its_config(tmp_path, monkeypatch):
    """`localcut serve` lays its flags over the environment by rebuilding the
    config from model_dump() (cli.py). A default written into the field
    comes back out of that as a value someone set, and would pin every
    engine started that way to it."""
    pin_hardware(monkeypatch, 8.0)
    monkeypatch.delenv("LOCALCUT_LLM_MODEL", raising=False)
    monkeypatch.setenv("LOCALCUT_DATA_DIR", str(tmp_path))
    rebuilt = EngineConfig(**{**EngineConfig.from_env().model_dump(), "backend": "local,mock"})
    assert auto_defaults(rebuilt)["text.llm"] == "qwen3:8b"


def test_with_no_local_text_model_that_fits_auto_keeps_the_engine_default(tmp_path, monkeypatch):
    """No GPU: the wizard sends scripts to the cloud and recommends no local
    text model, so there is no recommendation for Auto to follow."""
    pin_hardware(monkeypatch, None)
    assert auto_defaults(EngineConfig(data_dir=tmp_path))["text.llm"] == "qwen3:14b"


def test_every_packaged_text_model_names_what_the_server_calls_it(tmp_path):
    """The recommendation names a manifest entry (`qwen3-8b-q4`), which no
    LLM server has heard of. Auto can follow it only through the name
    `ollama pull` takes and the server then lists."""
    entries = load_manifest(EngineConfig(data_dir=tmp_path)).for_task("text.llm")
    tags = {
        entry.id: [source["ollama"] for source in entry.sources if "ollama" in source]
        for entry in entries
    }
    assert tags == {"qwen3-14b-q4": ["qwen3:14b"], "qwen3-8b-q4": ["qwen3:8b"]}
