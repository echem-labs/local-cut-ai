import asyncio
import hashlib
import json
import math
import os
import shutil
import threading
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from localcut_engine.api.app import create_app
from localcut_engine.backends.base import GenerationError
from localcut_engine.config import EngineConfig

# resolved_ffmpeg_bin discovers <data_dir>/bin/ffmpeg[.exe]; the managed copy
# these tests plant has to use the name the platform actually looks for.
_FFMPEG_EXE = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"


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


async def test_unauthenticated_bodies_are_capped_before_auth(client):
    """FastAPI parses the body before route dependencies run, so the 401 is
    decided only after the bytes are already in memory. The cap has to sit
    ahead of the app, at the ASGI layer, or any LAN peer (or any web page
    that can reach the loopback port) can exhaust engine memory with no
    token at all."""
    huge = "x" * (128 << 10)  # 128 KiB, over the unauthenticated ceiling
    rejected = await client.post(
        "/projects", json={"prompt": huge}, headers={"Authorization": "Bearer wrong"}
    )
    assert rejected.status_code == 413
    assert "limit" in rejected.json()["detail"]

    # Declared-but-not-sent is refused just as hard: no reading 4 GiB to
    # discover it was too big.
    lying = await client.post(
        "/projects",
        content=b"{}",
        headers={"Authorization": "Bearer wrong", "content-length": str(4 << 30)},
    )
    assert lying.status_code == 413


async def test_authenticated_uploads_get_the_generous_cap(client):
    """The tight cap must not break a legitimate authenticated request that
    is merely large — asset upload streams its own 50 MB limit."""
    created = await client.post("/projects", json={"prompt": "x"})
    pid = created.json()["id"]
    # Comfortably past the unauthenticated ceiling, well under the authed one.
    body = b"\x89PNG\r\n\x1a\n" + b"\x00" * (256 << 10)
    response = await client.post(
        f"/projects/{pid}/assets", params={"filename": "big.png"}, content=body
    )
    assert response.status_code == 200


async def test_ws_token_rides_a_subprotocol_not_the_query_string(tmp_path):
    """A ?token= lands in uvicorn's own handshake log line (INFO, on the
    uvicorn.error logger that access_log=False does not silence), and from
    there in journald and any log attached to a bug report. Browsers can't
    set headers on a WebSocket, so the token rides the subprotocol list —
    and the server must echo the marker back or the handshake fails."""
    from starlette.testclient import TestClient

    from localcut_engine.api.app import WS_TOKEN_SUBPROTOCOL

    config = EngineConfig(data_dir=tmp_path, token="test-token", backend="mock")
    app = create_app(config)
    with TestClient(app) as http:
        with http.websocket_connect("/ws", subprotocols=[WS_TOKEN_SUBPROTOCOL, "test-token"]) as ws:
            assert ws.accepted_subprotocol == WS_TOKEN_SUBPROTOCOL

        with pytest.raises(Exception):
            with http.websocket_connect("/ws", subprotocols=[WS_TOKEN_SUBPROTOCOL, "wrong-token"]):
                pass

        # The query form still authenticates (curl, older frontends); the log
        # filter is what keeps it out of the logs.
        with http.websocket_connect("/ws?token=test-token"):
            pass


def test_log_redaction_scrubs_tokens_from_request_lines():
    """uvicorn logs '"WebSocket /ws?token=… [accepted]"' on uvicorn.error, a
    logger access_log=False does not touch."""
    import logging

    from localcut_engine.api.app import install_log_redaction

    install_log_redaction()
    install_log_redaction()  # idempotent — safe for embedders and tests
    logger = logging.getLogger("uvicorn.error")
    assert len(logger.filters) == 1

    record = logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        0,
        '%s - "WebSocket %s" [accepted]',
        ("127.0.0.1:43986", "/ws?token=aGn_Ni-2xOCzL3p6_6Sr3CGEnbPfJ9AJ"),
        None,
    )
    assert all(f.filter(record) for f in logger.filters)
    assert "aGn_Ni" not in (record.getMessage())
    assert "token=[redacted]" in record.getMessage()


@pytest.mark.parametrize(
    ("msg", "args", "expect_absent"),
    [
        # The token baked into the format string, with args still to fill.
        # Redacting the format string in place eats the `%s` inside the token
        # run, leaving more args than placeholders — logging then drops the
        # record and prints a traceback of its own.
        ("WebSocket /ws?token=%s [accepted]", ("s3cr3t-value",), "s3cr3t-value"),
        # No args at all: the plainest case.
        ("connected to /ws?token=s3cr3t-value", (), "s3cr3t-value"),
        # Token in the args, format string clean — uvicorn's real shape.
        ('%s - "WebSocket %s"', ("127.0.0.1:1", "/ws?token=s3cr3t-value"), "s3cr3t-value"),
    ],
)
def test_log_redaction_survives_every_record_shape(msg, args, expect_absent):
    """The filter is installed on loggers the engine does not own, so it must
    never be able to break a record: a record that raises during formatting is
    dropped, which is both noisy and a hole in the output being sanitized."""
    import logging

    from localcut_engine.api.app import install_log_redaction

    install_log_redaction()
    logger = logging.getLogger("uvicorn.error")
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 0, msg, args, None)
    assert all(f.filter(record) for f in logger.filters)
    rendered = record.getMessage()  # must not raise
    assert expect_absent not in rendered
    assert "token=[redacted]" in rendered


def test_log_redaction_leaves_dict_style_args_alone():
    """`%`-style dict args are stored as the bare dict, not a 1-tuple.
    Wrapping one makes getMessage() raise "format requires a mapping"."""
    import logging

    from localcut_engine.api.app import install_log_redaction

    install_log_redaction()
    logger = logging.getLogger("uvicorn.error")
    # Passed as a 1-tuple, which is what `logger.info("%(k)s", {...})` does —
    # LogRecord unwraps it to the bare dict, and that is the shape the filter
    # has to leave alone.
    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 0, "%(where)s ready", ({"where": "engine"},), None
    )
    assert record.args == {"where": "engine"}  # unwrapped, not a tuple
    assert all(f.filter(record) for f in logger.filters)
    assert record.getMessage() == "engine ready"


def test_log_redaction_keeps_lazy_formatting_for_records_without_a_token():
    """The common case must stay untouched — pre-rendering every record would
    defeat lazy formatting and break structured handlers that read `args`."""
    import logging

    from localcut_engine.api.app import install_log_redaction

    install_log_redaction()
    logger = logging.getLogger("uvicorn.error")
    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 0, "started on %s", ("127.0.0.1:7830",), None
    )
    assert all(f.filter(record) for f in logger.filters)
    assert record.msg == "started on %s"
    assert record.args == ("127.0.0.1:7830",)


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
    # Capability tri-state: True/False when ffmpeg was probed, None when the
    # binary is absent — setup UIs key the titles warning off False alone.
    assert body["ffmpeg_drawtext"] in (True, False, None)


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


def _provision_local_stack(config, monkeypatch):
    """Make every capability gate pass: companion servers 'up' and the
    weight files the local backends stat into place (dests read from the
    manifest so the test can't drift from it)."""
    from localcut_engine.api.app import _model_dests
    from localcut_engine.backends.base import ServiceProbe

    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    for model_id in ("kokoro-82m", "faster-whisper-base-en"):
        for dest in _model_dests(config, model_id) or []:
            path = config.resolved_models_dir / dest
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
    managed_ffmpeg = config.data_dir / "bin" / _FFMPEG_EXE
    managed_ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    managed_ffmpeg.touch()


def test_backend_chain_parsing_and_composition(tmp_path, monkeypatch):
    """The desktop shell passes --backend as a flag; chains must be accepted
    end-to-end (argparse pattern removed, config expands shorthands, and the
    app factory composes the registry in order with mock as the catch-all
    for everything EXCEPT assembly)."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.config import EngineConfig
    from localcut_engine.graph.model import NodeKind

    assert EngineConfig(backend="llm,comfy,mock").backend_chain == ["llm", "comfy", "mock"]
    assert EngineConfig(backend="local,mock").backend_chain == [
        "llm",
        "comfy",
        "chatterbox",
        "kokoro",
        "align",
        "ffmpeg",
        "mock",
    ]

    config = EngineConfig(
        data_dir=tmp_path, backend="llm,comfy,mock", comfy_kinds="keyframe,thumbnail"
    )
    _provision_local_stack(config, monkeypatch)
    registry = _build_backends(config)
    assert registry.resolve(NodeKind.SCRIPT).name == "llm"
    assert registry.resolve(NodeKind.KEYFRAME).name == "comfyui"
    assert registry.resolve(NodeKind.CLIP).name == "mock"  # not in comfy_kinds
    # NOT mock: this chain has no ffmpeg, and a placeholder MP4 handed over
    # as a finished export is worse than a clear failure.
    with pytest.raises(GenerationError, match="ffmpeg"):
        registry.resolve(NodeKind.EXPORT)

    # With every capability gate satisfied, the full-local chain must
    # resolve every generative kind (no dead lanes). Explicit kinds here:
    # the default ("auto") is covered by the auto-kinds test below.
    local = _build_backends(
        EngineConfig(
            data_dir=tmp_path, backend="local", comfy_kinds="keyframe,thumbnail,clip,music"
        )
    )
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


def test_local_backends_decline_without_their_prerequisites(tmp_path):
    """The hybrid default chain ('local,mock') must degrade to mock per
    GENERATIVE task on a bare machine — no Ollama, no weights, no ffmpeg —
    instead of failing jobs. Closed-port URLs make the probes refuse
    instantly.

    Assembly is the exception: a draft still or a placeholder narration is a
    recognisable stand-in the user can see is provisional, but a placeholder
    MP4 named "your export" is indistinguishable from the real thing. That
    one has to fail."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.graph.model import NodeKind

    config = EngineConfig(
        data_dir=tmp_path,
        backend="local,mock",
        llm_url="http://127.0.0.1:9/v1",
        comfyui_url="http://127.0.0.1:9",
        ffmpeg_bin=str(tmp_path / "missing" / "ffmpeg"),
    )
    registry = _build_backends(config)
    for kind in (
        NodeKind.SCRIPT,
        NodeKind.KEYFRAME,
        NodeKind.CLIP,
        NodeKind.NARRATION,
        NodeKind.CAPTIONS,
        NodeKind.MUSIC,
    ):
        assert registry.resolve(kind).name == "mock", kind
    for kind in (NodeKind.TIMELINE, NodeKind.EXPORT):
        with pytest.raises(GenerationError, match="ffmpeg"):
            registry.resolve(kind)

    # An EXPLICIT all-mock chain is the demo/test configuration and is not
    # pretending to be anything else — it still assembles end to end.
    all_mock = _build_backends(EngineConfig(data_dir=tmp_path, backend="mock"))
    assert all_mock.resolve(NodeKind.EXPORT).name == "mock"


def test_local_backends_claim_once_prerequisites_appear(tmp_path, monkeypatch):
    """Same registry, no rebuild: gates are probed live, so weights landing
    (or servers coming up) reroute the next render without a restart."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.graph.model import NodeKind

    config = EngineConfig(
        data_dir=tmp_path,
        backend="kokoro,align,ffmpeg,mock",
        ffmpeg_bin=str(tmp_path / "bin" / "ffmpeg"),
    )
    registry = _build_backends(config)
    assert registry.resolve(NodeKind.NARRATION).name == "mock"
    assert registry.resolve(NodeKind.CAPTIONS).name == "mock"
    with pytest.raises(GenerationError, match="ffmpeg"):
        registry.resolve(NodeKind.EXPORT)  # no ffmpeg yet — never faked

    _provision_local_stack(config, monkeypatch)
    assert registry.resolve(NodeKind.NARRATION).name == "kokoro"
    assert registry.resolve(NodeKind.CAPTIONS).name == "align"
    assert registry.resolve(NodeKind.EXPORT).name == "ffmpeg"


def test_comfy_auto_kinds_follow_installed_weights(tmp_path, monkeypatch):
    """Default comfy_kinds ("auto") claims a kind only while a downloaded
    manifest model can serve it — and flips live, no registry rebuild, so
    a finished download reroutes the next render without a restart. The
    server-liveness half of the gate is pinned up here; weights are the
    variable under test."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.backends.base import ServiceProbe
    from localcut_engine.graph.model import NodeKind

    monkeypatch.setattr(ServiceProbe, "available", lambda self: True)
    managed_ffmpeg = tmp_path / "bin" / _FFMPEG_EXE
    managed_ffmpeg.parent.mkdir(parents=True)
    managed_ffmpeg.touch()  # the still-clip tier needs a discoverable binary

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
                            {"url": "http://localhost/w", "dest": "checkpoints/tiny.safetensors"}
                        ],
                    }
                ],
            }
        )
    )
    config = EngineConfig(data_dir=tmp_path, backend="comfy,ffmpeg,mock")
    registry = _build_backends(config)
    # No weights on disk: comfy declines clips → the still-clip tier serves.
    assert registry.resolve(NodeKind.CLIP).name == "ffmpeg"
    assert registry.resolve(NodeKind.KEYFRAME).name == "mock"

    weights = tmp_path / "models" / "checkpoints" / "tiny.safetensors"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"w")
    assert registry.resolve(NodeKind.CLIP).name == "comfyui"
    # Image/music tasks still have no installed model.
    assert registry.resolve(NodeKind.KEYFRAME).name == "mock"
    assert registry.resolve(NodeKind.MUSIC).name == "mock"


def test_comfy_auto_kinds_with_broken_manifest_claim_nothing(tmp_path):
    """An unreadable override manifest must not wedge routing — comfy claims
    nothing and the chain's fallbacks serve everything."""
    from localcut_engine.api.app import _build_backends
    from localcut_engine.graph.model import NodeKind

    (tmp_path / "model-manifest.json").write_text("{not json")
    registry = _build_backends(EngineConfig(data_dir=tmp_path, backend="comfy,mock"))
    assert registry.resolve(NodeKind.CLIP).name == "mock"
    assert registry.resolve(NodeKind.KEYFRAME).name == "mock"


async def test_system_reports_resolved_backend_chain(client):
    body = (await client.get("/system")).json()
    backends = body["backends"]
    assert backends["chain"] == ["mock"]
    assert backends["comfy_kinds_auto"] is True
    assert [row["kind"] for row in backends["tasks"]] == [
        "script",
        "keyframe",
        "thumbnail",
        "clip",
        "narration",
        "captions",
        "music",
        "timeline",
        "export",
    ]
    assert all(row["backend"] == "mock" for row in backends["tasks"])
    assert all(row["installed_models"] == [] for row in backends["tasks"])


async def test_create_project_validates_aspect_and_duration(client):
    # Unknown aspects silently render as the default one downstream; bad
    # durations only fail later as opaque job errors — both must 422 here.
    bad_aspect = await client.post("/projects", json={"prompt": "x", "aspect": "4:3"})
    assert bad_aspect.status_code == 422
    bad_duration = await client.post("/projects", json={"prompt": "x", "target_duration_s": 0})
    assert bad_duration.status_code == 422
    over_cap = await client.post("/projects", json={"prompt": "x", "target_duration_s": 1201})
    assert over_cap.status_code == 422
    at_cap = await client.post("/projects", json={"prompt": "x", "target_duration_s": 1200})
    assert at_cap.status_code == 200
    # Quick tools carry the same bounds — they build the same script node.
    tool_over = await client.post(
        "/tools", json={"tool": "script", "prompt": "x", "target_duration_s": 1201}
    )
    assert tool_over.status_code == 422
    tool_at = await client.post(
        "/tools", json={"tool": "script", "prompt": "x", "target_duration_s": 1200}
    )
    assert tool_at.status_code == 200


async def test_patch_input_errors_are_422_not_500(client):
    created = await client.post("/projects", json={"prompt": "x"})
    pid = created.json()["id"]
    # add_node without a node body raises ValueError in apply_patch.
    response = await client.post(
        f"/projects/{pid}/patch",
        json={"ops": [{"op": "add_node", "node_id": "extra"}]},
    )
    assert response.status_code == 422


async def test_undo_redo_and_savepoints_over_the_api(client):
    created = await client.post("/projects", json={"prompt": "a red door"})
    pid = created.json()["id"]

    empty = await client.post(f"/projects/{pid}/undo")
    assert empty.status_code == 409  # nothing recorded yet

    saved = await client.post(f"/projects/{pid}/savepoints", json={"label": "start"})
    assert saved.status_code == 200
    savepoint = saved.json()["savepoints"][0]

    patched = await client.post(
        f"/projects/{pid}/patch",
        json={
            "ops": [{"op": "set_params", "node_id": "script", "params": {"prompt": "a blue door"}}]
        },
    )
    assert patched.status_code == 200
    info = await client.get(f"/projects/{pid}/history")
    assert info.json()["undo_depth"] == 1
    assert info.json()["undo_top"]["kind"] == "patch"

    undone = await client.post(f"/projects/{pid}/undo")
    assert undone.status_code == 200
    assert undone.json()["redo_depth"] == 1
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["script"]["params"]["prompt"] == "a red door"

    assert (await client.post(f"/projects/{pid}/redo")).status_code == 200
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["script"]["params"]["prompt"] == "a blue door"

    restored = await client.post(f"/projects/{pid}/savepoints/{savepoint['id']}/restore")
    assert restored.status_code == 200
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["script"]["params"]["prompt"] == "a red door"

    assert (await client.delete(f"/projects/{pid}/savepoints/{savepoint['id']}")).status_code == 200
    missing = await client.post(f"/projects/{pid}/savepoints/{savepoint['id']}/restore")
    assert missing.status_code == 404

    unlabeled = await client.post(f"/projects/{pid}/savepoints", json={"label": ""})
    assert unlabeled.status_code == 422


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


async def test_model_download_api_lifecycle(client, tmp_path, monkeypatch):
    """POST /models/{id}/download runs the manifest download in the
    background; GET /models reflects install state throughout."""
    # The route under test is the lifecycle, not the SSRF policy — and the
    # policy refuses loopback on purpose (test_downloads covers it).
    from localcut_engine.manifest import downloads as downloads_module

    monkeypatch.setattr(downloads_module, "assert_public_url", lambda url: None)
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

    async def fake_complete(self, prompt, system, max_tokens=None):
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

    async def broken_complete(self, prompt, system, max_tokens=None):
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


async def test_voice_cloning_is_consent_gated_but_plain_audio_is_not(client):
    """The consent affirmation gates the voice_consent STAMP, not the door:
    audio uploaded without it lands as a plain audio asset (a music bed, a
    session output added to another project) that the voice_ref chokepoint
    then refuses to wire. Only a consented upload can ever reach cloning."""
    created = await client.post("/projects", json={"prompt": "voice test"})
    pid = created.json()["id"]

    # Without the affirmation: accepted, but NOT a voice sample.
    plain = await client.post(f"/projects/{pid}/assets?filename=bed.wav", content=b"RIFFbed")
    assert plain.status_code == 200
    plain_id = plain.json()["node_id"]
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert "voice_consent" not in graph["nodes"][plain_id]["params"]

    # The chokepoint holds: the unstamped asset cannot feed voice_ref.
    async def scenes() -> list:
        return (await client.get(f"/projects/{pid}")).json()["board"]["scenes"]

    async with asyncio.timeout(15):
        while not await scenes():
            await asyncio.sleep(0.05)
    refused = await client.post(
        f"/projects/{pid}/patch",
        json={
            "ops": [
                {"op": "connect", "node_id": "s1.narration", "src": plain_id, "port": "voice_ref"}
            ]
        },
    )
    assert refused.status_code == 422
    assert "consent" in refused.json()["detail"]

    # With the affirmation: stamped, and the same wire is accepted.
    allowed = await client.post(
        f"/projects/{pid}/assets?filename=me.wav&consent=true", content=b"RIFFdata"
    )
    assert allowed.status_code == 200
    node_id = allowed.json()["node_id"]
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"][node_id]["params"]["voice_consent"] is True
    wired = await client.post(
        f"/projects/{pid}/patch",
        json={
            "ops": [
                {"op": "connect", "node_id": "s1.narration", "src": node_id, "port": "voice_ref"}
            ]
        },
    )
    assert wired.status_code == 200
    # Images never carry the flag (and never need consent).
    image = await client.post(f"/projects/{pid}/assets?filename=pic.png", content=b"png")
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert "voice_consent" not in graph["nodes"][image.json()["node_id"]]["params"]


async def test_video_assets_are_accepted(client):
    """A clip artifact added to another project arrives as an .mp4 — the
    assets door takes it like any image: a plain asset node, born cached,
    no consent question to ask."""
    created = await client.post("/projects", json={"prompt": "video asset test"})
    pid = created.json()["id"]

    uploaded = await client.post(
        f"/projects/{pid}/assets?filename=take.mp4", content=b"\x00\x00\x00 ftypisom"
    )
    assert uploaded.status_code == 200
    asset = uploaded.json()
    board = (await client.get(f"/projects/{pid}")).json()["board"]
    assert board["aux"][asset["node_id"]]["artifact_hash"] == asset["hash"]
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert "voice_consent" not in graph["nodes"][asset["node_id"]]["params"]


async def test_dev_origin_preflight_is_answered_only_when_configured(tmp_path):
    """The desktop dev flow serves the renderer from vite's http origin,
    where Chromium preflights every token-carrying request — an engine
    with no CORS surface fails ALL of them while the (preflight-exempt)
    WebSocket connects fine, which reads as "engine up, every list dead".
    `allow_origin` answers the preflight for exactly the one origin the
    shell names; by default there is no CORS surface at all."""
    preflight_headers = {
        "Origin": "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    }

    async def preflight(config):
        app = create_app(config)
        transport = httpx.ASGITransport(app=app)
        async with (
            transport,
            httpx.AsyncClient(transport=transport, base_url="http://engine") as http,
        ):
            async with app.router.lifespan_context(app):
                return await http.options("/projects", headers=preflight_headers)

    allowed = await preflight(
        EngineConfig(
            data_dir=tmp_path / "dev",
            token="test-token",
            backend="mock",
            allow_origin="http://127.0.0.1:5173",
        )
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert "authorization" in allowed.headers["access-control-allow-headers"].lower()

    default = await preflight(
        EngineConfig(data_dir=tmp_path / "plain", token="test-token", backend="mock")
    )
    assert "access-control-allow-origin" not in default.headers


async def test_edit_dry_run_previews_without_committing(client, monkeypatch):
    """dry_run compiles the plan and reports the ops and the dirty cone,
    but the graph, the undo history and the queue are untouched; the plan
    then lands through /edit/apply with no second LLM call."""
    from localcut_engine.backends.llm import LLMScriptBackend

    created = await client.post("/projects", json={"prompt": "city of glass"})
    pid = created.json()["id"]

    async def scenes() -> list:
        return (await client.get(f"/projects/{pid}")).json()["board"]["scenes"]

    async with asyncio.timeout(15):
        while not await scenes():
            await asyncio.sleep(0.05)

    async def fake_complete(self, prompt, system, max_tokens=None):
        return json.dumps(
            {
                "summary": "night mode",
                "edits": [
                    {
                        "action": "update",
                        "node_id": "s1.keyframe",
                        "params": {"prompt": "night city"},
                    }
                ],
            }
        )

    monkeypatch.setattr(LLMScriptBackend, "complete", fake_complete)
    preview = await client.post(
        f"/projects/{pid}/edit", json={"instruction": "night", "dry_run": True}
    )
    assert preview.status_code == 200
    body = preview.json()
    assert body["ops"] == 1
    assert body["planned"][0]["op"] == "set_params"
    assert "s1.clip" in body["dirty"]  # the cone apply would re-render
    assert body["plan"]["summary"] == "night mode"

    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["s1.keyframe"]["params"]["prompt"] != "night city"
    history = (await client.get(f"/projects/{pid}/history")).json()
    assert history["undo_depth"] == 0  # nothing to undo: nothing happened

    applied = await client.post(
        f"/projects/{pid}/edit/apply",
        json={"plan": body["plan"], "revision": body["revision"]},
    )
    assert applied.status_code == 200
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert graph["nodes"]["s1.keyframe"]["params"]["prompt"] == "night city"

    # The revision the preview was built against is stale now.
    stale = await client.post(
        f"/projects/{pid}/edit/apply",
        json={"plan": body["plan"], "revision": body["revision"]},
    )
    assert stale.status_code == 409


async def test_edit_refuses_a_plan_built_against_a_stale_graph(client, monkeypatch):
    """If the graph is re-expanded (scene renumbering) while the LLM is
    thinking, the stale plan must 409, not land on content it never saw."""
    from localcut_engine.backends.llm import LLMScriptBackend

    created = await client.post("/projects", json={"prompt": "stale test"})
    pid = created.json()["id"]

    async def scenes() -> list:
        return (await client.get(f"/projects/{pid}")).json()["board"]["scenes"]

    async with asyncio.timeout(15):
        while not await scenes():
            await asyncio.sleep(0.05)

    # The LLM "thinks" — and during that window the project is patched, which
    # moves the revision the view was built against.
    async def edit_during_which_graph_changes(self, prompt, system, max_tokens=None):
        await client.post(
            f"/projects/{pid}/patch",
            json={
                "ops": [
                    {"op": "set_params", "node_id": "s1.keyframe", "params": {"prompt": "moved"}}
                ]
            },
        )
        return json.dumps(
            {
                "summary": "x",
                "edits": [
                    {"action": "update", "node_id": "s1.narration", "params": {"text": "late"}}
                ],
            }
        )

    monkeypatch.setattr(LLMScriptBackend, "complete", edit_during_which_graph_changes)
    response = await client.post(f"/projects/{pid}/edit", json={"instruction": "change it"})
    assert response.status_code == 409
    assert "changed" in response.json()["detail"]


# -- review 4: project lifecycle + read model + storage + custom models -------


async def _wait_for(check, attempts=400, delay=0.02):
    for _ in range(attempts):
        result = await check()
        if result:
            return result
        await asyncio.sleep(delay)
    raise AssertionError("condition never became true")


async def test_rename_project(client):
    pid = (await client.post("/projects", json={"prompt": "rename me"})).json()["id"]

    renamed = await client.patch(f"/projects/{pid}", json={"title": "A better name"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "A better name"
    assert renamed.json()["updated_at"] is not None

    listed = {p["id"]: p for p in (await client.get("/projects")).json()}
    assert listed[pid]["title"] == "A better name"

    assert (await client.patch(f"/projects/{pid}", json={"title": "   "})).status_code == 422
    assert (await client.patch("/projects/aaaaaaaaaa", json={"title": "x"})).status_code == 404


async def test_list_carries_home_read_model(client):
    pid = (
        await client.post(
            "/projects", json={"prompt": "read model", "aspect": "16:9", "target_duration_s": 30}
        )
    ).json()["id"]

    async def thumb_ready():
        listed = {p["id"]: p for p in (await client.get("/projects")).json()}
        return listed[pid] if listed[pid].get("thumb_hash") else None

    row = await _wait_for(thumb_ready)
    assert row["aspect"] == "16:9"
    assert row["duration_s"] and row["duration_s"] > 0
    assert row["updated_at"] >= row["created_at"]
    # The denormalized thumb must be a real, servable artifact.
    artifact = await client.get(f"/projects/{pid}/artifacts/{row['thumb_hash']}")
    assert artifact.status_code == 200


async def test_duplicate_project(client):
    pid = (await client.post("/projects", json={"prompt": "twin study"})).json()["id"]

    async def scenes_done():
        board = (await client.get(f"/projects/{pid}")).json()["board"]
        scenes = board["scenes"]
        return scenes if scenes and all(s["clip"]["artifact_hash"] for s in scenes) else None

    original = await _wait_for(scenes_done)

    copy = await client.post(f"/projects/{pid}/duplicate")
    assert copy.status_code == 200
    body = copy.json()
    assert body["id"] != pid
    assert body["title"].endswith("copy")

    # Content-addressed artifacts travel: the copy's board is fully cached
    # with the same hashes, no re-render enqueued for existing outputs.
    twin = (await client.get(f"/projects/{body['id']}")).json()["board"]
    assert [s["clip"]["artifact_hash"] for s in twin["scenes"]] == [
        s["clip"]["artifact_hash"] for s in original
    ]

    assert (await client.post("/projects/aaaaaaaaaa/duplicate")).status_code == 404


async def test_storage_overview_and_cleanup(client):
    pid = (await client.post("/projects", json={"prompt": "disk eater"})).json()["id"]

    storage = (await client.get("/storage")).json()
    assert any(row["id"] == pid for row in storage["projects"])
    assert storage["disk_free_bytes"] > 0
    for key in ("models_bytes", "cache_bytes", "disk_total_bytes"):
        assert key in storage

    # About -> This machine names the folder all of the above is measured
    # from. Without it the panel can report "41 GB used" and leave the user
    # no way to find out used WHERE - which for a remote engine is not even
    # this machine.
    assert Path(storage["data_dir"]).is_absolute()

    cleaned = await client.post("/storage/cleanup")
    assert cleaned.status_code == 200
    assert cleaned.json()["ok"] and cleaned.json()["freed_bytes"] >= 0


async def test_custom_model_lifecycle(client, tmp_path):
    weight = tmp_path / "my-finetune.safetensors"
    weight.write_bytes(b"w" * 2048)

    added = await client.post(
        "/models/custom",
        json={
            "name": "My Wan finetune",
            "task": "video.i2v",
            "source": "file",
            "ref": str(weight),
            "vram_gb": 16,
        },
    )
    assert added.status_code == 200
    entry = added.json()
    assert entry["custom"] is True
    assert entry["license"]["verdict"] == "conditions"

    rows = {r["id"]: r for r in (await client.get("/models")).json()}
    row = rows[entry["id"]]
    # A local-file source is installed at add time — copied into models dir.
    assert row["custom"] and row["downloaded"]
    # Weights are namespaced by the unique entry id so two custom models that
    # share a source basename never collide on one on-disk path.
    dest_rel = entry["files"][0]["dest"]
    assert entry["id"] in dest_rel
    assert (tmp_path / "models" / dest_rel).exists()

    # Validation: bad url / missing file / path-shaped template are 422s.
    bad = {"name": "x", "task": "image.gen", "source": "url", "ref": "ftp://nope"}
    assert (await client.post("/models/custom", json=bad)).status_code == 422
    missing = {"name": "x", "task": "image.gen", "source": "file", "ref": str(tmp_path / "no")}
    assert (await client.post("/models/custom", json=missing)).status_code == 422

    removed = await client.delete(f"/models/custom/{entry['id']}")
    assert removed.status_code == 200
    assert removed.json()["freed_bytes"] > 0
    rows = {r["id"]: r for r in (await client.get("/models")).json()}
    assert entry["id"] not in rows
    # Deleting a curated entry through the custom route must refuse.
    curated = next(iter(rows))
    assert (await client.delete(f"/models/custom/{curated}")).status_code == 404


def test_resolved_ffmpeg_bin_prefers_managed_download(tmp_path):
    """The bare default discovers <data_dir>/bin/ffmpeg (the shell installs
    it there but spawns the engine without pointing at it); an explicit
    path always wins; no managed copy → the bare name stays."""
    from localcut_engine.config import EngineConfig

    config = EngineConfig(data_dir=tmp_path)
    assert config.resolved_ffmpeg_bin == "ffmpeg"

    managed = tmp_path / "bin" / _FFMPEG_EXE
    managed.parent.mkdir()
    managed.write_bytes(b"")
    assert EngineConfig(data_dir=tmp_path).resolved_ffmpeg_bin == str(managed)

    explicit = EngineConfig(data_dir=tmp_path, ffmpeg_bin="/opt/ffmpeg/ffmpeg")
    assert explicit.resolved_ffmpeg_bin == "/opt/ffmpeg/ffmpeg"


async def test_non_ascii_token_is_rejected_not_a_500(client):
    """compare_digest raises TypeError on non-ASCII str, which would leave
    auth as an unhandled 500 (plus a traceback per request) instead of a
    401 — an unauthenticated log-flood primitive on a remote engine."""
    # Empty Authorization so the QUERY token is what gets compared.
    response = await client.get("/projects", params={"token": "ü"}, headers={"Authorization": ""})
    assert response.status_code == 401


def test_probe_callers_wait_for_the_first_verdict(monkeypatch):
    """available() must never answer from the uninitialized default while
    the first probe is still running: a False there routes real work to the
    mock backend, which writes placeholder artifacts into a real project."""
    import threading

    import httpx

    from localcut_engine.backends.base import ServiceProbe

    release = threading.Event()

    def slow_get(url, timeout=None):
        release.wait(5.0)
        return httpx.Response(200, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", slow_get)
    probe = ServiceProbe("http://127.0.0.1:1/health", timeout_s=1.0, ttl_s=60.0)

    answers: list[bool] = []
    first = threading.Thread(target=lambda: answers.append(probe.available()))
    first.start()
    threading.Event().wait(0.1)  # let the first caller take the probe
    second = threading.Thread(target=lambda: answers.append(probe.available()))
    second.start()

    release.set()
    first.join(10.0)
    second.join(10.0)
    assert answers == [True, True], f"a concurrent caller saw a stale verdict: {answers}"


def test_probe_survives_a_refresh_thread_that_cannot_start(monkeypatch):
    """_refresh is the only thing that clears the in-flight flag, so a
    failed Thread.start() would freeze this verdict for the process's life —
    a server that came back up reported down forever."""
    import threading

    import httpx

    from localcut_engine.backends.base import ServiceProbe

    monkeypatch.setattr(
        httpx,
        "get",
        lambda url, timeout=None: httpx.Response(200, request=httpx.Request("GET", url)),
    )
    probe = ServiceProbe("http://127.0.0.1:1/health", timeout_s=1.0, ttl_s=0.0)
    assert probe.available() is True  # synchronous first probe

    def refuse(*args, **kwargs):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", refuse)
    assert probe.available() is True  # ttl expired -> background refresh refused
    monkeypatch.undo()
    # Not latched: the next call is free to refresh again.
    assert probe.available() is True


async def test_render_is_a_route_of_its_own_not_an_empty_patch(client):
    """The draft-quality twin of /finalize, and what a headless caller means
    by "render this".

    An empty /patch does NOT do this: `patch` re-plans only when an op
    dirtied something, so on a project whose queue had been drained it
    enqueued nothing and the CLI reported "render finished" over a queue it
    had never filled. That end of it — a drained queue actually refilling —
    is asserted in test_automation_cli, which can wait for the screenplay to
    expand and cancel jobs while they are still queued; here the mock
    backend finishes them first, so the count is a race rather than a fact.
    What this pins is the route's own contract.
    """
    project_id = (await client.post("/projects", json={"prompt": "a route"})).json()["id"]

    rendered = await client.post(f"/projects/{project_id}/render")

    assert rendered.status_code == 200
    assert isinstance(rendered.json()["enqueued"], int)


async def test_render_does_not_double_enqueue_work_already_in_flight(client):
    """A script may call it twice, or call it during a render. Neither may
    queue a second copy of a node that already has an identical job in
    flight — `_enqueue_dirty` skips those, and this route inherits it."""
    project_id = (await client.post("/projects", json={"prompt": "twice"})).json()["id"]
    await client.post(f"/projects/{project_id}/render")

    before = len((await client.get("/jobs", params={"project_id": project_id})).json())
    await client.post(f"/projects/{project_id}/render")
    after = (await client.get("/jobs", params={"project_id": project_id})).json()

    planned = [job for job in after if job["status"] in ("queued", "rendering")]
    assert len({(job["spec"]["node_id"], job["spec"]["output_hash"]) for job in planned}) == len(
        planned
    ), "the same node was queued twice"
    assert len(after) >= before


async def test_render_404s_for_a_project_that_is_not_there(client):
    assert (await client.post("/projects/aaaaaaaaaa/render")).status_code == 404


# -- artifact download filenames ----------------------------------------------


def test_artifact_filenames_are_readable_slugs(tmp_path):
    """A served artifact is named for the human who downloads it — a slug of
    the title plus the artifact's real suffix — never the bare output hash
    the store keys it by."""
    from localcut_engine.api.app import artifact_filename

    out_hash = "ab" * 32
    wav = tmp_path / f"{out_hash}.wav"
    wav.write_bytes(b"")
    assert (
        artifact_filename("A 60s script on how Istanbul was captured!", wav, out_hash)
        == "a-60s-script-on-how-istanbul-was-captured.wav"
    )

    # Screenplays carry a better title than the prompt — the one the script
    # model wrote — so that is the one the file is named after.
    screenplay = tmp_path / f"{out_hash}.screenplay.json"
    screenplay.write_text(json.dumps({"title": "The Fall of Istanbul"}), encoding="utf-8")
    assert (
        artifact_filename("prompt goes here", screenplay, out_hash)
        == "the-fall-of-istanbul.screenplay.json"
    )

    # A title with nothing sluggable falls back to the hash, not to "".
    assert artifact_filename("— —", wav, out_hash) == f"{out_hash[:12]}.wav"

    # A corrupt screenplay must not break serving — the project title stands.
    broken = tmp_path / f"{out_hash}.screenplay.json"
    broken.write_text("{not json", encoding="utf-8")
    assert artifact_filename("plan b", broken, out_hash) == "plan-b.screenplay.json"


async def test_artifact_route_names_the_download(client):
    """The desktop's Download button is a bare <a download> on this route, so
    the filename the user sees is whatever this header says — without it,
    Chromium falls back to the URL basename, which is the output hash."""
    pid = (
        await client.post("/tools", json={"tool": "script", "prompt": "Name me nicely, please"})
    ).json()["id"]

    async def script_ready():
        board = (await client.get(f"/projects/{pid}")).json()["board"]
        node = board["aux"].get("script")
        return node if node and node.get("artifact_hash") else None

    node = await _wait_for(script_ready)
    response = await client.get(f"/projects/{pid}/artifacts/{node['artifact_hash']}")
    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    # inline: the same route feeds <video>/<audio> playback — naming the
    # download must not turn a player fetch into an attachment.
    assert disposition.startswith("inline")
    assert 'filename="name-me-nicely-please.screenplay.json"' in disposition


# -- script model selection ---------------------------------------------------


async def test_llm_models_route_answers_even_without_a_server(client):
    """The tool panel asks this before offering a picker. A mock-chain
    engine (or a dead Ollama) is a fact to report, never a 500."""
    response = await client.get("/llm/models")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["models"] == []
    assert isinstance(body["default"], str)


async def test_tool_script_carries_a_model_choice_onto_the_node(client):
    created = await client.post(
        "/tools", json={"tool": "script", "prompt": "pick me", "model": "local:phi4"}
    )
    assert created.status_code == 200
    pid = created.json()["id"]
    board = (await client.get(f"/projects/{pid}")).json()["board"]
    assert board["aux"]["script"]["model"] == "local:phi4"


async def test_tool_script_rejects_a_garbage_model_string(client):
    response = await client.post(
        "/tools", json={"tool": "script", "prompt": "p", "model": "rm -rf /; llama"}
    )
    assert response.status_code == 422


# -- script enhance -----------------------------------------------------------


async def test_enhance_reasks_the_script_with_the_feedback(client):
    pid = (
        await client.post("/tools", json={"tool": "script", "prompt": "istanbul, dramatic"})
    ).json()["id"]

    async def script_ready():
        board = (await client.get(f"/projects/{pid}")).json()["board"]
        node = board["aux"].get("script")
        return node if node and node.get("artifact_hash") else None

    first = await _wait_for(script_ready)

    enhanced = await client.post(
        f"/projects/{pid}/script/enhance", json={"notes": "focus on 1453, not 1922"}
    )
    assert enhanced.status_code == 200
    assert "script" in enhanced.json()["dirty"]

    # The feedback and the screenplay it amends ride the node's params, which
    # is what puts them in the output hash (a re-ask that hashed identical
    # would be served from cache) and in front of every script backend. They
    # live in the graph, not the board — see the transient-params test below.
    node = (await client.get(f"/projects/{pid}/graph")).json()["nodes"]["script"]
    assert node["params"]["feedback"] == "focus on 1453, not 1922"
    assert node["params"]["base_screenplay"]
    # The edit dirtied the node: a NEW script job exists for a new identity.
    second = await _wait_for(script_ready)
    assert second["artifact_hash"] != first["artifact_hash"]


async def test_enhance_refuses_when_there_is_no_script(client):
    pid = (
        await client.post("/tools", json={"tool": "thumbnail", "prompt": "a fine cover"})
    ).json()["id"]
    response = await client.post(f"/projects/{pid}/script/enhance", json={"notes": "longer"})
    assert response.status_code == 409

    blank = await client.post(f"/projects/{pid}/script/enhance", json={"notes": "   "})
    assert blank.status_code == 422


async def test_enhance_notes_do_not_outlive_the_render_they_asked_for(client):
    """Feedback and the draft it amends describe one completed revision, not
    the node's configuration. Left in params they would ride every later
    regenerate — re-asking the old notes against a draft that is now two
    versions stale — and travel into exported templates."""
    pid = (await client.post("/tools", json={"tool": "script", "prompt": "one-shot"})).json()["id"]

    async def script_ready():
        node = (await client.get(f"/projects/{pid}")).json()["board"]["aux"].get("script")
        return node if node and node.get("artifact_hash") else None

    await _wait_for(script_ready)
    await client.post(f"/projects/{pid}/script/enhance", json={"notes": "punchier"})
    await _wait_for(script_ready)

    # The board never echoes them: nothing reads them, and base_screenplay is
    # kilobytes on an endpoint the desktop polls through every render.
    board_params = (await client.get(f"/projects/{pid}")).json()["board"]["aux"]["script"]["params"]
    assert "feedback" not in board_params
    assert "base_screenplay" not in board_params

    # A template is structure, not history — and MAX_DOCUMENT_BYTES is not a
    # budget to spend on a copy of one project's screenplay.
    template = (await client.get(f"/projects/{pid}/template")).json()
    script_node = template["nodes"]["script"]
    assert "feedback" not in script_node["params"]
    assert "base_screenplay" not in script_node["params"]

    # And a plain regenerate is a new take of the prompt, not a replay.
    await client.post(f"/projects/{pid}/nodes/script/regenerate", json={})
    graph = (await client.get(f"/projects/{pid}/graph")).json()
    assert "feedback" not in graph["nodes"]["script"]["params"]
    assert "base_screenplay" not in graph["nodes"]["script"]["params"]


_PEAKS_FFMPEG = os.environ.get("LOCALCUT_FFMPEG_BIN") or shutil.which("ffmpeg")


@pytest.mark.skipif(_PEAKS_FFMPEG is None, reason="ffmpeg not installed")
async def test_artifact_peaks_serves_a_waveform_and_caches_it(tmp_path):
    """GET .../artifacts/{hash}/peaks: the audio-lane shape, computed
    engine-side (and cached) instead of every client decoding whole tracks
    through WebAudio."""
    config = EngineConfig(
        data_dir=tmp_path, token="test-token", backend="mock", ffmpeg_bin=_PEAKS_FFMPEG
    )
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
            created = await http.post("/projects", json={"prompt": "x"})
            pid = created.json()["id"]
            generated = tmp_path / "projects" / f"{pid}.lcut" / "generated"
            generated.mkdir(parents=True, exist_ok=True)

            voiced = "ab" * 32
            with wave.open(str(generated / f"{voiced}.wav"), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(22050)
                frames = bytearray()
                for i in range(22050):
                    value = int(20000 * math.sin(2 * math.pi * 220 * i / 22050))
                    frames += value.to_bytes(2, "little", signed=True)
                handle.writeframes(bytes(frames))

            response = await http.get(f"/projects/{pid}/artifacts/{voiced}/peaks?bins=64")
            assert response.status_code == 200
            body = response.json()
            assert body["bins"] == 64 and len(body["peaks"]) == 64
            assert abs(body["duration_s"] - 1.0) < 0.1
            assert max(body["peaks"]) > 0.3
            cache_file = tmp_path / "projects" / f"{pid}.lcut" / "cache" / f"peaks-{voiced}-64.json"
            assert cache_file.exists()

            missing = await http.get(f"/projects/{pid}/artifacts/{'cd' * 32}/peaks")
            assert missing.status_code == 404

            not_audio = "ef" * 32
            (generated / f"{not_audio}.txt").write_text("not audio", encoding="utf-8")
            refused = await http.get(f"/projects/{pid}/artifacts/{not_audio}/peaks")
            assert refused.status_code == 422


async def test_system_etas_calibrate_from_completed_jobs(client):
    """GET /system/etas: per-kind medians from this machine's own finished
    renders — empty until something has rendered, never a hand-written
    guess dressed up as data."""
    fresh = await client.get("/system/etas")
    assert fresh.status_code == 200
    assert fresh.json()["etas"] == {}

    created = await client.post("/projects", json={"prompt": "x"})
    assert created.status_code == 200
    async with asyncio.timeout(15):
        while True:
            etas = (await client.get("/system/etas")).json()["etas"]
            if "script" in etas:
                break
            await asyncio.sleep(0.05)
    script = etas["script"]["draft"]
    assert script["samples"] >= 1
    assert script["seconds"] >= 0


async def test_a_caller_that_may_not_spend_cannot_buy_a_cloud_edit(client):
    """The cloud-spend rule names an outcome, not a list of routes.

    `/edit` is the one spend that never reaches the queue: with a `model`, it
    calls the BYOK text provider inline on the request path, so the gate at
    `_enqueue_dirty` never sees it. The MCP surface omits `model` from its
    tool schema, but that is a client-side gate over a route -- the exact
    shape that leaked three times before the rule moved to the queue, and the
    reason a fourth client (or a hand-rolled HTTP call from an agent host)
    must not be the only thing standing in the way.

    A 403 BEFORE the provider is resolved, so no key is read and no request
    is made -- not a 400 about a missing key, which would leak whether one is
    configured and would still have spent it where one is.
    """
    created = await client.post("/projects", json={"prompt": "a quiet harbour"})
    project_id = created.json()["id"]

    response = await client.post(
        f"/projects/{project_id}/edit",
        json={"instruction": "make it colder", "model": "cloud:claude-sonnet-4-5", "dry_run": True},
        headers={"X-LocalCut-Cloud-Spend": "deny"},
    )

    assert response.status_code == 403
    assert "provider key" in response.json()["detail"]

    # The local path is untouched: refusing the spend must not refuse editing.
    # Asserted as "not a spend refusal" rather than on a status code, because
    # what the local model does here depends on the machine -- 200 where an
    # Ollama is running, 502 where there is none. Both mean it got past this
    # gate and reached the model, which is the whole claim.
    allowed = await client.post(
        f"/projects/{project_id}/edit",
        json={"instruction": "make it colder", "dry_run": True},
        headers={"X-LocalCut-Cloud-Spend": "deny"},
    )
    assert allowed.status_code != 403
    assert "provider key" not in allowed.text


async def test_the_board_says_whether_the_cut_burns_any_titles(client):
    """The desktop cannot otherwise know: overlays live on the timeline
    node's params, and the board sends node STATUS, not params. Without
    this, a machine whose ffmpeg lacks drawtext gets no warning until the
    export dies - after the whole ladder has re-rendered at final quality."""
    pid = (await client.post("/projects", json={"prompt": "a tour"})).json()["id"]

    async def board() -> dict:
        return (await client.get(f"/projects/{pid}")).json()["board"]

    # Overlays only exist once the screenplay has expanded into a graph.
    async with asyncio.timeout(15):
        while not (await board())["scenes"]:
            await asyncio.sleep(0.05)

    # The mock screenplay gives its first scene an on-screen title.
    assert (await board())["has_onscreen_text"] is True

    timeline = (await client.get(f"/projects/{pid}/graph")).json()["nodes"]["timeline"]
    assert timeline["params"]["overlays"], "fixture no longer has an overlay to detect"

    cleared = await client.post(
        f"/projects/{pid}/patch",
        json={"ops": [{"op": "set_params", "node_id": "timeline", "params": {"overlays": {}}}]},
    )
    assert cleared.status_code == 200
    assert (await board())["has_onscreen_text"] is False


async def test_voices_answers_the_same_shape_with_no_pack_installed(client):
    """GET /voices under the test chain, which registers no Kokoro backend.

    The empty answer is a list, not a 404 or an error: a machine that has not
    downloaded the weights is the normal first-run state, and a picker should
    render "none installed" from the same shape it renders a list from rather
    than special-casing a failure.
    """
    response = await client.get("/voices")
    assert response.status_code == 200
    body = response.json()
    assert body["voices"] == []
    # No default is offered for a pack that is not there — naming one would
    # invite a caller to send a voice the engine cannot synthesize.
    assert body["default"] is None


async def test_voices_needs_the_token(client):
    """Read-only, but still behind the bearer: every route on this engine is,
    and an exception would be the one a scanner finds."""
    response = await client.get("/voices", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401
