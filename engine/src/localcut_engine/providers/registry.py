"""Model-name → provider routing for `cloud:*` node models.

A node asks for `cloud:claude-sonnet-5` or `cloud:kling-2.5`; the prefix
decides which BYOK adapter serves it. Keys come from the engine config
(env / OS keychain via the desktop shell) and are never persisted here.
"""

from __future__ import annotations

from ..config import EngineConfig
from .base import Capability, ProviderInfo, TextGen, VideoGen
from .textgen import AnthropicTextGen, OpenAICompatTextGen, ProviderError
from .video import FAL_MODELS, FalVideoGen

_OPENAI_BASE = "https://api.openai.com/v1"
_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"

PROVIDERS = [
    ProviderInfo(
        id="anthropic",
        label="Anthropic Claude",
        capabilities=[Capability.TEXT, Capability.VISION],
    ),
    ProviderInfo(
        id="openai",
        label="OpenAI",
        capabilities=[Capability.TEXT, Capability.VISION],
    ),
    ProviderInfo(
        id="google",
        label="Google Gemini",
        capabilities=[Capability.TEXT, Capability.VISION],
    ),
    ProviderInfo(id="fal", label="fal.ai (video aggregator)", capabilities=[Capability.VIDEO]),
]


def provider_for_model(model: str) -> str:
    """`cloud:` model name → provider id, by family prefix."""
    name = model.removeprefix("cloud:")
    if name.startswith("claude"):
        return "anthropic"
    if name.startswith(("gpt", "o1", "o3", "o4")):
        return "openai"
    if name.startswith("gemini"):
        return "google"
    if name in FAL_MODELS:
        return "fal"
    raise ProviderError(f"no provider routes cloud model {model!r}")


def _key_for(config: EngineConfig, provider: str) -> str:
    key = {
        "anthropic": config.anthropic_key,
        "openai": config.openai_key,
        "google": config.gemini_key,
        "fal": config.fal_key,
    }.get(provider)
    if not key:
        env = {"google": "LOCALCUT_GEMINI_KEY"}.get(provider, f"LOCALCUT_{provider.upper()}_KEY")
        raise ProviderError(
            f"{provider} API key not configured — set {env} (BYOK, stored in your OS keychain)"
        )
    return key


# The model each provider is asked to read a picture with, when the caller
# has not named one. Here rather than in the desktop for the same reason
# FAL_MODELS is: model names drift, and a renderer that hardcodes one ships
# a dead string to everyone until the next release.
VISION_MODELS = {
    "anthropic": "cloud:claude-sonnet-5",
    "openai": "cloud:gpt-5",
    "google": "cloud:gemini-2.5-flash",
}


def default_vision_model(config: EngineConfig) -> str:
    """A vision model the user has actually paid for, or a refusal naming
    what is missing.

    Ordered, not arbitrary: whichever provider is configured first in
    `PROVIDERS` wins, so the answer is stable across restarts rather than
    depending on dict ordering the user cannot see.
    """
    for info in PROVIDERS:
        model = VISION_MODELS.get(info.id)
        if model is None or Capability.VISION not in info.capabilities:
            continue
        try:
            _key_for(config, info.id)
        except ProviderError:
            continue
        return model
    raise ProviderError(
        "reading an image needs a cloud provider key — add one for Anthropic, "
        "OpenAI or Gemini in Settings"
    )


def configured_providers(config: EngineConfig) -> list[dict]:
    """Provider slate + whether a key is present, for the settings UI."""
    keys = {
        "anthropic": config.anthropic_key,
        "openai": config.openai_key,
        "google": config.gemini_key,
        "fal": config.fal_key,
    }
    return [{**info.model_dump(), "configured": bool(keys.get(info.id))} for info in PROVIDERS]


def textgen_for_model(config: EngineConfig, model: str) -> TextGen:
    name = model.removeprefix("cloud:")
    provider = provider_for_model(model)
    key = _key_for(config, provider)
    match provider:
        case "anthropic":
            return AnthropicTextGen(api_key=key, model=name)
        case "openai":
            return OpenAICompatTextGen(
                api_key=key, model=name, base_url=_OPENAI_BASE, label="openai"
            )
        case "google":
            return OpenAICompatTextGen(
                api_key=key, model=name, base_url=_GEMINI_BASE, label="gemini"
            )
    raise ProviderError(f"{provider} serves no text capability")


def videogen_for_model(config: EngineConfig, model: str) -> VideoGen:
    name = model.removeprefix("cloud:")
    provider = provider_for_model(model)
    if provider != "fal":
        raise ProviderError(f"{provider} serves no video capability")
    return FalVideoGen(api_key=_key_for(config, provider), model=name)
