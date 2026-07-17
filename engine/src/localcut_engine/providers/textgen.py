"""Cloud TextGen adapters — BYOK, called directly from this machine.

Anthropic speaks its native Messages API; OpenAI and Gemini share the
OpenAI-compatible chat shape behind different base URLs.
"""

from __future__ import annotations

import httpx

from .base import PriceQuote, TextGen

_TIMEOUT_S = 120


class ProviderError(RuntimeError):
    pass


class AnthropicTextGen(TextGen):
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def complete(self, system: str, prompt: str, max_tokens: int = 4096) -> str:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(
                "https://api.anthropic.com/v1/messages",
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
        if response.status_code != 200:
            raise ProviderError(f"anthropic: {response.text[:300]}")
        blocks = response.json().get("content", [])
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")

    def quote(self, prompt_chars: int) -> PriceQuote:
        return PriceQuote(estimate=0.03, unit="per request", detail=self.model)


class OpenAICompatTextGen(TextGen):
    """OpenAI and Gemini both serve /chat/completions."""

    def __init__(self, api_key: str, model: str, base_url: str, label: str) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.label = label

    async def complete(self, system: str, prompt: str, max_tokens: int = 4096) -> str:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "max_tokens": max_tokens,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
        if response.status_code != 200:
            raise ProviderError(f"{self.label}: {response.text[:300]}")
        return response.json()["choices"][0]["message"]["content"]

    def quote(self, prompt_chars: int) -> PriceQuote:
        return PriceQuote(estimate=0.02, unit="per request", detail=self.model)
