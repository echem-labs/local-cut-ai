"""Cloud VideoGen via the fal.ai aggregator — one adapter, many models
(Kling, Veo, Wan-cloud). Queue-based: submit, poll with a hard deadline,
download the result. The deadline exists because this runs inside the
GPU-serial scheduler's single job slot.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path

import httpx

from .base import PriceQuote, VideoGen
from .textgen import ProviderError

_QUEUE_BASE = "https://queue.fal.run"
_POLL_INTERVAL_S = 3.0
_DEADLINE_S = 900.0

# model name (the part after "cloud:") → fal endpoint path + $/second.
# Aggregator paths drift; this table is refreshed with the model manifest.
FAL_MODELS: dict[str, tuple[str, float]] = {
    "kling-2.5": ("fal-ai/kling-video/v2.5-turbo/pro/image-to-video", 0.10),
    "veo-3.1-fast": ("fal-ai/veo3/fast/image-to-video", 0.15),
    "wan-2.2-cloud": ("fal-ai/wan-i2v", 0.05),
}


class FalVideoGen(VideoGen):
    def __init__(self, api_key: str, model: str, deadline_s: float = _DEADLINE_S) -> None:
        if model not in FAL_MODELS:
            raise ProviderError(
                f"unknown cloud video model {model!r} — one of: {', '.join(FAL_MODELS)}"
            )
        self.api_key = api_key
        self.model = model
        self.path, self.rate = FAL_MODELS[model]
        self.deadline_s = deadline_s

    async def generate(
        self, prompt: str, duration_s: float, image_path: str | None = None
    ) -> bytes:
        payload: dict = {"prompt": prompt, "duration": round(duration_s)}
        if image_path:
            data = base64.b64encode(Path(image_path).read_bytes()).decode()
            payload["image_url"] = f"data:image/png;base64,{data}"

        headers = {"Authorization": f"Key {self.api_key}"}
        async with httpx.AsyncClient(timeout=60) as client:
            submit = await client.post(
                f"{_QUEUE_BASE}/{self.path}", headers=headers, json={"input": payload}
            )
            if submit.status_code not in (200, 201):
                raise ProviderError(f"fal submit: {submit.text[:300]}")
            job = submit.json()
            status_url = job["status_url"]
            response_url = job["response_url"]

            deadline = asyncio.get_running_loop().time() + self.deadline_s
            while True:
                status = (await client.get(status_url, headers=headers)).json()
                state = status.get("status")
                if state == "COMPLETED":
                    break
                if state in ("FAILED", "CANCELLED"):
                    raise ProviderError(f"fal job {state.lower()}: {status}")
                if asyncio.get_running_loop().time() >= deadline:
                    raise ProviderError(
                        f"fal job exceeded {self.deadline_s:.0f}s — giving up"
                    )
                await asyncio.sleep(_POLL_INTERVAL_S)

            result = (await client.get(response_url, headers=headers)).json()
            video = result.get("video") or {}
            url = video.get("url") if isinstance(video, dict) else None
            if not url:
                raise ProviderError(f"fal returned no video url: {str(result)[:300]}")
            download = await client.get(url)
            if download.status_code != 200:
                raise ProviderError(f"fal video download failed: {download.status_code}")
            return download.content

    def quote(self, duration_s: float) -> PriceQuote:
        return PriceQuote(
            estimate=round(self.rate * duration_s, 2),
            unit="per clip",
            detail=f"{self.model} · ${self.rate:.2f}/s",
        )
