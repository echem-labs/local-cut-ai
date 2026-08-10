"""Reading an image with a cloud text model.

The engine could write about a video but never look at one frame of it. This
is the seam that changes that: the same BYOK adapters that already serve
`complete()` gain a `describe()` that carries an image alongside the prompt.

Exercised at the seam, like the rest of `test_providers.py` — no real API
calls. What is worth pinning is the shape each provider expects (they
disagree), that an adapter with no vision refuses rather than quietly
dropping the picture and answering from the text alone, and that the image
is labelled with its real type.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from localcut_engine.providers.base import Capability, TextGen
from localcut_engine.providers.images import data_url
from localcut_engine.providers.registry import PROVIDERS
from localcut_engine.providers.textgen import (
    AnthropicTextGen,
    OpenAICompatTextGen,
    ProviderError,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"pixels"


class _Capture:
    """Stands in for the network, keeping whatever body was posted."""

    def __init__(self, response: dict, status: int = 200) -> None:
        self.response = response
        self.status = status
        self.body: dict = {}
        self.headers: dict = {}

    def install(self, monkeypatch) -> None:
        capture = self

        async def post(self_client, url, headers=None, json=None, **kwargs):  # noqa: A002
            capture.body = json or {}
            capture.headers = headers or {}
            return httpx.Response(capture.status, json=capture.response)

        monkeypatch.setattr(httpx.AsyncClient, "post", post)


def test_a_data_url_names_the_images_real_type(tmp_path):
    # A user's asset may be .jpg or .webp; the keyframe port accepts all of
    # them. Declaring every conditioning image as png mislabels the payload.
    jpg = tmp_path / "shot.jpg"
    jpg.write_bytes(PNG)

    url = data_url(jpg)

    assert url.startswith("data:image/jpeg;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == PNG


def test_an_unknown_suffix_does_not_claim_to_be_an_image(tmp_path):
    odd = tmp_path / "shot.bin"
    odd.write_bytes(PNG)

    assert data_url(odd).startswith("data:application/octet-stream;base64,")


async def test_anthropic_sends_the_image_as_a_content_block(monkeypatch, tmp_path):
    image = tmp_path / "shot.png"
    image.write_bytes(PNG)
    capture = _Capture({"content": [{"type": "text", "text": "a lighthouse"}]})
    capture.install(monkeypatch)

    text = await AnthropicTextGen("k", "claude-sonnet-5").describe(
        system="s", prompt="p", image=image
    )

    assert text == "a lighthouse"
    content = capture.body["messages"][0]["content"]
    kinds = [part["type"] for part in content]
    assert kinds == ["image", "text"], content
    assert content[0]["source"]["media_type"] == "image/png"
    assert base64.b64decode(content[0]["source"]["data"]) == PNG


async def test_openai_sends_the_image_as_a_data_url_part(monkeypatch, tmp_path):
    # The other shape entirely: OpenAI and Gemini take an `image_url` part
    # carrying a data URI, not Anthropic's base64 source block.
    image = tmp_path / "shot.png"
    image.write_bytes(PNG)
    capture = _Capture({"choices": [{"message": {"content": "a lighthouse"}}]})
    capture.install(monkeypatch)

    text = await OpenAICompatTextGen("k", "gpt-5", "https://api.openai.com/v1", "OpenAI").describe(
        system="s", prompt="p", image=image
    )

    assert text == "a lighthouse"
    content = capture.body["messages"][-1]["content"]
    assert [part["type"] for part in content] == ["image_url", "text"]
    assert content[0]["image_url"]["url"].startswith("data:image/png;base64,")


async def test_an_adapter_without_vision_refuses_rather_than_ignoring_the_image(tmp_path):
    # The project rule is never to substitute silently: a caller who asked a
    # model to look at a picture must not receive an answer written without
    # it. `TextGen` therefore defaults to refusing, and only the adapters
    # that genuinely carry an image override it.
    class TextOnly(TextGen):
        async def complete(self, system, prompt, max_tokens=4096):
            return "written blind"

        def quote(self, prompt_chars):  # pragma: no cover - not the subject
            raise NotImplementedError

    image = tmp_path / "shot.png"
    image.write_bytes(PNG)

    with pytest.raises(ProviderError, match="no vision"):
        await TextOnly().describe(system="s", prompt="p", image=image)


async def test_a_refusal_from_the_provider_is_a_provider_error(monkeypatch, tmp_path):
    image = tmp_path / "shot.png"
    image.write_bytes(PNG)
    capture = _Capture({"error": "no"}, status=400)
    capture.install(monkeypatch)

    with pytest.raises(ProviderError):
        await AnthropicTextGen("k", "claude-sonnet-5").describe(
            system="s", prompt="p", image=image
        )


def test_the_text_providers_declare_vision():
    # Settings renders each provider's capabilities straight from this list,
    # so a provider that can read an image has to say so here or the pane
    # goes on describing it as text-only.
    by_id = {p.id: p for p in PROVIDERS}

    for provider in ("anthropic", "openai", "google"):
        assert Capability.VISION in by_id[provider].capabilities, provider
    assert Capability.VISION not in by_id["fal"].capabilities
