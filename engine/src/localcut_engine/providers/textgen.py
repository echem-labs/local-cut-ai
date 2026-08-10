"""Cloud TextGen adapters — BYOK, called directly from this machine.

Anthropic speaks its native Messages API; OpenAI and Gemini share the
OpenAI-compatible chat shape behind different base URLs.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

import httpx

from .base import PriceQuote, ProviderError, TextGen
from .images import data_url, mime_type

# Re-exported: `ProviderError` was defined here before the capability
# interfaces needed to raise it, and half the engine imports it from this
# module.
__all__ = [
    "AnthropicTextGen",
    "OpenAICompatTextGen",
    "ProviderError",
    "TruncatedCompletion",
]

_TIMEOUT_S = 120


class TruncatedCompletion(ProviderError):
    """The model hit its output cap mid-answer. Distinct because the caller
    can act on it (raise the cap, ask for fewer scenes) and because the
    generic parse error it otherwise surfaces as blames the model for
    "invalid JSON" when the JSON was merely cut off."""


def _truncation_error(label: str, cap: int) -> TruncatedCompletion:
    return TruncatedCompletion(
        f"{label} stopped at the {cap}-token output cap before finishing — "
        "the response is incomplete. Try a shorter target duration, or a model "
        "with a larger output limit."
    )


class AnthropicTextGen(TextGen):
    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def complete(self, system: str, prompt: str, max_tokens: int = 4096) -> str:
        return await self._messages(system, prompt, max_tokens)

    async def describe(self, system: str, prompt: str, image: Path, max_tokens: int = 4096) -> str:
        # Anthropic takes the picture as a base64 `source` block, and takes it
        # BEFORE the text: the vendor's guidance is that an image placed after
        # the question is attended to less.
        return await self._messages(
            system,
            [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime_type(image),
                        "data": base64.b64encode(image.read_bytes()).decode(),
                    },
                },
                {"type": "text", "text": prompt},
            ],
            max_tokens,
        )

    async def _messages(self, system: str, content: str | list, max_tokens: int) -> str:
        """One request shape for both. `content` is a bare string for text and
        a list of blocks when a picture rides along — the API takes either."""
        try:
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
                        "messages": [{"role": "user", "content": content}],
                    },
                )
        except httpx.HTTPError as exc:
            raise ProviderError(f"anthropic request failed: {exc}") from exc
        if response.status_code != 200:
            raise ProviderError(f"anthropic: {response.text[:300]}")
        # A 200 with an unexpected body must still fail as a provider error,
        # not a raw KeyError the caller can't classify.
        try:
            body = response.json()
            blocks = body.get("content", [])
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        except (ValueError, AttributeError, TypeError) as exc:
            raise ProviderError(f"anthropic returned an unreadable body: {exc}") from exc
        # Truncation is an HTTP 200. Without this check a long screenplay
        # comes back cut off, fails JSON parsing, and reports as the model
        # emitting invalid JSON — after the tokens are already paid for.
        if body.get("stop_reason") == "max_tokens":
            raise _truncation_error("anthropic", max_tokens)
        return text

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
        return await self._chat(system, prompt, max_tokens)

    async def describe(self, system: str, prompt: str, image: Path, max_tokens: int = 4096) -> str:
        # The other shape entirely: a parts list carrying a data URI, rather
        # than Anthropic's base64 source block. Image first for the same
        # reason.
        return await self._chat(
            system,
            [
                {"type": "image_url", "image_url": {"url": data_url(image)}},
                {"type": "text", "text": prompt},
            ],
            max_tokens,
        )

    async def _chat(self, system: str, content: str | list, max_tokens: int) -> str:
        # OpenAI's reasoning models (o1/o3/o4/…, gpt-5) reject `max_tokens` and
        # require `max_completion_tokens`; classic chat models still take
        # `max_tokens`. Pick the right key by model name.
        model = self.model.split("/")[-1]
        reasoning = bool(re.match(r"^(o\d|gpt-5)", model))
        token_key = "max_completion_tokens" if reasoning else "max_tokens"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        token_key: max_tokens,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": content},
                        ],
                    },
                )
        except httpx.HTTPError as exc:
            raise ProviderError(f"{self.label} request failed: {exc}") from exc
        if response.status_code != 200:
            raise ProviderError(f"{self.label}: {response.text[:300]}")
        try:
            choice = response.json()["choices"][0]
            text = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"{self.label} returned an unreadable body: {exc}") from exc
        # "length" is OpenAI's truncation signal, and it arrives on a 200 —
        # the parse failure downstream would otherwise blame the model for
        # invalid JSON when the JSON was merely cut off.
        if choice.get("finish_reason") == "length":
            raise _truncation_error(self.label, max_tokens)
        return text

    def quote(self, prompt_chars: int) -> PriceQuote:
        return PriceQuote(estimate=0.02, unit="per request", detail=self.model)
