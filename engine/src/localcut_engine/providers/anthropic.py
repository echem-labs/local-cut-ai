"""Anthropic adapter — the "brain" tier: script generation and
prompt-based project editing (LLM graph patches). BYOK: the key never
leaves this machine except in direct calls to the Anthropic API.
"""

from __future__ import annotations

import httpx

from .base import Capability, PriceQuote, ProviderInfo, TextGen

INFO = ProviderInfo(
    id="anthropic",
    label="Anthropic Claude",
    capabilities=[Capability.TEXT],
)


class AnthropicTextGen(TextGen):
    def __init__(
        self,
        api_key: str,
        model: str = "claude-sonnet-5",
        base_url: str = "https://api.anthropic.com",
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    async def complete(self, system: str, prompt: str, max_tokens: int = 4096) -> str:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{self.base_url}/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": self.model,
                    "max_tokens": max_tokens,
                    "system": system,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            response.raise_for_status()
            data = response.json()
            return "".join(
                block["text"] for block in data["content"] if block["type"] == "text"
            )

    def quote(self, prompt_chars: int) -> PriceQuote:
        # Rough order-of-magnitude estimate for the pre-spend cost badge;
        # itemized real usage comes from the API response afterwards.
        approx_tokens = prompt_chars / 4 + 2000
        return PriceQuote(
            estimate=round(approx_tokens / 1e6 * 18, 4),
            unit="per request",
            detail=f"{self.model}, ~{int(approx_tokens)} tokens",
        )
