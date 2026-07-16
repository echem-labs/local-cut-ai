"""The engine API — a server the UI happens to launch.

Rules enforced here, not by convention:
- No filesystem shortcuts: assets/previews/exports only via the API.
- Token auth on every route (Electron passes the token it spawned us with;
  remote frontends pair explicitly).
- Version handshake on /health for frontend↔engine mismatch handling.
"""

import importlib.resources
import logging
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
from ..backends.base import BackendRegistry
from ..backends.comfyui import ComfyUIBackend
from ..backends.ffmpeg import FFmpegBackend
from ..backends.llm import LLMScriptBackend
from ..backends.mock import MockBackend
from ..config import EngineConfig
from ..events import EventBus
from ..graph.patch import PatchOp
from ..hardware.probe import probe_hardware
from ..jobs.queue import JobQueue
from ..jobs.scheduler import Scheduler
from ..manifest.model import ModelManifest
from ..manifest.recommend import recommend_slate
from ..project.store import ProjectStore
from ..service import ProjectService

logger = logging.getLogger(__name__)

# Path params are identifiers, never paths: reject anything that could act
# as a filesystem component or glob before it reaches the store layer.
ProjectId = Annotated[str, PathParam(pattern=r"^[a-f0-9]{10}$")]
NodeId = Annotated[str, PathParam(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")]
OutputHash = Annotated[str, PathParam(pattern=r"^[a-f0-9]{64}$")]
JobId = Annotated[str, PathParam(pattern=r"^[a-f0-9]{12}$")]


def _build_backends(config: EngineConfig) -> BackendRegistry:
    registry = BackendRegistry()
    if config.backend == "mock":
        registry.register(MockBackend())
        return registry
    registry.register(LLMScriptBackend(base_url=config.llm_url, model=config.llm_model))
    registry.register(
        ComfyUIBackend(
            base_url=config.comfyui_url,
            templates_dir=config.data_dir / "comfy-templates",
        )
    )
    registry.register(FFmpegBackend())
    return registry


def _load_manifest(config: EngineConfig) -> ModelManifest:
    override = config.data_dir / "model-manifest.json"
    if override.exists():
        return ModelManifest.load(override)
    bundled = importlib.resources.files("localcut_engine.manifest") / "default-manifest.json"
    return ModelManifest.model_validate_json(bundled.read_text())


def create_app(config: EngineConfig | None = None) -> FastAPI:
    config = config or EngineConfig.from_env()
    config.data_dir.mkdir(parents=True, exist_ok=True)

    events = EventBus()
    store = ProjectStore(config.projects_dir)
    queue = JobQueue(config.queue_db)
    service = ProjectService(store, queue, events)
    scheduler = Scheduler(
        queue=queue,
        backends=_build_backends(config),
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
    app.state.config = config
    app.state.service = service
    app.state.events = events

    # -- auth ---------------------------------------------------------------

    async def auth(
        authorization: Annotated[str | None, Header()] = None,
        token: Annotated[str | None, Query()] = None,
    ) -> None:
        presented = token
        if authorization and authorization.startswith("Bearer "):
            presented = authorization.removeprefix("Bearer ")
        if presented != config.token:
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
        profile = probe_hardware()
        manifest = _load_manifest(config)
        return {
            "hardware": profile.model_dump(),
            "recommendations": [r.model_dump() for r in recommend_slate(manifest, profile)],
            "backend_mode": config.backend,
        }

    @app.get("/models/manifest", dependencies=[Authed])
    async def models_manifest() -> dict:
        return _load_manifest(config).model_dump()

    # -- projects --------------------------------------------------------------

    class CreateProject(BaseModel):
        prompt: str = Field(min_length=1, max_length=4000)
        target_duration_s: int = 60
        aspect: str = "9:16"
        style_preset: str = "cinematic"

    @app.post("/projects", dependencies=[Authed])
    async def create_project(body: CreateProject) -> dict:
        project = service.create_from_prompt(
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
        return {
            "project": project.model_dump(),
            "board": service.scene_board(project_id),
        }

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
            dirty = service.patch(project_id, body.ops)
        except KeyError as exc:
            raise HTTPException(status_code=422, detail=f"unknown node: {exc}") from exc
        return {"dirty": sorted(dirty)}

    class RegenerateBody(BaseModel):
        seed: int | None = None

    @app.post("/projects/{project_id}/nodes/{node_id}/regenerate", dependencies=[Authed])
    async def regenerate(project_id: ProjectId, node_id: NodeId, body: RegenerateBody) -> dict:
        _get_project(project_id)
        try:
            service.regenerate(project_id, node_id, body.seed)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown node: {exc}") from exc
        return {"ok": True}

    @app.post("/projects/{project_id}/finalize", dependencies=[Authed])
    async def finalize(project_id: ProjectId) -> dict:
        _get_project(project_id)
        return {"enqueued": service.finalize(project_id)}

    @app.delete("/projects/{project_id}", dependencies=[Authed])
    async def delete_project(project_id: ProjectId) -> dict:
        if not store.delete(project_id):
            raise HTTPException(status_code=404, detail="project not found")
        return {"ok": True}

    # -- jobs -------------------------------------------------------------------

    @app.get("/jobs", dependencies=[Authed])
    async def list_jobs(project_id: str | None = None) -> list[dict]:
        return [j.model_dump() for j in queue.list(project_id)]

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
        if token != config.token:
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
