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
    # Kinds the cloud backend can't serve fall back to the chain.
    assert registry.resolve(NodeKind.SCRIPT, None) is local
