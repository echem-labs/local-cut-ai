"""Headless ComfyUI adapter — process-isolated (GPL containment):
we talk to it exclusively over its HTTP/WebSocket API, never import its
code. Serves image (keyframe/thumbnail), video (clip) and music (ACE-Step)
node kinds via workflow-JSON templates; narration runs on the dedicated
TTS backend.
"""

from __future__ import annotations

import asyncio
import importlib.resources
import json
import uuid
from pathlib import Path

import httpx
import websockets

from ..aspects import IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS, resolution_for
from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError, OOMError

_OOM_MARKERS = ("out of memory", "cuda oom", "allocation failed")

# Placeholders _fill_workflow substitutes into workflow templates. Exported
# so template-validity tests iterate the same table the code uses.
PLACEHOLDERS = ("%%PROMPT%%", "%%SEED%%", "%%WIDTH%%", "%%HEIGHT%%",
                "%%KEYFRAME%%", "%%FRAMES%%", "%%SECONDS%%")

# A workflow that produces no websocket message for this long is considered
# wedged; the job fails instead of starving the GPU-serial scheduler forever.
# Generous because cold model loads emit no progress events.
INACTIVITY_TIMEOUT_S = 600


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
        is_video = spec.kind is NodeKind.CLIP
        table = VIDEO_RESOLUTIONS if is_video else IMAGE_RESOLUTIONS
        divisor = 32 if is_video else 8  # LTX latents need /32 dims
        width, height = resolution_for(table, aspect)
        scale = float(spec.params.get("resolution_scale", 1.0))  # OOM ladder
        width = max(divisor, int(width * scale) // divisor * divisor)
        height = max(divisor, int(height * scale) // divisor * divisor)

        prompt = str(spec.params.get("prompt", ""))
        if is_video:
            prompt = f"{prompt}, {spec.params.get('motion', '')}".strip(", ")
        elif spec.kind is NodeKind.MUSIC:
            prompt = f"{spec.params.get('brief', '')}, instrumental".strip(", ")

        duration_raw = spec.params.get("duration_s")
        if duration_raw is None:
            duration_raw = spec.params.get("target_duration_s", 5)
        duration_s = float(duration_raw)
        if duration_s <= 0:
            raise GenerationError(f"invalid duration for {spec.node_id}: {duration_raw!r}")
        # LTX frame counts must be 8n+1.
        frames = max(9, round(duration_s * 24 / 8) * 8 + 1)
        # %%PROMPT%% substitutes LAST: user text may contain placeholder
        # tokens, and substituting it first would let later replacements
        # rewrite the user's prompt (or corrupt the workflow JSON).
        replacements = {
            '"%%SEED%%"': str(spec.seed),
            '"%%WIDTH%%"': str(width),
            '"%%HEIGHT%%"': str(height),
            "%%KEYFRAME%%": keyframe_name or "",
            '"%%FRAMES%%"': str(frames),
            '"%%SECONDS%%"': str(duration_s),
            "%%PROMPT%%": json.dumps(prompt)[1:-1],  # JSON-escaped, no quotes
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
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=INACTIVITY_TIMEOUT_S)
            except TimeoutError as exc:
                raise GenerationError(
                    f"ComfyUI produced no events for {INACTIVITY_TIMEOUT_S}s — "
                    "the workflow appears wedged"
                ) from exc
            except websockets.ConnectionClosed:
                return  # socket gone — fall through to history collection
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
                        if file_response.status_code != 200:
                            raise GenerationError(
                                f"ComfyUI /view returned {file_response.status_code} "
                                f"for {item['filename']}"
                            )
                        suffix = Path(item["filename"]).suffix or ".bin"
                        out = ctx.output_path(spec.output_hash, suffix)
                        out.write_bytes(file_response.content)
                        return out
        raise GenerationError("ComfyUI workflow finished without a retrievable output")
