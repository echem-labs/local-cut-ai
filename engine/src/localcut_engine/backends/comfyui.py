"""Headless ComfyUI adapter — process-isolated (GPL containment):
we talk to it exclusively over its HTTP/WebSocket API, never import its
code. Serves image (keyframe/thumbnail), video (clip), TTS and music node
kinds via workflow-JSON templates referenced from the model manifest.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import httpx
import websockets

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError, OOMError

_KINDS = {
    NodeKind.KEYFRAME,
    NodeKind.THUMBNAIL,
    NodeKind.CLIP,
    NodeKind.NARRATION,
    NodeKind.MUSIC,
}

_OOM_MARKERS = ("out of memory", "cuda oom", "allocation failed")


class ComfyUIBackend(ExecutionBackend):
    name = "comfyui"

    def __init__(self, base_url: str = "http://127.0.0.1:8188", templates_dir: Path | None = None):
        self.base_url = base_url.rstrip("/")
        self.templates_dir = templates_dir
        self.client_id = uuid.uuid4().hex

    def supports(self, kind: NodeKind) -> bool:
        return kind in _KINDS

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                response = await client.get(f"{self.base_url}/system_stats")
                return response.status_code == 200
        except httpx.HTTPError:
            return False

    def _load_workflow(self, spec: JobSpec) -> dict:
        """Resolve the workflow-JSON template for this job's model (the
        manifest's `comfy_graph_template`) and fill in prompt/seed/inputs."""
        if self.templates_dir is None:
            raise GenerationError("comfyui backend has no templates directory configured")
        template_name = spec.params.get("comfy_template") or f"{spec.kind.value}_default.json"
        template_path = self.templates_dir / template_name
        if not template_path.exists():
            raise GenerationError(f"missing ComfyUI workflow template: {template_name}")
        workflow = json.loads(template_path.read_text())
        # Convention: templates expose %%PROMPT%% / %%SEED%% placeholders.
        text = json.dumps(workflow)
        text = text.replace("%%PROMPT%%", str(spec.params.get("prompt", "")))
        text = text.replace('"%%SEED%%"', str(spec.seed))
        return json.loads(text)

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        workflow = self._load_workflow(spec)
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.base_url}/prompt",
                json={"prompt": workflow, "client_id": self.client_id},
            )
            if response.status_code != 200:
                raise GenerationError(f"ComfyUI rejected workflow: {response.text[:500]}")
            prompt_id = response.json()["prompt_id"]

        await self._stream_progress(prompt_id, ctx)
        return await self._collect_output(prompt_id, spec, ctx)

    async def _stream_progress(self, prompt_id: str, ctx: ExecutionContext) -> None:
        ws_url = self.base_url.replace("http", "ws", 1) + f"/ws?clientId={self.client_id}"
        async with websockets.connect(ws_url, max_size=2**24) as ws:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue  # preview frames — forwarded in a later phase
                message = json.loads(raw)
                data = message.get("data", {})
                if message.get("type") == "progress":
                    await ctx.progress(data.get("value", 0) / max(1, data.get("max", 1)))
                elif message.get("type") == "execution_error":
                    error_text = json.dumps(data).lower()
                    if any(marker in error_text for marker in _OOM_MARKERS):
                        raise OOMError(data.get("exception_message", "CUDA out of memory"))
                    raise GenerationError(data.get("exception_message", "ComfyUI execution error"))
                elif (
                    message.get("type") == "executing"
                    and data.get("node") is None
                    and data.get("prompt_id") == prompt_id
                ):
                    return  # workflow finished

    async def _collect_output(self, prompt_id: str, spec: JobSpec, ctx: ExecutionContext) -> Path:
        async with httpx.AsyncClient(timeout=30) as client:
            for _ in range(50):
                response = await client.get(f"{self.base_url}/history/{prompt_id}")
                history = response.json().get(prompt_id)
                if history:
                    break
                await asyncio.sleep(0.2)
            else:
                raise GenerationError("ComfyUI produced no history for the workflow")

            for node_output in history.get("outputs", {}).values():
                for key in ("images", "gifs", "videos", "audio"):
                    for item in node_output.get(key, []):
                        params = {
                            "filename": item["filename"],
                            "subfolder": item.get("subfolder", ""),
                            "type": item.get("type", "output"),
                        }
                        file_response = await client.get(f"{self.base_url}/view", params=params)
                        suffix = Path(item["filename"]).suffix or ".bin"
                        out = ctx.output_path(spec.output_hash, suffix)
                        out.write_bytes(file_response.content)
                        return out
        raise GenerationError("ComfyUI workflow finished without a retrievable output")
