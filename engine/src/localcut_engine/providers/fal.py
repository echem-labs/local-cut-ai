"""fal.ai aggregator adapter — one integration, huge model surface
(integrate an aggregator first; direct integrations later where
margins/features justify).
"""

from __future__ import annotations

import asyncio

import httpx

from .base import Capability, PriceQuote, ProviderInfo, VideoGen

INFO = ProviderInfo(
    id="fal",
    label="fal.ai (Kling, Veo, Wan-cloud, …)",
    capabilities=[Capability.VIDEO, Capability.IMAGE],
)

# Pricing metadata surfaced pre-spend (mid-2026 rates).
PER_SECOND_USD = {
    "fal-ai/kling-video/v3/standard": 0.10,
    "fal-ai/veo-3.1-fast": 0.15,
    "fal-ai/wan/v2.2": 0.05,
}


class FalVideoGen(VideoGen):
    def __init__(
        self,
        api_key: str,
        model: str = "fal-ai/kling-video/v3/standard",
        base_url: str = "https://queue.fal.run",
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    async def generate(
        self, prompt: str, duration_s: float, image_path: str | None = None
    ) -> bytes:
        headers = {"Authorization": f"Key {self.api_key}"}
        payload: dict = {"prompt": prompt, "duration": duration_s}
        async with httpx.AsyncClient(timeout=60) as client:
            submit = await client.post(
                f"{self.base_url}/{self.model}", headers=headers, json=payload
            )
            submit.raise_for_status()
            status_url = submit.json()["status_url"]
            response_url = submit.json()["response_url"]

            while True:
                status = (await client.get(status_url, headers=headers)).json()
                if status["status"] == "COMPLETED":
                    break
                if status["status"] in ("FAILED", "CANCELLED"):
                    raise RuntimeError(f"fal.ai job {status['status']}: {status}")
                await asyncio.sleep(2)

            result = (await client.get(response_url, headers=headers)).json()
            video_url = result["video"]["url"]
            media = await client.get(video_url)
            media.raise_for_status()
            return media.content

    def quote(self, duration_s: float) -> PriceQuote:
        rate = PER_SECOND_USD.get(self.model, 0.15)
        return PriceQuote(
            estimate=round(rate * duration_s, 2),
            unit="per second of video",
            detail=f"{self.model} @ ${rate:.2f}/s",
        )
