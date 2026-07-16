"""Cloud provider layer — one capability interface, many adapters.

Cloud models plug into the same Story Graph nodes as local ones; a Clip
node's provider param can be `local:wan2.2` or `cloud:veo-3.1-fast`.
Every adapter declares pricing metadata so cost is shown *before*
generating — no surprise bills. BYOK calls go direct from this machine;
the Pro credit proxy is the same adapter with a different base URL.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import StrEnum

from pydantic import BaseModel


class Capability(StrEnum):
    TEXT = "text"  # script writing, graph patches, metadata
    IMAGE = "image"  # keyframes, thumbnails
    VIDEO = "video"  # clips (T2V / I2V)
    SPEECH = "speech"  # TTS / voice cloning
    MUSIC = "music"
    TRANSCRIBE = "transcribe"


class PriceQuote(BaseModel):
    currency: str = "USD"
    estimate: float
    unit: str  # e.g. "per request", "per second of video"
    detail: str = ""


class ProviderInfo(BaseModel):
    id: str
    label: str
    capabilities: list[Capability]
    requires_key: bool = True
    content_policy_url: str = ""


class TextGen(ABC):
    @abstractmethod
    async def complete(self, system: str, prompt: str, max_tokens: int = 4096) -> str: ...

    @abstractmethod
    def quote(self, prompt_chars: int) -> PriceQuote: ...


class VideoGen(ABC):
    @abstractmethod
    async def generate(
        self, prompt: str, duration_s: float, image_path: str | None = None
    ) -> bytes: ...

    @abstractmethod
    def quote(self, duration_s: float) -> PriceQuote: ...
