"""Headless ComfyUI adapter — process-isolated (GPL containment):
we talk to it exclusively over its HTTP/WebSocket API, never import its
code. Serves image (keyframe/thumbnail) and video (clip) node kinds via
workflow-JSON templates; narration/music join once their custom node
packs are part of the managed ComfyUI component.
"""

from __future__ import annotations

import asyncio
import importlib.resources
import json
import uuid
from pathlib import Path

import httpx
import websockets

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError, OOMError

_OOM_MARKERS = ("out of memory", "cuda oom", "allocation failed")

# Aspect ratio -> SDXL-friendly resolution.
_RESOLUTIONS = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "1:1": (1024, 1024),
}


class ComfyUIBackend(ExecutionBackend):
    name = "comfyui"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8188",
        templates_dir: Path | None = None,
        kinds: str = "keyframe,thumbnail,clip",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.templates_dir = templates_dir
        self.kinds = {NodeKind(k.strip()) for k in kinds.split(",") if k.strip()}
        self.client_id = uuid.uuid4().hex

    def supports(self, kind: NodeKind) -> bool:
        return kind in self.kinds

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                response = await client.get(f"{self.base_url}/system_stats")
                return response.status_code == 200
        except httpx.HTTPError:
            return False

    def _template_path(self, spec: JobSpec) -> Path:
        template_name = str(spec.params.get("comfy_template") or f"{spec.kind.value}_default.json")
        # Template names are bare filenames from the model manifest; params
        # are user-editable, so a path-shaped value must never leave the dir.
        if Path(template_name).name != template_name:
            raise GenerationError(f"invalid workflow template name: {template_name!r}")
        if self.templates_dir is not None:
            override = self.templates_dir / template_name
            if override.exists():
                return override
        packaged = importlib.resources.files("localcut_engine.comfy_templates") / template_name
        if packaged.is_file():
            return Path(str(packaged))
        raise GenerationError(f"missing ComfyUI workflow template: {template_name}")

    def _fill_workflow(self, spec: JobSpec, keyframe_name: str | None) -> dict:
        """Load the workflow template and substitute %%PLACEHOLDERS%%."""
        text = self._template_path(spec).read_text()
        aspect = str(spec.params.get("aspect", "16:9"))
        width, height = _RESOLUTIONS.get(aspect, _RESOLUTIONS["16:9"])
        scale = float(spec.params.get("resolution_scale", 1.0))  # OOM ladder
        width, height = int(width * scale) // 8 * 8, int(height * scale) // 8 * 8
        prompt = str(spec.params.get("prompt", ""))
        if spec.kind is NodeKind.CLIP:
            prompt = f"{prompt}, {spec.params.get('motion', '')}".strip(", ")
        replacements = {
            "%%PROMPT%%": json.dumps(prompt)[1:-1],  # JSON-escaped, no quotes
            '"%%SEED%%"': str(spec.seed),
            '"%%WIDTH%%"': str(width),
            '"%%HEIGHT%%"': str(height),
            "%%KEYFRAME%%": keyframe_name or "",
            '"%%FRAMES%%"': str(int(float(spec.params.get("duration_s", 5.0)) * 24) + 1),
        }
        for placeholder, value in replacements.items():
            text = text.replace(placeholder, value)
        return json.loads(text)

    async def _upload_input(self, client: httpx.AsyncClient, path: Path) -> str:
        """Upload a conditioning image (I2V keyframe); returns the server-side
        name to reference from a LoadImage node."""
        response = await client.post(
            f"{self.base_url}/upload/image",
            files={"image": (path.name, path.read_bytes(), "image/png")},
            data={"overwrite": "true"},
        )
        if response.status_code != 200:
            raise GenerationError(f"ComfyUI rejected input upload: {response.text[:300]}")
        payload = response.json()
        subfolder = payload.get("subfolder", "")
        return f"{subfolder}/{payload['name']}" if subfolder else payload["name"]

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        async with httpx.AsyncClient(timeout=60) as client:
            keyframe_name = None
            keyframe = ctx.input_artifacts.get("keyframe")
            if keyframe is not None and spec.kind is NodeKind.CLIP:
                keyframe_name = await self._upload_input(client, keyframe)
            workflow = self._fill_workflow(spec, keyframe_name)

            # Subscribe to events *before* submitting: a fast workflow could
            # otherwise finish before we connect and we'd wait forever.
            ws_url = self.base_url.replace("http", "ws", 1) + f"/ws?clientId={self.client_id}"
            async with websockets.connect(ws_url, max_size=2**24) as ws:
                response = await client.post(
                    f"{self.base_url}/prompt",
                    json={"prompt": workflow, "client_id": self.client_id},
                )
                if response.status_code != 200:
                    raise GenerationError(f"ComfyUI rejected workflow: {response.text[:500]}")
                prompt_id = response.json()["prompt_id"]
                await self._stream_progress(ws, prompt_id, ctx)
        return await self._collect_output(prompt_id, spec, ctx)

    async def _stream_progress(self, ws, prompt_id: str, ctx: ExecutionContext) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                continue  # preview frames — forwarded in a later phase
            message = json.loads(raw)
            data = message.get("data", {})
            # Events carrying a prompt_id for a different workflow (e.g. a
            # power user's own queue on a shared ComfyUI) are not ours.
            if data.get("prompt_id") not in (None, prompt_id):
                continue
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
