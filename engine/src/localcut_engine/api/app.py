"""The engine API — a server the UI happens to launch.

Rules enforced here, not by convention:
- No filesystem shortcuts: assets/previews/exports only via the API.
- Token auth on every route (Electron passes the token it spawned us with;
  remote frontends pair explicitly).
- Version handshake on /health for frontend↔engine mismatch handling.
"""

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import ENGINE_API_VERSION, __version__
from ..aspects import EXPORT_RESOLUTIONS
from ..backends.align import AlignBackend
from ..backends.base import BackendRegistry
from ..backends.comfyui import ComfyUIBackend
from ..backends.ffmpeg import FFmpegBackend
from ..backends.kokoro import KokoroBackend
from ..backends.llm import LLMScriptBackend
from ..backends.mock import MockBackend
from ..config import EngineConfig
from ..events import EventBus
from ..graph.model import NODE_ID_PATTERN
from ..graph.patch import PatchOp
from ..hardware.probe import probe_hardware
from ..jobs.models import JOB_ID_PATTERN
from ..jobs.queue import JobQueue
from ..jobs.scheduler import Scheduler
from ..manifest.loader import load_manifest
from ..manifest.recommend import recommend_slate
from ..project.store import PROJECT_ID_PATTERN, ProjectStore
from ..service import ProjectService

logger = logging.getLogger(__name__)

# Path params are identifiers, never paths: reject anything that could act
# as a filesystem component or glob before it reaches the store layer.
# Id patterns live next to their generators so the two cannot drift.
ProjectId = Annotated[str, PathParam(pattern=PROJECT_ID_PATTERN)]
NodeId = Annotated[str, PathParam(pattern=NODE_ID_PATTERN)]
OutputHash = Annotated[str, PathParam(pattern=r"^[a-f0-9]{64}$")]
JobId = Annotated[str, PathParam(pattern=JOB_ID_PATTERN)]


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
                    LLMScriptBackend(base_url=config.llm_url, model=config.llm_model)
                )
            case "comfy":
                registry.register(
                    ComfyUIBackend(
                        base_url=config.comfyui_url,
                        templates_dir=config.data_dir / "comfy-templates",
                        kinds=config.comfy_kinds,
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
                registry.register(FFmpegBackend(ffmpeg_bin=config.ffmpeg_bin))
            case _:
                raise ValueError(f"unknown backend in chain: {name!r}")
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

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        scheduler.start()
        yield
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
        manifest = load_manifest(config)
        return {
            "hardware": profile.model_dump(),
            "recommendations": [r.model_dump() for r in recommend_slate(manifest, profile)],
            "backend_mode": config.backend,
        }

    @app.get("/models/manifest", dependencies=[Authed])
    async def models_manifest() -> dict:
        return load_manifest(config).model_dump()

    # -- projects --------------------------------------------------------------

    class CreateProject(BaseModel):
        prompt: str = Field(min_length=1, max_length=4000)
        # Bounds mirror the screenplay schema (scene duration gt=0 le=60):
        # values outside them would only fail later as opaque job errors.
        target_duration_s: int = Field(default=60, ge=5, le=600)
        aspect: str = "9:16"
        style_preset: str = "cinematic"

    @app.post("/projects", dependencies=[Authed])
    async def create_project(body: CreateProject) -> dict:
        if body.aspect not in EXPORT_RESOLUTIONS:
            # An unknown aspect would silently render as the default one.
            raise HTTPException(
                status_code=422,
                detail=f"unsupported aspect {body.aspect!r} — "
                f"one of: {', '.join(sorted(EXPORT_RESOLUTIONS))}",
            )
        project = await asyncio.to_thread(
            service.create_from_prompt,
            body.prompt,
            target_duration_s=body.target_duration_s,
            aspect=body.aspect,
            style_preset=body.style_preset,
        )
        return project.model_dump()

    @app.get("/projects", dependencies=[Authed])
    async def list_projects() -> list[dict]:
        return [p.model_dump() for p in store.list()]

    def _get_project(project_id: str):
        project = store.get(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        return project

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

    @app.post("/projects/{project_id}/finalize", dependencies=[Authed])
    async def finalize(project_id: ProjectId) -> dict:
        _get_project(project_id)
        return {"enqueued": await asyncio.to_thread(service.finalize, project_id)}

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
