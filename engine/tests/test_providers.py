"""BYOK cloud routing: model-prefix dispatch, key errors, and the registry's
cloud override. No real API calls — adapters are exercised at the seam."""

import pytest

from localcut_engine.backends.base import BackendRegistry, ExecutionBackend
from localcut_engine.config import EngineConfig
from localcut_engine.graph.model import NodeKind
from localcut_engine.providers.registry import (
    configured_providers,
    provider_for_model,
    textgen_for_model,
    videogen_for_model,
)
from localcut_engine.providers.textgen import AnthropicTextGen, OpenAICompatTextGen, ProviderError
from localcut_engine.providers.video import FalVideoGen


def test_model_prefixes_route_to_providers():
    assert provider_for_model("cloud:claude-sonnet-5") == "anthropic"
    assert provider_for_model("cloud:gpt-5.2") == "openai"
    assert provider_for_model("cloud:gemini-3-pro") == "google"
    assert provider_for_model("cloud:kling-2.5") == "fal"
    with pytest.raises(ProviderError, match="no provider routes"):
        provider_for_model("cloud:sora-2")


def test_missing_key_names_the_env_var():
    config = EngineConfig()
    with pytest.raises(ProviderError, match="LOCALCUT_ANTHROPIC_KEY"):
        textgen_for_model(config, "cloud:claude-sonnet-5")
    with pytest.raises(ProviderError, match="LOCALCUT_GEMINI_KEY"):
        textgen_for_model(config, "cloud:gemini-3-pro")
    with pytest.raises(ProviderError, match="LOCALCUT_FAL_KEY"):
        videogen_for_model(config, "cloud:kling-2.5")


def test_configured_adapters_and_quotes():
    config = EngineConfig(anthropic_key="k1", openai_key="k2", fal_key="k3")
    assert isinstance(textgen_for_model(config, "cloud:claude-sonnet-5"), AnthropicTextGen)
    assert isinstance(textgen_for_model(config, "cloud:gpt-5.2"), OpenAICompatTextGen)
    video = videogen_for_model(config, "cloud:veo-3.1-fast")
    assert isinstance(video, FalVideoGen)
    quote = video.quote(6.0)
    assert quote.estimate == pytest.approx(0.15 * 6)  # price shown before spend

    status = {p["id"]: p["configured"] for p in configured_providers(config)}
    assert status == {"anthropic": True, "openai": True, "google": False, "fal": True}


def test_cloud_artifacts_stay_trusted_across_recompiles(tmp_path):
    """Cache distrust must resolve with the job's model: a cloud-rendered
    artifact would otherwise mismatch the local chain backend and be
    re-enqueued (re-billed) on every compile, forever."""
    from localcut_engine.events import EventBus
    from localcut_engine.graph.compiler import JobSpec
    from localcut_engine.jobs.models import Job, JobStatus
    from localcut_engine.jobs.queue import JobQueue
    from localcut_engine.project.store import ProjectStore
    from localcut_engine.service import ProjectService

    class Local(ExecutionBackend):
        name = "local-stub"

        def supports(self, kind):
            return kind is NodeKind.SCRIPT

        async def execute(self, spec, ctx):
            raise NotImplementedError

    class Cloud(Local):
        name = "cloud-stub"

    registry = BackendRegistry()
    registry.register(Local())
    registry.register_cloud(Cloud())
    service = ProjectService(
        ProjectStore(tmp_path / "p"),
        JobQueue(tmp_path / "q.db"),
        EventBus(),
        backends=registry,
    )

    def done_job(output_hash, model, backend):
        job = Job(
            project_id="x",
            spec=JobSpec(
                node_id="script",
                kind=NodeKind.SCRIPT,
                output_hash=output_hash,
                params={},
                model=model,
                seed=0,
                input_hashes={},
            ),
        )
        job.status = JobStatus.DONE
        job.backend = backend
        return job

    cloud_job = done_job("a" * 64, "cloud:claude-sonnet-5", "cloud-stub")
    stale_job = done_job("b" * 64, None, "someone-else")
    cached = {"a" * 64, "b" * 64}
    distrusted = service._distrusted_hashes([cloud_job, stale_job], cached)
    assert "a" * 64 not in distrusted  # cloud output is what would render today
    assert "b" * 64 in distrusted  # a foreign backend's output is not


async def test_cloud_metadata_task_produces_publish_kit(tmp_path, monkeypatch):
    """A publish-kit node routed to a cloud model must honor the metadata
    contract, not re-run the screenplay prompt."""
    import json

    from conftest import make_spec

    from localcut_engine.backends import cloud as cloud_module
    from localcut_engine.backends.base import ExecutionContext

    class StubTextGen:
        async def complete(self, system, prompt, max_tokens=4096):
            assert "publish" in system.lower()  # metadata prompt, not screenwriter
            return '{"title": "T", "description": "D", "hashtags": ["#a", "b"]}'

    monkeypatch.setattr(cloud_module, "textgen_for_model", lambda config, model: StubTextGen())
    backend = cloud_module.CloudBackend(EngineConfig())
    spec = make_spec(
        NodeKind.SCRIPT,
        {"task": "metadata", "prompt": "summary text"},
        model="cloud:claude-sonnet-5",
    )
    out = await backend.execute(spec, ExecutionContext(output_dir=tmp_path))
    assert out.name.endswith(".metadata.json")
    kit = json.loads(out.read_text())
    assert kit == {"title": "T", "description": "D", "hashtags": ["a", "b"]}


def test_registry_cloud_override_is_model_driven(tmp_path):
    class Local(ExecutionBackend):
        name = "local-stub"

        def supports(self, kind):
            return kind is NodeKind.SCRIPT

        async def execute(self, spec, ctx):
            raise NotImplementedError

    class Cloud(Local):
        name = "cloud-stub"

    registry = BackendRegistry()
    local, cloud = Local(), Cloud()
    registry.register(local)
    registry.register_cloud(cloud)

    assert registry.resolve(NodeKind.SCRIPT) is local
    assert registry.resolve(NodeKind.SCRIPT, "local:qwen") is local
    assert registry.resolve(NodeKind.SCRIPT, "cloud:claude-sonnet-5") is cloud
    # A model-less request for a kind the cloud backend can't serve falls back
    # to the chain.
    assert registry.resolve(NodeKind.SCRIPT, None) is local


def test_cloud_model_never_falls_back_to_local():
    """A cloud:* model on a kind the cloud backend can't serve must raise, not
    silently render on a local backend and hand back local output the user
    believes came from the cloud."""
    from localcut_engine.backends.base import GenerationError

    class Local(ExecutionBackend):
        name = "local"

        def supports(self, kind):
            return kind is NodeKind.KEYFRAME

        async def execute(self, spec, ctx):
            raise NotImplementedError

    class CloudScriptOnly(ExecutionBackend):
        name = "cloud"

        def supports(self, kind):
            return kind is NodeKind.SCRIPT

        async def execute(self, spec, ctx):
            raise NotImplementedError

    registry = BackendRegistry()
    registry.register(Local())
    registry.register_cloud(CloudScriptOnly())
    with pytest.raises(GenerationError, match="not available"):
        registry.resolve(NodeKind.KEYFRAME, "cloud:midjourney")
    # A local model on the same kind still resolves to the local backend.
    assert registry.resolve(NodeKind.KEYFRAME, "local:sdxl").name == "local"


async def test_a_conditioning_image_is_labelled_with_its_real_type(tmp_path, monkeypatch):
    """The keyframe port also accepts a USER asset, and upload_asset stores
    .jpg/.jpeg/.webp under that suffix. Every conditioning image went out as
    `data:image/png` regardless, so a scene the user conditioned on their own
    photo submitted a payload whose declared type contradicted its bytes."""
    import base64

    import httpx

    from localcut_engine.providers.images import IMAGE_MIME_TYPES as _IMAGE_MIME_TYPES

    sent: list[dict] = []

    class _Rejected:
        status_code = 500
        text = "stop before the poll loop"

    async def capture(self, url, headers=None, json=None):
        sent.append(json["input"])
        return _Rejected()

    monkeypatch.setattr(httpx.AsyncClient, "post", capture)
    gen = FalVideoGen("k", "kling-2.5")

    for suffix, expected in sorted(_IMAGE_MIME_TYPES.items()):
        image = tmp_path / f"frame{suffix}"
        image.write_bytes(b"\x89PNG\r\n")
        with pytest.raises(ProviderError):
            await gen.generate("p", 4.0, str(image))
        payload = sent[-1]["image_url"]
        assert payload.startswith(f"data:{expected};base64,"), payload
        # The bytes are unchanged — only the label was ever wrong.
        assert payload.endswith(base64.b64encode(b"\x89PNG\r\n").decode())


async def test_encoding_the_conditioning_image_does_not_block_the_event_loop(tmp_path, monkeypatch):
    """A keyframe reaching fal may be a user asset of up to `_ASSET_MAX_BYTES`,
    and encoding one inline stalls the loop for the whole read - during which
    no other request advances and no progress frame reaches the `/ws` fan-out.

    Asserted by watching the loop rather than by inspecting the call: a ticker
    that keeps counting between the call and the submit is the property that
    matters, and it stays true however the offload is spelled.
    """
    import asyncio

    import httpx

    big = tmp_path / "big.png"
    big.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (8 << 20))

    ticks = 0
    ticks_at_submit = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0)

    class _Rejected:
        status_code = 500
        text = "stop before the poll loop"

    async def capture(self, url, headers=None, json=None):
        nonlocal ticks_at_submit
        ticks_at_submit = ticks
        return _Rejected()

    monkeypatch.setattr(httpx.AsyncClient, "post", capture)
    gen = FalVideoGen("k", "kling-2.5")

    beat = asyncio.create_task(ticker())
    await asyncio.sleep(0)
    before = ticks
    with pytest.raises(ProviderError):
        await gen.generate("p", 4.0, str(big))
    beat.cancel()

    assert ticks_at_submit > before, "the loop stopped while the image was being encoded"


def test_the_mime_table_covers_every_image_asset_the_api_accepts():
    """A contract, like test_ui_contract's: adding an extension to
    _IMAGE_EXTENSIONS without adding it here would silently ship
    `application/octet-stream` to fal and fail with an opaque provider error
    rather than at the seam that knows why."""
    import re
    from pathlib import Path as _Path

    from localcut_engine.providers.images import IMAGE_MIME_TYPES as _IMAGE_MIME_TYPES

    # Read as source: the set is a local inside create_app, so there is
    # nothing to import — same approach test_ui_contract takes to types.ts.
    app_py = _Path(__file__).parent.parent / "src" / "localcut_engine" / "api" / "app.py"
    assert app_py.is_file(), app_py
    literal = re.search(r"_IMAGE_EXTENSIONS = \{([^}]*)\}", app_py.read_text(encoding="utf-8"))
    assert literal, "app.py no longer declares _IMAGE_EXTENSIONS"
    accepted = set(re.findall(r'"([^"]+)"', literal.group(1)))
    assert accepted, "the extension set parsed empty — the test would pass on nothing"
    assert accepted <= set(_IMAGE_MIME_TYPES), (
        f"no mime type for uploadable image assets: {sorted(accepted - set(_IMAGE_MIME_TYPES))}"
    )
