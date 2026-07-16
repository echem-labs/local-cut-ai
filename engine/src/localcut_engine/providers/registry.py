"""Provider registry — adapters register their info + factory; keys come
from the OS keychain via the UI (BYOK) or the credit proxy (Pro)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .base import Capability, ProviderInfo


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, tuple[ProviderInfo, Callable[..., Any]]] = {}

    def register(self, info: ProviderInfo, factory: Callable[..., Any]) -> None:
        self._providers[info.id] = (info, factory)

    def infos(self) -> list[ProviderInfo]:
        return [info for info, _ in self._providers.values()]

    def create(self, provider_id: str, **kwargs: Any) -> Any:
        info, factory = self._providers[provider_id]
        return factory(**kwargs)

    def for_capability(self, capability: Capability) -> list[ProviderInfo]:
        return [info for info, _ in self._providers.values() if capability in info.capabilities]


def default_registry() -> ProviderRegistry:
    from . import anthropic, fal

    registry = ProviderRegistry()
    registry.register(anthropic.INFO, anthropic.AnthropicTextGen)
    registry.register(fal.INFO, fal.FalVideoGen)
    return registry
