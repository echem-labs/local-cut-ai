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

from ..aspects import DEFAULT_ASPECT, IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS, resolution_for
from ..graph.compiler import JobSpec
from ..graph.model import KEYFRAME_PORT, NodeKind
from .base import ExecutionBackend, ExecutionContext, GenerationError, OOMError

_OOM_MARKERS = ("out of memory", "cuda oom", "allocation failed")

# The one substitution table: (token, json_quoted). Order matters —
# %%PROMPT%% is last so user text can never be rewritten by later
# replacements. _fill_workflow and the template-validity tests both derive
# from this, so the two cannot drift.
_SUBSTITUTIONS = (
    ("%%SEED%%", True),
    ("%%WIDTH%%", True),
    ("%%HEIGHT%%", True),
    ("%%KEYFRAME%%", False),
    ("%%FRAMES%%", True),
    ("%%FRAMES16%%", True),  # 16 fps models (Wan) count frames differently
    ("%%SECONDS%%", True),
    ("%%HALF_STEPS%%", True),  # two-stage samplers hand over mid-schedule
    ("%%STEPS%%", True),
    ("%%PROMPT%%", False),
)
PLACEHOLDERS = tuple(token for token, _ in _SUBSTITUTIONS)

# Draft-tier sampler steps per kind; the draft→final ladder scales these and
# (for clips) the render resolution — same graph, one quality parameter.
_BASE_STEPS = {
    NodeKind.KEYFRAME: 20,
    NodeKind.THUMBNAIL: 20,
    NodeKind.CLIP: 25,
    NodeKind.MUSIC: 27,
}
_FINAL_STEPS_SCALE = 1.5
_FINAL_RES_SCALE = 1.5  # clips only: drafts render small for pacing review

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
        model_templates: dict[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.templates_dir = templates_dir
        self.kinds = {NodeKind(k.strip()) for k in kinds.split(",") if k.strip()}
        # Manifest-fed model id → workflow template. Model switching (e.g.
        # LTX drafts, Wan finals) is a template swap, not new code.
        self.model_templates = model_templates or {}
        self.client_id = uuid.uuid4().hex

    def supports(self, kind: NodeKind) -> bool:
        return kind in self.kinds

    def _template_path(self, spec: JobSpec) -> Path:
        by_model = self.model_templates.get((spec.model or "").removeprefix("local:"))
        template_name = str(
            spec.params.get("comfy_template") or by_model or f"{spec.kind.value}_default.json"
        )
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
        aspect = str(spec.params.get("aspect", DEFAULT_ASPECT))
        is_video = spec.kind is NodeKind.CLIP
        is_final = spec.quality == "final"
        table = VIDEO_RESOLUTIONS if is_video else IMAGE_RESOLUTIONS
        divisor = 32 if is_video else 8  # LTX latents need /32 dims
        width, height = resolution_for(table, aspect)
        scale = float(spec.params.get("resolution_scale", 1.0))  # OOM ladder
        if is_video and is_final:
            scale *= _FINAL_RES_SCALE
        width = max(divisor, int(width * scale) // divisor * divisor)
        height = max(divisor, int(height * scale) // divisor * divisor)
        steps = _BASE_STEPS.get(spec.kind, 20)
        if is_final:
            steps = round(steps * _FINAL_STEPS_SCALE)

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
        # LTX frame counts must be 8n+1 (24 fps); Wan's must be 4n+1 (16 fps).
        frames = max(9, round(duration_s * 24 / 8) * 8 + 1)
        frames16 = max(5, round(duration_s * 16 / 4) * 4 + 1)
        values = {
            "%%SEED%%": str(spec.seed),
            "%%WIDTH%%": str(width),
            "%%HEIGHT%%": str(height),
            "%%KEYFRAME%%": keyframe_name or "",
            "%%FRAMES%%": str(frames),
            "%%FRAMES16%%": str(frames16),
            "%%SECONDS%%": str(duration_s),
            "%%HALF_STEPS%%": str(max(1, steps // 2)),
            "%%STEPS%%": str(steps),
            "%%PROMPT%%": json.dumps(prompt)[1:-1],  # JSON-escaped, no quotes
        }
        for token, quoted in _SUBSTITUTIONS:
            text = text.replace(f'"{token}"' if quoted else token, values[token])
        return json.loads(text)

    async def _upload_input(self, client: httpx.AsyncClient, path: Path) -> str:
        """Upload a conditioning image (I2V keyframe); returns the server-side
        name to reference from a LoadImage node."""
        payload_bytes = await asyncio.to_thread(path.read_bytes)
        response = await client.post(
            f"{self.base_url}/upload/image",
            files={"image": (path.name, payload_bytes, "image/png")},
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
            keyframe = ctx.input_artifacts.get(KEYFRAME_PORT)
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
                finished = await self._stream_progress(ws, prompt_id, ctx)
        # A dropped socket is not a failed render: keep polling history for
        # as long as the inactivity watchdog would have allowed.
        return await self._collect_output(
            prompt_id, spec, ctx, deadline_s=1.0 if finished else INACTIVITY_TIMEOUT_S
        )

    async def _stream_progress(self, ws, prompt_id: str, ctx: ExecutionContext) -> bool:
        """Consume events until the workflow finishes (True) or the socket
        drops mid-run (False — history polling takes over)."""
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=INACTIVITY_TIMEOUT_S)
            except TimeoutError as exc:
                if await self._queue_state(prompt_id) == "pending":
                    # Waiting behind someone else's work on a shared server —
                    # ComfyUI only sends execution events to the owning
                    # client, so silence here is not a wedge.
                    continue
                await self._cancel_prompt(prompt_id)
                raise GenerationError(
                    f"ComfyUI produced no events for {INACTIVITY_TIMEOUT_S}s — "
                    "the workflow appears wedged"
                ) from exc
            except websockets.ConnectionClosed:
                return False
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
                return True  # workflow finished

    async def _queue_state(self, prompt_id: str) -> str | None:
        """'pending' | 'running' | None, from ComfyUI's queue endpoint."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                payload = (await client.get(f"{self.base_url}/queue")).json()
        except (httpx.HTTPError, ValueError):
            return None
        for state, key in (("running", "queue_running"), ("pending", "queue_pending")):
            for item in payload.get(key, []):
                if len(item) > 1 and item[1] == prompt_id:
                    return state
        return None

    async def _cancel_prompt(self, prompt_id: str) -> None:
        """Best-effort server-side cancel — a failed job must not leave an
        orphaned prompt occupying the GPU behind the scheduler's back."""
        try:
            state = await self._queue_state(prompt_id)
            async with httpx.AsyncClient(timeout=10) as client:
                if state == "pending":
                    await client.post(f"{self.base_url}/queue", json={"delete": [prompt_id]})
                elif state == "running":
                    await client.post(f"{self.base_url}/interrupt")
        except httpx.HTTPError:
            pass

    async def _collect_output(
        self, prompt_id: str, spec: JobSpec, ctx: ExecutionContext, deadline_s: float = 10.0
    ) -> Path:
        async with httpx.AsyncClient(timeout=30) as client:
            history = None
            deadline = asyncio.get_running_loop().time() + deadline_s
            while True:
                response = await client.get(f"{self.base_url}/history/{prompt_id}")
                history = response.json().get(prompt_id)
                if history:
                    break
                if asyncio.get_running_loop().time() >= deadline:
                    raise GenerationError("ComfyUI produced no history for the workflow")
                if deadline_s > 10.0 and await self._queue_state(prompt_id) is None:
                    # Socket-drop recovery: the prompt is neither queued nor
                    # running and produced no history — it is genuinely gone.
                    raise GenerationError("ComfyUI dropped the workflow without producing output")
                await asyncio.sleep(0.2 if deadline_s <= 10.0 else 2.0)

            # Previews/temps are not artifacts; video kinds prefer video
            # containers, music prefers audio.
            preference = {
                NodeKind.CLIP: ("videos", "gifs"),
                NodeKind.MUSIC: ("audio",),
            }.get(spec.kind, ("images",))
            candidates: list[tuple[str, dict]] = []
            for node_output in history.get("outputs", {}).values():
                for key in ("images", "gifs", "videos", "audio"):
                    for item in node_output.get(key, []):
                        if item.get("type", "output") == "output":
                            candidates.append((key, item))
            item = next(
                (entry for key, entry in candidates if key in preference),
                candidates[0][1] if candidates else None,
            )
            if item is None:
                # No output. If the socket dropped on a server-side OOM, the
                # error survives only in history.status — surface it as
                # OOMError so the scheduler still walks the resolution/steps
                # fallback ladder instead of failing the job outright.
                status_text = json.dumps(history.get("status", {})).lower()
                if any(marker in status_text for marker in _OOM_MARKERS):
                    raise OOMError("ComfyUI ran out of memory")
                raise GenerationError("ComfyUI workflow finished without a retrievable output")

            params = {
                "filename": item["filename"],
                "subfolder": item.get("subfolder", ""),
                "type": item.get("type", "output"),
            }
            suffix = Path(item["filename"]).suffix or ".bin"
            out = ctx.output_path(spec.output_hash, suffix)
            # Stream into a temp file and rename into place only on success: a
            # mid-stream connection drop must never leave a truncated
            # `{hash}{suffix}` that the existence-cache serves as a valid render
            # forever (ChatterboxBackend guards its output the same way).
            tmp = out.with_name(f".partial-{uuid.uuid4().hex}{suffix}")
            try:
                async with client.stream(
                    "GET", f"{self.base_url}/view", params=params
                ) as file_response:
                    if file_response.status_code != 200:
                        raise GenerationError(
                            f"ComfyUI /view returned {file_response.status_code} "
                            f"for {item['filename']}"
                        )
                    with tmp.open("wb") as handle:
                        async for chunk in file_response.aiter_bytes(1 << 20):
                            await asyncio.to_thread(handle.write, chunk)
                tmp.replace(out)
            finally:
                tmp.unlink(missing_ok=True)
            return out
