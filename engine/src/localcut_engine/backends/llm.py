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

_METADATA_PROMPT = """You are a short-form video publisher. Given a video's script, produce a \
JSON publish kit with this exact shape (no markdown fences, JSON only):
{"title": str, "description": str, "hashtags": [str]}
Title under 70 characters, hook first, no all-caps clickbait. Description is 2-3 sentences. \
5-10 hashtags, lowercase, without the # symbol."""


class LLMScriptBackend(ExecutionBackend):
    name = "llm"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434/v1",
        model: str = "qwen3:14b",
        unload_after: bool = True,
    ) -> None:
        base = base_url.rstrip("/")
        # Accept both http://host:port and http://host:port/v1 — the chat
        # endpoint lives under /v1 on Ollama/llama.cpp, native APIs at root.
        self.root_url = base.removesuffix("/v1")
        self.chat_base = base if base.endswith("/v1") else f"{base}/v1"
        self.model = model
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
        if spec.model is not None and spec.model.startswith("cloud:"):
            # Never fall back to the local model silently — the user asked
            # for cloud quality and would believe they got it.
            raise GenerationError(
                f"cloud model {spec.model!r} requested but no cloud provider is "
                "configured (BYOK providers arrive in a later phase)"
            )
        if spec.params.get("task") == "metadata":
            # Publish kit (title/description/hashtags) from the script — a
            # second LLM task on the same backend, not a new node kind.
            raw = await self.complete(str(spec.params.get("prompt", "")), system=_METADATA_PROMPT)
            return ctx.publish_text(
                spec.output_hash, ".metadata.json", json.dumps(self._parse_metadata(raw), indent=2)
            )
        raw = await self.complete(prompt, system=_SYSTEM_PROMPT)
        await ctx.progress(0.9)

        screenplay = self._parse_screenplay(raw)
        return ctx.publish_text(
            spec.output_hash, ".screenplay.json", screenplay.model_dump_json(indent=2)
        )

    async def complete(self, prompt: str, system: str) -> str:
        """One-shot completion with the same VRAM-yield discipline as jobs:
        interactive tasks (graph edits) share the server with script jobs and
        must release the model for image/video work afterwards."""
        raw = await self._local_complete(prompt, system=system)
        if self.unload_after:
            await self._unload()
        return raw

    async def _local_complete(self, prompt: str, system: str = _SYSTEM_PROMPT) -> str:
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{self.chat_base}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.7,
                },
            )
            if response.status_code != 200:
                raise GenerationError(f"local LLM error: {response.text[:500]}")
            # A 200 with an unexpected shape (empty choices, error object) must
            # fail as a classified GenerationError, not a raw KeyError/IndexError.
            try:
                return response.json()["choices"][0]["message"]["content"]
            except (ValueError, KeyError, IndexError, TypeError) as exc:
                raise GenerationError(f"local LLM returned an unreadable body: {exc}") from exc

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

    @staticmethod
    def _parse_metadata(raw: str) -> dict:
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("```")[1].removeprefix("json").strip()
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise GenerationError(f"LLM returned an invalid publish kit: {exc}") from exc
        hashtags = data.get("hashtags") or []
        return {
            "title": str(data.get("title", ""))[:120],
            "description": str(data.get("description", "")),
            "hashtags": [str(tag).lstrip("#") for tag in hashtags if str(tag).strip()],
        }
