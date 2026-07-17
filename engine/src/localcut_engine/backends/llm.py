"""Script LLM backend — llama.cpp server / Ollama (both speak an
OpenAI-compatible chat API), or a cloud TextGen provider adapter. Emits the
structured screenplay (schema-enforced JSON).
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..providers.base import TextGen
from ..schema import Screenplay
from .base import ExecutionBackend, ExecutionContext, GenerationError

_SYSTEM_PROMPT = """You are a short-form video screenwriter. Given a topic, produce a JSON \
screenplay with this exact shape (no markdown fences, JSON only):
{"title": str, "hook": str, "target_duration_s": int, "aspect": str,
 "style": {"visual": str, "voice": str, "music": str},
 "scenes": [{"id": "s1", "duration_s": float, "narration": str, "visual": str,
             "motion": str, "onscreen_text": str|null}]}
Scenes are 3-8 seconds each. Narration is spoken aloud; visual is an image-generation prompt; \
motion is a short camera direction. The first scene must hook the viewer instantly."""


class LLMScriptBackend(ExecutionBackend):
    name = "llm"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434/v1",
        model: str = "qwen3:14b",
        cloud_provider: TextGen | None = None,
        unload_after: bool = True,
    ) -> None:
        base = base_url.rstrip("/")
        # Accept both http://host:port and http://host:port/v1 — the chat
        # endpoint lives under /v1 on Ollama/llama.cpp, native APIs at root.
        self.root_url = base.removesuffix("/v1")
        self.chat_base = base if base.endswith("/v1") else f"{base}/v1"
        self.model = model
        self.cloud_provider = cloud_provider
        # The scheduler owns VRAM: on shared-GPU boxes the LLM must yield
        # before image/video jobs run (LLM → unload → image batch).
        self.unload_after = unload_after

    def supports(self, kind: NodeKind) -> bool:
        return kind is NodeKind.SCRIPT

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        prompt = (
            f"Topic: {spec.params.get('prompt', '')}\n"
            f"Target duration: {spec.params.get('target_duration_s', 60)}s\n"
            f"Aspect: {spec.params.get('aspect', '9:16')}\n"
            f"Style preset: {spec.params.get('style_preset', 'cinematic')}"
        )
        use_cloud = spec.model is not None and spec.model.startswith("cloud:")
        if use_cloud and self.cloud_provider is not None:
            raw = await self.cloud_provider.complete(system=_SYSTEM_PROMPT, prompt=prompt)
        else:
            raw = await self._local_complete(prompt)
            if self.unload_after:
                await self._unload()
        await ctx.progress(0.9)

        screenplay = self._parse_screenplay(raw)
        out = ctx.output_path(spec.output_hash, ".screenplay.json")
        out.write_text(screenplay.model_dump_json(indent=2))
        return out

    async def _local_complete(self, prompt: str) -> str:
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{self.chat_base}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.7,
                },
            )
            if response.status_code != 200:
                raise GenerationError(f"local LLM error: {response.text[:500]}")
            return response.json()["choices"][0]["message"]["content"]

    async def _unload(self) -> None:
        """Best-effort VRAM release via Ollama's native API; llama.cpp and
        other OpenAI-compatible servers simply 404 and are ignored."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{self.root_url}/api/generate", json={"model": self.model, "keep_alive": 0}
                )
        except httpx.HTTPError:
            pass

    @staticmethod
    def _parse_screenplay(raw: str) -> Screenplay:
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("```")[1].removeprefix("json").strip()
        try:
            return Screenplay.model_validate(json.loads(text))
        except (json.JSONDecodeError, ValueError) as exc:
            raise GenerationError(f"LLM returned an invalid screenplay: {exc}") from exc
