"""The engine API — a server the UI happens to launch.

Rules enforced here, not by convention:
- No filesystem shortcuts: assets/previews/exports only via the API.
- Token auth on every route (Electron passes the token it spawned us with;
  remote frontends pair explicitly).
- Version handshake on /health for frontend↔engine mismatch handling.
"""

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import PurePosixPath
from typing import Annotated, Literal

import httpx
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi import Path as PathParam
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from .. import ENGINE_API_VERSION, __version__
from ..aspects import EXPORT_RESOLUTIONS
from ..backends.align import AlignBackend
from ..backends.base import BackendRegistry, GenerationError, ServiceProbe
from ..backends.chatterbox import ChatterboxBackend
from ..backends.cloud import CloudBackend
from ..backends.comfyui import ComfyUIBackend
from ..backends.ffmpeg import FFmpegBackend
from ..backends.kokoro import KokoroBackend
from ..backends.llm import LLMScriptBackend
from ..backends.mock import MockBackend
from ..config import EngineConfig
from ..events import EventBus
from ..graph.editor import EDIT_SYSTEM_PROMPT, parse_edit_plan
from ..graph.model import NODE_ID_PATTERN, NodeKind
from ..graph.patch import PatchOp
from ..hardware.probe import probe_hardware
from ..jobs.models import JOB_ID_PATTERN
from ..jobs.queue import JobQueue
from ..jobs.scheduler import Scheduler
from ..manifest.capability import installed_comfy_kinds, installed_comfy_models
from ..manifest.custom import TASK_DESTS, add_custom_model, remove_custom_model
from ..manifest.loader import load_manifest
from ..manifest.manager import DownloadManager, ManifestError
from ..manifest.recommend import recommend_slate
from ..providers.registry import configured_providers, textgen_for_model
from ..providers.textgen import ProviderError
from ..project.store import PROJECT_ID_PATTERN, ProjectStore
from ..service import ConflictError, ProjectService
from ..storage import clear_caches, compute_storage

logger = logging.getLogger(__name__)

# Path params are identifiers, never paths: reject anything that could act
# as a filesystem component or glob before it reaches the store layer.
# Id patterns live next to their generators so the two cannot drift.
ProjectId = Annotated[str, PathParam(pattern=PROJECT_ID_PATTERN)]
NodeId = Annotated[str, PathParam(pattern=NODE_ID_PATTERN)]
OutputHash = Annotated[str, PathParam(pattern=r"^[a-f0-9]{64}$")]
JobId = Annotated[str, PathParam(pattern=JOB_ID_PATTERN)]
ModelId = Annotated[str, PathParam(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")]

# Node kinds that render as jobs, in pipeline order — the Settings backend
# panel shows this list verbatim (scene/asset nodes never reach a backend).
_TASK_KINDS = (
    NodeKind.SCRIPT,
    NodeKind.KEYFRAME,
    NodeKind.THUMBNAIL,
    NodeKind.CLIP,
    NodeKind.NARRATION,
    NodeKind.CAPTIONS,
    NodeKind.MUSIC,
    NodeKind.TIMELINE,
    NodeKind.EXPORT,
)


def _resolved_tasks(backends: BackendRegistry, config: EngineConfig) -> list[dict]:
    """Per-kind default routing exactly as the scheduler would resolve it,
    plus which installed models make ComfyUI-eligible kinds servable."""
    comfy_models = installed_comfy_models(config)
    tasks = []
    for kind in _TASK_KINDS:
        try:
            name = backends.resolve(kind).name
        except GenerationError:
            name = None
        tasks.append(
            {
                "kind": kind.value,
                "backend": name,
                "installed_models": comfy_models.get(kind, []),
            }
        )
    return tasks


def _model_dests(config: EngineConfig, model_id: str) -> list[str] | None:
    """Weight paths come from the manifest (single source of truth) so a
    manifest dest bump can't strand a backend probing stale paths."""
    try:
        entry = next(m for m in load_manifest(config).models if m.id == model_id)
        return [f.dest for f in entry.files] or None
    except (StopIteration, OSError, ValueError):
        return None


def _build_backends(config: EngineConfig) -> BackendRegistry:
    """Build the backend chain from config; first registered wins per node
    kind, so e.g. `comfy,mock` = real images/clips, mock everything else."""
    registry = BackendRegistry()
    for name in config.backend_chain:
        match name:
            case "mock":
                registry.register(MockBackend())
            case "llm":
                registry.register(
                    LLMScriptBackend(
                        base_url=config.llm_url,
                        model=config.llm_model,
                        timeout_s=config.llm_timeout_s,
                    )
                )
            case "comfy":
                try:
                    model_templates = {
                        m.id: m.comfy_graph_template
                        for m in load_manifest(config).models
                        if m.comfy_graph_template
                    }
                except (OSError, ValueError):
                    model_templates = {}  # broken override manifest — defaults still work
                auto_kinds = config.comfy_kinds.strip().lower() == "auto"
                # Auto mode gates on the server too, not just weights — a
                # machine with LTX installed but ComfyUI down must fall
                # through to the still-clip/mock tiers, not fail jobs.
                comfy_probe = ServiceProbe(f"{config.comfyui_url.rstrip('/')}/queue")
                registry.register(
                    ComfyUIBackend(
                        base_url=config.comfyui_url,
                        templates_dir=config.data_dir / "comfy-templates",
                        kinds=(
                            "keyframe,thumbnail,clip,music" if auto_kinds else config.comfy_kinds
                        ),
                        model_templates=model_templates,
                        capability=(
                            (
                                lambda: installed_comfy_kinds(config)
                                if comfy_probe.available()
                                else set()
                            )
                            if auto_kinds
                            else None
                        ),
                    )
                )
            case "chatterbox":
                registry.register(
                    ChatterboxBackend(
                        models_dir=config.resolved_models_dir, ffmpeg_bin=config.resolved_ffmpeg_bin
                    )
                )
            case "kokoro":
                registry.register(
                    KokoroBackend(
                        models_dir=config.resolved_models_dir,
                        file_dests=_model_dests(config, "kokoro-82m"),
                    )
                )
            case "align":
                registry.register(
                    AlignBackend(
                        models_dir=config.resolved_models_dir,
                        file_dests=_model_dests(config, "faster-whisper-base-en"),
                    )
                )
            case "ffmpeg":
                registry.register(FFmpegBackend(ffmpeg_bin=config.resolved_ffmpeg_bin))
            case _:
                raise ValueError(f"unknown backend in chain: {name!r}")
    # Model-driven, not chain-driven: `cloud:*` node models route here no
    # matter what the local chain looks like (BYOK, keys via config).
    registry.register_cloud(CloudBackend(config))
    return registry


def create_app(config: EngineConfig | None = None) -> FastAPI:
    config = config or EngineConfig.from_env()
    config.data_dir.mkdir(parents=True, exist_ok=True)

    events = EventBus()
    store = ProjectStore(config.projects_dir)
    queue = JobQueue(config.queue_db)
    backends = _build_backends(config)
    service = ProjectService(store, queue, events, backends=backends)
    scheduler = Scheduler(
        queue=queue,
        backends=backends,
        events=events,
        output_dir_for=store.generated_dir,
        resolve_artifact=store.resolve_artifact,
        on_job_done=service.on_job_done,
    )
    service.scheduler = scheduler
    downloads = DownloadManager(config, events)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        scheduler.start()
        yield
        await downloads.shutdown()
        await scheduler.stop()
        queue.close()

    app = FastAPI(title="LocalCut Engine", version=__version__, lifespan=lifespan)

    # -- auth ---------------------------------------------------------------

    def token_ok(presented: str | None) -> bool:
        # Constant-time: the engine supports non-localhost binds, where a
        # timing oracle on an early-exit compare would leak the token.
        return presented is not None and secrets.compare_digest(presented, config.token)

    async def auth(
        authorization: Annotated[str | None, Header()] = None,
        token: Annotated[str | None, Query()] = None,
    ) -> None:
        presented = token
        if authorization and authorization.startswith("Bearer "):
            presented = authorization.removeprefix("Bearer ")
        if not token_ok(presented):
            raise HTTPException(status_code=401, detail="invalid or missing engine token")

    Authed = Depends(auth)

    # -- system ---------------------------------------------------------------

    @app.get("/health")
    async def health() -> dict:
        # Unauthenticated by design: only the version handshake, no data.
        return {
            "ok": True,
            "engine_version": __version__,
            "api_version": ENGINE_API_VERSION,
        }

    @app.get("/system", dependencies=[Authed])
    async def system() -> dict:
        # Hardware doesn't change at runtime; probe once, off the event loop
        # (nvidia-smi can block for seconds under GPU load).
        if not hasattr(app.state, "hardware_profile"):
            app.state.hardware_profile = await asyncio.to_thread(
                probe_hardware, str(config.data_dir)
            )
        profile = app.state.hardware_profile
        if not hasattr(app.state, "ffmpeg_drawtext"):
            # FFmpeg 7 static builds without libharfbuzz lack drawtext; the
            # setup surface must say so before an export dies on it. None =
            # ffmpeg not found at all (its own, clearer failure at use).
            app.state.ffmpeg_drawtext = await FFmpegBackend(
                ffmpeg_bin=config.resolved_ffmpeg_bin
            ).supports_drawtext()
        manifest = load_manifest(config)
        return {
            "hardware": profile.model_dump(),
            "recommendations": [r.model_dump() for r in recommend_slate(manifest, profile)],
            "backend_mode": config.backend,
            "ffmpeg_drawtext": app.state.ffmpeg_drawtext,
            # Per-file exists() checks scale with the manifest — keep them
            # off the loop, like /models does.
            "backends": {
                "chain": config.backend_chain,
                "comfy_kinds_auto": config.comfy_kinds.strip().lower() == "auto",
                "tasks": await asyncio.to_thread(_resolved_tasks, backends, config),
            },
        }

    @app.get("/models/manifest", dependencies=[Authed])
    async def models_manifest() -> dict:
        return load_manifest(config).model_dump()

    @app.get("/models", dependencies=[Authed])
    async def models() -> list[dict]:
        try:
            # Per-file exists() checks scale with the manifest — keep them
            # off the loop that serves /ws progress fan-out.
            return await asyncio.to_thread(downloads.status)
        except ManifestError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/models/{model_id}/download", dependencies=[Authed])
    async def start_download(model_id: ModelId) -> dict:
        try:
            return {"status": await downloads.start(model_id)}
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown model id") from None
        except ManifestError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.delete("/models/{model_id}/download", dependencies=[Authed])
    async def cancel_download(model_id: ModelId) -> dict:
        if not downloads.cancel(model_id):
            raise HTTPException(status_code=409, detail="model is not downloading")
        return {"ok": True}

    @app.delete("/models/{model_id}", dependencies=[Authed])
    async def delete_model(model_id: ModelId) -> dict:
        """Remove downloaded weights (and .part remnants) from disk."""
        try:
            freed = await asyncio.to_thread(downloads.delete, model_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown model id") from None
        except ManifestError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True, "freed_bytes": freed}

    class CustomModelBody(BaseModel):
        """Review 4's "Add custom model": registers a user model outside the
        curated catalog. `ref` is a direct weight-file URL (downloads through
        the normal manager) or an absolute local path (copied into the models
        dir). License is recorded unverified — the UI's self-acknowledgment
        is the doc-04 notice."""

        name: str = Field(min_length=1, max_length=80)
        task: Literal[
            "video.i2v", "video.t2v", "image.gen", "text.llm",
            "speech.tts", "music.gen", "transcribe",
        ]
        source: Literal["url", "file"]
        ref: str = Field(min_length=1, max_length=2000)
        vram_gb: float = Field(default=8, ge=0, le=512)
        workflow_template: str = Field(default="", max_length=128)

    @app.post("/models/custom", dependencies=[Authed])
    async def create_custom_model(body: CustomModelBody) -> dict:
        assert body.task in TASK_DESTS  # Literal and TASK_DESTS must agree
        try:
            entry = await asyncio.to_thread(
                add_custom_model,
                config,
                name=body.name,
                task=body.task,
                source=body.source,
                ref=body.ref,
                vram_gb=body.vram_gb,
                workflow_template=body.workflow_template,
            )
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except OSError as exc:
            # Don't echo the raw OSError: it carries absolute local paths and
            # usernames to a (possibly remote-paired) client. Log it instead.
            logger.warning("custom model install failed: %s", exc)
            raise HTTPException(
                status_code=500, detail="could not install the model file — check engine logs"
            ) from exc
        return entry.model_dump()

    @app.delete("/models/custom/{model_id}", dependencies=[Authed])
    async def delete_custom_model(model_id: ModelId) -> dict:
        entry = next(
            (m for m in load_manifest(config).models if m.id == model_id and m.custom), None
        )
        if entry is None:
            raise HTTPException(status_code=404, detail="unknown custom model")
        try:
            # Files first (the manager refuses mid-download), then the entry.
            freed = await asyncio.to_thread(downloads.delete, model_id)
            await asyncio.to_thread(remove_custom_model, config, model_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown custom model") from None
        return {"ok": True, "freed_bytes": freed}

    # -- storage (Settings → Storage, review 4) -------------------------------

    _STORAGE_TTL_S = 30.0

    @app.get("/storage", dependencies=[Authed])
    async def storage() -> dict:
        # Walking many multi-GB projects isn't free — cache briefly.
        cached = getattr(app.state, "storage_cache", None)
        if cached is not None and asyncio.get_running_loop().time() - cached[0] < _STORAGE_TTL_S:
            return cached[1]
        data = await asyncio.to_thread(compute_storage, config, store)
        app.state.storage_cache = (asyncio.get_running_loop().time(), data)
        return data

    @app.post("/storage/cleanup", dependencies=[Authed])
    async def storage_cleanup() -> dict:
        freed = await asyncio.to_thread(clear_caches, store)
        app.state.storage_cache = None
        return {"ok": True, "freed_bytes": freed}

    @app.get("/providers", dependencies=[Authed])
    async def providers() -> list[dict]:
        # Which BYOK providers exist and whether a key is present — the
        # settings UI's "what leaves this machine" panel reads this.
        return configured_providers(config)

    class ProviderKeys(BaseModel):
        anthropic_key: str | None = None
        openai_key: str | None = None
        gemini_key: str | None = None
        fal_key: str | None = None

    @app.put("/providers/keys", dependencies=[Authed])
    async def set_provider_keys(body: ProviderKeys) -> list[dict]:
        # Keys live only in this process: the desktop shell owns persistence
        # (OS keychain) and re-sends them on every engine start. Cloud
        # adapters read the config at call time, so updates apply live.
        # Omitted fields are untouched; null or empty clears a key.
        for field, value in body.model_dump(exclude_unset=True).items():
            setattr(config, field, (value or "").strip() or None)
        return configured_providers(config)

    # -- projects --------------------------------------------------------------

    class CreateProject(BaseModel):
        prompt: str = Field(min_length=1, max_length=4000)
        # Bounds mirror the screenplay schema (scene duration gt=0 le=60):
        # values outside them would only fail later as opaque job errors.
        target_duration_s: int = Field(default=60, ge=5, le=1200)
        aspect: str = "9:16"
        style_preset: str = "cinematic"
        mode: Literal["prompt", "beginner"] = "prompt"

    def _check_aspect(aspect: str) -> None:
        if aspect not in EXPORT_RESOLUTIONS:
            # An unknown aspect would silently render as the default one.
            raise HTTPException(
                status_code=422,
                detail=f"unsupported aspect {aspect!r} — "
                f"one of: {', '.join(sorted(EXPORT_RESOLUTIONS))}",
            )

    @app.post("/projects", dependencies=[Authed])
    async def create_project(body: CreateProject) -> dict:
        _check_aspect(body.aspect)
        project = await asyncio.to_thread(
            service.create_from_prompt,
            body.prompt,
            target_duration_s=body.target_duration_s,
            aspect=body.aspect,
            style_preset=body.style_preset,
            mode=body.mode,
        )
        return project.model_dump()

    # -- quick tools: one-node micro-projects ----------------------------------

    class ToolRequest(BaseModel):
        tool: Literal["script", "thumbnail", "voiceover", "image", "music", "clip"]
        prompt: str | None = Field(default=None, max_length=4000)
        text: str | None = Field(default=None, max_length=4000)
        voice: str = "narrator"
        aspect: str = "16:9"
        target_duration_s: int = Field(default=60, ge=5, le=1200)
        style_preset: str = "cinematic"
        # Single-clip generator: local I2V tops out at short takes.
        motion: str = Field(default="", max_length=500)
        duration_s: float = Field(default=5.0, ge=1.0, le=8.0)

    @app.post("/tools", dependencies=[Authed])
    async def create_tool(body: ToolRequest) -> dict:
        needs = "text" if body.tool == "voiceover" else "prompt"
        if not (getattr(body, needs) or "").strip():
            raise HTTPException(status_code=422, detail=f"{body.tool} requires {needs}")
        _check_aspect(body.aspect)
        project = await asyncio.to_thread(
            service.create_tool, body.tool, body.model_dump(exclude={"tool"})
        )
        return project.model_dump()

    class ApproveBody(BaseModel):
        checkpoint: Literal["script", "storyboard"]

    @app.post("/projects/{project_id}/approve", dependencies=[Authed])
    async def approve(project_id: ProjectId, body: ApproveBody) -> dict:
        _get_project(project_id)
        enqueued = await asyncio.to_thread(service.approve, project_id, body.checkpoint)
        return {"ok": True, "enqueued": enqueued}

    @app.post("/projects/{project_id}/promote", dependencies=[Authed])
    async def promote(project_id: ProjectId) -> dict:
        _get_project(project_id)
        try:
            project = await asyncio.to_thread(service.promote_tool, project_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return project.model_dump()

    @app.get("/projects", dependencies=[Authed])
    async def list_projects() -> list[dict]:
        return [p.model_dump() for p in store.list()]

    def _get_project(project_id: str):
        project = store.get(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        return project

    class RenameProject(BaseModel):
        title: str = Field(min_length=1, max_length=120)

    @app.patch("/projects/{project_id}", dependencies=[Authed])
    async def rename_project(project_id: ProjectId, body: RenameProject) -> dict:
        title = body.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="title cannot be empty")
        try:
            project = await asyncio.to_thread(service.rename, project_id, title)
        except KeyError:
            raise HTTPException(status_code=404, detail="project not found") from None
        return project.model_dump()

    @app.post("/projects/{project_id}/duplicate", dependencies=[Authed])
    async def duplicate_project(project_id: ProjectId) -> dict:
        try:
            project = await asyncio.to_thread(service.duplicate, project_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="project not found") from None
        return project.model_dump()

    @app.get("/projects/{project_id}", dependencies=[Authed])
    async def get_project(project_id: ProjectId) -> dict:
        project = _get_project(project_id)
        # Board building reads sqlite + scans generated/ — keep it off the
        # loop that serves /ws progress fan-out.
        board = await asyncio.to_thread(service.scene_board, project_id)
        return {"project": project.model_dump(), "board": board}

    @app.get("/projects/{project_id}/graph", dependencies=[Authed])
    async def get_graph(project_id: ProjectId) -> dict:
        _get_project(project_id)
        return store.load_graph(project_id).model_dump()

    _IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
    _AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a"}
    _ASSET_MAX_BYTES = 50 << 20

    @app.post("/projects/{project_id}/assets", dependencies=[Authed])
    async def upload_asset(
        project_id: ProjectId,
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=128)],
        consent: bool = False,
    ) -> dict:
        """Import a user asset (raw bytes body) as a graph node — images
        condition clips ('use my image as the shot source'); audio is a
        voice sample for cloning and REQUIRES the consent affirmation.
        Consent is enforced here, at the only door a sample can enter
        through, so no unconsented voice can ever reach the TTS backend."""
        _get_project(project_id)
        name = PurePosixPath(filename.replace("\\", "/")).name  # basename only, no paths
        suffix = PurePosixPath(name).suffix.lower()
        if suffix not in _IMAGE_EXTENSIONS | _AUDIO_EXTENSIONS:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported asset type {suffix!r} — one of: "
                f"{', '.join(sorted(_IMAGE_EXTENSIONS | _AUDIO_EXTENSIONS))}",
            )
        if suffix in _AUDIO_EXTENSIONS and not consent:
            raise HTTPException(
                status_code=403,
                detail="voice samples require consent=true — an affirmation that you "
                "have this speaker's permission to clone their voice",
            )
        # Stream with a hard cap rather than buffering the whole body first:
        # `await request.body()` reads the entire (possibly multi-GB) request
        # into memory before any size check could reject it.
        buffer = bytearray()
        async for chunk in request.stream():
            buffer.extend(chunk)
            if len(buffer) > _ASSET_MAX_BYTES:
                raise HTTPException(status_code=413, detail="asset exceeds the 50 MB limit")
        data = bytes(buffer)
        if not data:
            raise HTTPException(status_code=422, detail="asset body is empty")
        return await asyncio.to_thread(
            service.add_asset, project_id, name, data, suffix in _AUDIO_EXTENSIONS
        )

    class PatchBody(BaseModel):
        ops: list[PatchOp]

    @app.post("/projects/{project_id}/patch", dependencies=[Authed])
    async def patch_project(project_id: ProjectId, body: PatchBody) -> dict:
        _get_project(project_id)
        try:
            dirty = await asyncio.to_thread(service.patch, project_id, body.ops)
        except KeyError as exc:
            raise HTTPException(status_code=422, detail=f"unknown node: {exc}") from exc
        except ValueError as exc:
            # apply_patch input errors (duplicate id, missing node body) are
            # the caller's fault, not a server fault.
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"dirty": sorted(dirty)}

    class EditBody(BaseModel):
        instruction: str = Field(min_length=1, max_length=2000)
        # "project" (everything) or a scene id — the same shape node ids use.
        scope: str = Field(default="project", pattern=NODE_ID_PATTERN)
        # None → the local script LLM; "cloud:*" → BYOK textgen. Cloud is
        # opt-in per request: an edit must never silently spend the user's key.
        model: str | None = None

    @app.post("/projects/{project_id}/edit", dependencies=[Authed])
    async def edit_project(project_id: ProjectId, body: EditBody) -> dict:
        """Natural-language edit: the LLM sees the whitelisted graph view,
        returns an edit plan, and the plan compiles into ordinary patch ops."""
        _get_project(project_id)
        if body.model is not None and not body.model.startswith("cloud:"):
            raise HTTPException(status_code=422, detail="edit model must be a cloud:* text model")
        try:
            view = await asyncio.to_thread(service.edit_view, project_id, body.scope)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"unknown scene: {body.scope}") from None
        prompt = f"Project view:\n{json.dumps(view)}\n\nInstruction: {body.instruction}"
        if body.model:
            # Resolving the provider/key is a client precondition (missing BYOK
            # key, unknown model) → 4xx, distinct from an upstream failure of
            # .complete() below, which the 502 handler owns.
            try:
                cloud_gen = textgen_for_model(config, body.model)
            except ProviderError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            if body.model:
                raw = await cloud_gen.complete(system=EDIT_SYSTEM_PROMPT, prompt=prompt)
            else:
                # Interactive path onto the same local server as script jobs,
                # with the same VRAM-yield discipline (Ollama serializes
                # concurrent requests internally).
                raw = await LLMScriptBackend(
                    base_url=config.llm_url,
                    model=config.llm_model,
                    timeout_s=config.llm_timeout_s,
                ).complete(prompt, system=EDIT_SYSTEM_PROMPT)
            plan = parse_edit_plan(raw)
        except (ProviderError, GenerationError, ValueError, httpx.HTTPError) as exc:
            # The model or its transport failed us, not the client.
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        try:
            result = await asyncio.to_thread(
                service.apply_edit_plan, project_id, plan, body.scope, view.get("revision")
            )
        except ConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"summary": plan.summary, **result}

    class RegenerateBody(BaseModel):
        seed: int | None = None

    @app.post("/projects/{project_id}/nodes/{node_id}/regenerate", dependencies=[Authed])
    async def regenerate(project_id: ProjectId, node_id: NodeId, body: RegenerateBody) -> dict:
        _get_project(project_id)
        try:
            await asyncio.to_thread(service.regenerate, project_id, node_id, body.seed)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown node: {exc}") from exc
        return {"ok": True}

    class FinalizeBody(BaseModel):
        # The shell's Settings → Defaults video model; absent/None falls back
        # to the engine-configured final_clip_model. Validated: an unbounded
        # free string here is written to every unpinned clip node's model and
        # persisted, so a garbage value would corrupt the saved graph.
        clip_model: str | None = Field(
            default=None, max_length=128, pattern=r"^$|^(local:|cloud:)?[\w.\-]+$"
        )

    @app.post("/projects/{project_id}/finalize", dependencies=[Authed])
    async def finalize(project_id: ProjectId, body: FinalizeBody | None = None) -> dict:
        _get_project(project_id)
        clip_model = (body.clip_model if body else None) or config.final_clip_model
        return {"enqueued": await asyncio.to_thread(service.finalize, project_id, clip_model)}

    @app.post("/projects/{project_id}/package", dependencies=[Authed])
    async def package(project_id: ProjectId) -> dict:
        _get_project(project_id)
        try:
            nodes = await asyncio.to_thread(service.package, project_id)
        except LookupError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"nodes": nodes}

    @app.get("/projects/{project_id}/export/otio", dependencies=[Authed])
    async def export_otio(project_id: ProjectId) -> JSONResponse:
        _get_project(project_id)
        try:
            document = await asyncio.to_thread(service.export_otio, project_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return JSONResponse(
            document,
            headers={"Content-Disposition": f'attachment; filename="{project_id}.otio"'},
        )

    @app.get("/projects/{project_id}/export/fcpxml", dependencies=[Authed])
    async def export_fcpxml(project_id: ProjectId) -> Response:
        _get_project(project_id)
        try:
            document = await asyncio.to_thread(service.export_fcpxml, project_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return Response(
            document,
            media_type="application/xml",
            headers={"Content-Disposition": f'attachment; filename="{project_id}.fcpxml"'},
        )

    @app.delete("/projects/{project_id}", dependencies=[Authed])
    async def delete_project(project_id: ProjectId) -> dict:
        # Via the service: in-flight jobs must be cancelled or the scheduler
        # renders into (and recreates) the deleted directory.
        if not await asyncio.to_thread(service.delete, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        return {"ok": True}

    # -- jobs -------------------------------------------------------------------

    @app.get("/jobs", dependencies=[Authed])
    async def list_jobs(project_id: str | None = None) -> list[dict]:
        jobs = await asyncio.to_thread(queue.list, project_id)
        return [j.model_dump() for j in jobs]

    @app.post("/jobs/{job_id}/cancel", dependencies=[Authed])
    async def cancel_job(job_id: JobId) -> dict:
        if not queue.cancel(job_id):
            raise HTTPException(status_code=409, detail="job is not cancellable")
        return {"ok": True}

    # -- artifacts (playback via HTTP range requests) -------------------

    @app.get("/projects/{project_id}/artifacts/{output_hash}", dependencies=[Authed])
    async def artifact(project_id: ProjectId, output_hash: OutputHash) -> FileResponse:
        _get_project(project_id)
        path = store.resolve_artifact(project_id, output_hash)
        if path is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        return FileResponse(path)

    # -- events (progress streaming end to end) --------------------------

    @app.websocket("/ws")
    async def ws_events(websocket: WebSocket, token: str | None = None) -> None:
        presented = token
        authorization = websocket.headers.get("authorization", "")
        if authorization.startswith("Bearer "):
            presented = authorization.removeprefix("Bearer ")
        if not token_ok(presented):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        subscription = events.subscribe()
        try:
            while True:
                event = await subscription.get()
                await websocket.send_json(event)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            events.unsubscribe(subscription)

    return app
