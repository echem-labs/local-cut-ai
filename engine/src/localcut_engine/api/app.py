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
import re
import secrets
import statistics
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal
from urllib.parse import unquote

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
from ..backends.llm import EDIT_MAX_TOKENS, LLMScriptBackend
from ..backends.mock import MockBackend
from ..comfy import allowlist as comfy_allowlist
from ..comfy import workflows
from ..config import EngineConfig
from ..events import EventBus
from ..graph.editor import EDIT_SYSTEM_PROMPT, EditPlan, parse_edit_plan
from ..graph.model import NODE_ID_PATTERN, NodeKind
from ..graph.patch import PatchOp
from ..graph.template_io import TemplateError, cloud_models, from_template
from ..hardware.probe import probe_hardware
from ..jobs.models import JOB_ID_PATTERN
from ..jobs.queue import JobQueue
from ..jobs.scheduler import Scheduler
from ..manifest.capability import installed_comfy_kinds, installed_comfy_models
from ..manifest.custom import TASK_DESTS, add_custom_model, remove_custom_model
from ..manifest.defaults import (
    DEFAULTABLE_TASKS,
    DefaultsTooNew,
    load_defaults,
    set_default,
)
from ..manifest.loader import load_manifest
from ..manifest.manager import DownloadManager, ManifestError
from ..manifest.recommend import recommend_slate
from ..providers.registry import configured_providers, textgen_for_model
from ..providers.textgen import ProviderError
from ..project.store import PROJECT_ID_PATTERN, ProjectStore, ProjectTooNew
from ..service import (
    CLOUD_SPEND_ALLOWED,
    CloudSpendRefused,
    ConflictError,
    ProjectService,
    cloud_text_refusal,
)
from ..storage import clear_caches, compute_storage

logger = logging.getLogger(__name__)

# The WebSocket subprotocol that carries the bearer token. Browsers cannot set
# headers on a WebSocket, and a ?token= query parameter gets logged (see the
# /ws route and install_log_redaction). The client offers two protocols —
# this marker and then the token — and the server echoes the marker back.
WS_TOKEN_SUBPROTOCOL = "localcut.bearer.v1"

# Any `token=…` in a log record, whatever the surrounding text. Applied to
# uvicorn's loggers, where the WebSocket handshake line lands.
_TOKEN_IN_TEXT = re.compile(r"(token=)[^&\s\"']+")


class _RedactTokens(logging.Filter):
    """Scrub `token=…` out of log records rather than trusting every emitter
    not to include one. uvicorn logs `"WebSocket /ws?token=… [accepted]"` at
    INFO on `uvicorn.error` — which `access_log=False` does not silence — so
    without this the live engine token is written to journald, Docker logs,
    and any log a user is asked to attach to a bug report."""

    def filter(self, record: logging.LogRecord) -> bool:
        # This filter is installed on loggers we do not own, so it must never
        # be able to break a record: a raising or malformed record is dropped
        # by logging with a traceback of its own, which is both noisy and a
        # silent hole in the very output we are trying to sanitize.
        #
        # The token can be in either half. uvicorn's real handshake line puts
        # it in the args (`'%s - "WebSocket %s"'`, path), but an emitter is
        # free to bake it into the format string instead.
        # Tuple args only. `%`-style dict args (`log.info("%(a)s", {...})`)
        # are stored as the bare dict, and wrapping one in a tuple makes
        # getMessage() raise "format requires a mapping".
        #
        # The `any(...)` pre-check keeps this off the hot path: the filter is
        # installed on the ROOT handlers, so it sees every record the process
        # emits, and rebuilding the args tuple through a regex for all of them
        # costs far more than the substring scan that proves it unnecessary.
        if isinstance(record.args, tuple) and any(
            isinstance(a, str) and "token=" in a for a in record.args
        ):
            record.args = tuple(
                _TOKEN_IN_TEXT.sub(r"\1[redacted]", a) if isinstance(a, str) else a
                for a in record.args
            )
        if not isinstance(record.msg, str) or "token=" not in record.msg:
            return True
        if not record.args:
            record.msg = _TOKEN_IN_TEXT.sub(r"\1[redacted]", record.msg)
            return True
        # A token in the format string AND args to interpolate. Redacting the
        # format string in place can swallow a `%s` that sits inside the token
        # run ("…token=%s"), leaving more args than placeholders — so render
        # first, then redact the result. Only records that actually carry a
        # token take this path; everything else keeps its lazy formatting.
        try:
            rendered = record.getMessage()
        except Exception:  # noqa: BLE001 — a bad record is the emitter's problem
            return True
        record.msg = _TOKEN_IN_TEXT.sub(r"\1[redacted]", rendered)
        record.args = ()
        return True


def install_log_redaction() -> None:
    """Attach the token filter to everything that can carry a request line.

    Loggers AND their handlers, because the two see different records. A
    filter on a Logger runs only for records logged directly to it —
    propagation calls the ancestors' HANDLERS, not their filters — so
    attaching to `uvicorn` alone does nothing for `uvicorn.*` children, and a
    token logged by, say, `uvicorn.protocols.websockets` would sail straight
    past. Handler filters do run on propagated records, so covering the
    handlers is what makes this hold for loggers not named here.

    Idempotent, and worth calling twice: uvicorn installs its handlers when
    its Config is constructed, so an early call catches the loggers and a
    later one catches the handlers.
    """

    def attach(target: logging.Logger | logging.Handler) -> None:
        if not any(isinstance(f, _RedactTokens) for f in target.filters):
            target.addFilter(_RedactTokens())

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "websockets.server"):
        logger_ = logging.getLogger(name)
        attach(logger_)
        for handler in logger_.handlers:
            attach(handler)
    for handler in logging.getLogger().handlers:
        attach(handler)


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


# Newest completed renders considered per (kind, quality) when computing the
# calibrated ETA — enough to smooth run-to-run variance, few enough that a
# GPU/driver/model change stops dominating the estimate within a session.
_ETA_SAMPLES_PER_KEY = 20

_FILENAME_SLUG_MAX = 60
# Bound on reading a screenplay back for its title. Screenplays are a few KB;
# anything past this is not one, and serving must never block on a large read.
_FILENAME_PEEK_BYTES = 256 << 10


def _slugify(title: str) -> str:
    """Runs of anything that is not ASCII alphanumeric collapse to one dash.
    The trailing strip runs twice on purpose: once for the tail of the title,
    again in case the length cap cut mid-run."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:_FILENAME_SLUG_MAX].rstrip("-")


def download_stem(project) -> str:  # noqa: ANN001 — Project, imported for typing only downstream
    """The filename stem a project's downloads share. The id is the fallback,
    not the default: `2455ff9ec4.fcpxml` in a Downloads folder names nothing
    the user can recognise a week later."""
    return _slugify(project.title) or project.id


def artifact_filename(title: str, path: Path, output_hash: str) -> str:
    """The filename a served artifact downloads as: a slug of the project
    title plus the artifact's real suffix. The store keys artifacts by output
    hash, and without a name of our own that hash is what a browser's
    save dialog shows. Screenplays are named after the title *inside* them —
    the script model already wrote a better one than the prompt — and any
    problem reading it falls back to the project title, never to a 500: a
    worse filename must not cost the download."""
    suffix = path.name.removeprefix(output_hash)
    if suffix.endswith(".screenplay.json"):
        try:
            with path.open(encoding="utf-8") as fh:
                doc = json.loads(fh.read(_FILENAME_PEEK_BYTES))
            title = str(doc.get("title") or title)
        except (OSError, ValueError, AttributeError):
            pass
    slug = _slugify(title) or output_hash[:12]
    return f"{slug}{suffix}"


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


def _llm_default_reader(config: EngineConfig):
    """The persisted text.llm default as a live read — the picker can change
    it mid-session and the next script job must see it. A defaults file
    from a newer build refuses on its own routes; script jobs fall back to
    the engine-config model instead of failing."""

    def read() -> str | None:
        try:
            return load_defaults(config).get("text.llm")
        except DefaultsTooNew:
            return None

    return read


def _build_backends(config: EngineConfig) -> BackendRegistry:
    """Build the backend chain from config; first registered wins per node
    kind, so e.g. `comfy,mock` = real images/clips, mock everything else."""
    registry = BackendRegistry()
    chain = config.backend_chain
    # Mock may stand in for a real assembly backend ONLY in an explicit
    # all-mock chain (the demo/test configuration). In any hybrid chain it
    # would be covering for a missing ffmpeg, and a placeholder MP4 handed
    # over as a finished export is worse than a clear failure.
    mock_assembly = chain == ["mock"]
    for name in chain:
        match name:
            case "mock":
                registry.register(MockBackend(assembly=mock_assembly))
            case "llm":
                registry.register(
                    LLMScriptBackend(
                        base_url=config.llm_url,
                        model=config.llm_model,
                        timeout_s=config.llm_timeout_s,
                        default_model=_llm_default_reader(config),
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
                        # The same function the import routes write through.
                        # A repeated literal was the only thing joining "where
                        # an import lands" to "where the backend looks", so
                        # moving one would have sent every import somewhere
                        # renders never read, with nothing failing.
                        templates_dir=workflows.templates_dir(config.data_dir),
                        kinds=(
                            "keyframe,thumbnail,clip,music" if auto_kinds else config.comfy_kinds
                        ),
                        model_templates=model_templates,
                        capability=(
                            (
                                lambda: (
                                    installed_comfy_kinds(config)
                                    if comfy_probe.available()
                                    else set()
                                )
                            )
                            if auto_kinds
                            else None
                        ),
                        # Same source the capability claim reads: the template
                        # substituted into must belong to a model that is
                        # actually installed, or the kind is claimed on one
                        # model's weights and rendered with another's graph.
                        installed_models=lambda: installed_comfy_models(config),
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
        # Reclaim directories a previous delete could not finish (engine
        # exited mid-sweep, or a backend held a file open). Nothing can be
        # writing into them now, and they are invisible to the project list,
        # so they would otherwise be disk the user can never see or reclaim.
        reclaimed = await asyncio.to_thread(service.sweep_deleted)
        if reclaimed:
            logger.info("reclaimed %d partially-deleted project(s)", reclaimed)
        # A quick tool session that finished under an older build carries
        # none of the meta the history list reads, and nothing would ever
        # write it: a refresh only happens on a write, and a finished session
        # is never written again. Off the event loop -- one graph load per
        # session that still lacks the field.
        backfilled = await asyncio.to_thread(service.backfill_tool_metas)
        if backfilled:
            logger.info("backfilled meta for %d quick tool session(s)", backfilled)
        scheduler.start()
        yield
        await downloads.shutdown()
        await scheduler.stop()
        queue.close()

    app = FastAPI(title="LocalCut Engine", version=__version__, lifespan=lifespan)

    # -- body cap (must run BEFORE auth) --------------------------------------
    #
    # FastAPI parses the request body before route dependencies run, so an
    # unauthenticated client — any LAN peer, or any web page that can reach
    # the loopback port — could stream an arbitrarily large body into memory
    # and never present a token: the 401 is decided after the damage. This is
    # raw ASGI, ahead of the app, so it sees bytes before any parsing.
    #
    # Two limits: a tight one for anyone who has not presented the token, and
    # a generous one for authenticated uploads (`upload_asset` streams with
    # its own 50 MB cap, so this only has to stop the pathological case).
    _UNAUTH_MAX_BODY = 64 << 10  # 64 KiB — larger than any legitimate route body
    _AUTHED_MAX_BODY = 256 << 20  # 256 MiB

    def _presented_token(scope) -> str | None:
        for raw_key, raw_value in scope.get("headers", []):
            if raw_key == b"authorization":
                value = raw_value.decode("latin-1")
                if value.startswith("Bearer "):
                    return value.removeprefix("Bearer ")
        query = scope.get("query_string", b"").decode("latin-1")
        for pair in query.split("&"):
            key, _, value = pair.partition("=")
            if key == "token":
                return unquote(value)
        return None

    class BodyLimitMiddleware:
        def __init__(self, app) -> None:
            self.app = app

        async def __call__(self, scope, receive, send) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            limit = _AUTHED_MAX_BODY if token_ok(_presented_token(scope)) else _UNAUTH_MAX_BODY
            # Trust content-length when it is present and already over: reject
            # before reading a single byte.
            declared = 0
            for raw_key, raw_value in scope.get("headers", []):
                if raw_key == b"content-length":
                    try:
                        declared = int(raw_value)
                    except ValueError:
                        declared = 0
            if declared > limit:
                await _reject(send, limit)
                return

            received = 0
            over = False

            async def guarded_receive():
                nonlocal received, over
                message = await receive()
                if message["type"] == "http.request":
                    received += len(message.get("body", b""))
                    if received > limit:
                        over = True
                        # Starve the app: hand it an empty final chunk so it
                        # unwinds instead of awaiting a body that never ends.
                        return {"type": "http.request", "body": b"", "more_body": False}
                return message

            sent_start = False

            async def guarded_send(message):
                nonlocal sent_start
                if over and not sent_start:
                    # The app produced a response for a body we truncated;
                    # replace it with the honest 413.
                    if message["type"] == "http.response.start":
                        sent_start = True
                        await _reject(send, limit)
                    return
                if over:
                    return  # swallow the app's body for the response we replaced
                if message["type"] == "http.response.start":
                    sent_start = True
                await send(message)

            await self.app(scope, guarded_receive, guarded_send)

    async def _reject(send, limit: int) -> None:
        body = json.dumps({"detail": f"request body exceeds the {limit} byte limit"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    app.add_middleware(BodyLimitMiddleware)

    class CloudSpendMiddleware:
        """Let a client declare that it may not spend the user's BYOK keys.

        A header rather than a body field so it covers every route at once,
        including ones written later - the point of moving this rule to the
        queue was that per-route opt-ins are what kept leaking. Absent, the
        answer is "allowed", so the app and the CLI are unaffected; the MCP
        server sends it on every request it makes.

        Deliberately NOT BaseHTTPMiddleware: that runs the rest of the app
        in a separate task, and a ContextVar set there would not be visible
        to the endpoint. A plain ASGI wrapper shares the task, and each
        request gets its own context, so the value cannot leak across
        requests.
        """

        def __init__(self, app) -> None:
            self.app = app

        async def __call__(self, scope, receive, send) -> None:
            if scope["type"] == "http":
                for name, value in scope.get("headers") or []:
                    if name == b"x-localcut-cloud-spend":
                        if value.strip().lower() == b"deny":
                            CLOUD_SPEND_ALLOWED.set(False)
                        break
            await self.app(scope, receive, send)

    app.add_middleware(CloudSpendMiddleware)

    @app.exception_handler(CloudSpendRefused)
    async def _cloud_spend_refused(request: Request, exc: CloudSpendRefused) -> JSONResponse:
        """403 rather than 422: the request was well-formed and the caller is
        simply not permitted to commit this spend. Registered app-wide so
        every route that can enqueue is covered without naming any of them.
        """
        del request
        return JSONResponse(status_code=403, content={"detail": str(exc)})

    @app.exception_handler(ProjectTooNew)
    async def _project_too_new(request: Request, exc: ProjectTooNew) -> JSONResponse:
        """A project written by a newer engine is a conflict the user can fix
        (update), not a server fault. Surfacing it as a 500 would read as
        corruption and invite exactly the wrong recovery."""
        del request
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    # -- auth ---------------------------------------------------------------

    def token_ok(presented: str | None) -> bool:
        # Constant-time: the engine supports non-localhost binds, where a
        # timing oracle on an early-exit compare would leak the token.
        # Compared as BYTES: compare_digest raises TypeError on a str holding
        # any non-ASCII character, so `?token=ü` would leave auth as an
        # unhandled 500 with a traceback per request instead of a 401.
        if presented is None:
            return False
        return secrets.compare_digest(presented.encode("utf-8"), config.token.encode("utf-8"))

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

    @app.get("/llm/models", dependencies=[Authed])
    async def llm_models() -> dict:
        """Local models the script tool can offer: the configured default
        plus whatever the LLM server has installed. `available` is the
        registry's answer for SCRIPT — a live Ollama behind a mock-only
        chain still cannot honor a choice, so a picker there would lie."""

        def script_llm() -> LLMScriptBackend | None:
            # The registered instance, not a fresh one built from config: the
            # picker must enumerate the very server that will render, so a
            # chain-specific override at the registration site cannot leave
            # the two naming different models with nothing failing.
            # resolve() consults the liveness probe, so keep it off the loop
            # like every other probe caller.
            try:
                backend = backends.resolve(NodeKind.SCRIPT)
            except GenerationError:
                return None
            return backend if isinstance(backend, LLMScriptBackend) else None

        llm_default = _llm_default_reader(config)
        unavailable = {
            "available": False,
            "default": llm_default() or config.llm_model,
            "models": [],
        }
        backend = await asyncio.to_thread(script_llm)
        if backend is None:
            return unavailable
        try:
            models = await backend.list_models()
        except httpx.HTTPError:
            return unavailable
        # The effective default (persisted per-task choice, then config) —
        # what a job with no explicit model actually renders with.
        return {"available": True, "default": backend.resolve_model(None), "models": models}

    @app.get("/system/etas", dependencies=[Authed])
    async def system_etas() -> dict:
        """Calibrated render-time estimates per node kind and quality, from
        this machine's own completed jobs. Medians of the newest samples:
        medians because OOM-ladder retries and cold model loads skew a mean
        badly, newest-first so a hardware or model change ages out of the
        estimate instead of haunting it. Empty until something has rendered
        — an honest 'no data yet' beats a hand-written guess."""
        durations = await asyncio.to_thread(queue.completed_durations)
        by_key: dict[tuple[str, str], list[float]] = {}
        for kind, quality, seconds in durations:  # newest first
            samples = by_key.setdefault((kind, quality), [])
            if len(samples) < _ETA_SAMPLES_PER_KEY:
                samples.append(seconds)
        etas: dict[str, dict[str, dict]] = {}
        for (kind, quality), samples in sorted(by_key.items()):
            etas.setdefault(kind, {})[quality] = {
                "seconds": round(statistics.median(samples), 2),
                "samples": len(samples),
            }
        return {"etas": etas}

    @app.get("/models/defaults", dependencies=[Authed])
    async def model_defaults() -> dict:
        """The persisted per-task default models, plus which tasks accept
        one — the picker renders rows only for tasks the engine honors."""
        try:
            defaults = await asyncio.to_thread(load_defaults, config)
        except DefaultsTooNew as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"defaults": defaults, "tasks": list(DEFAULTABLE_TASKS)}

    class ModelDefaultBody(BaseModel):
        task: str = Field(max_length=32)
        # None/empty clears the task's default (back to engine defaults).
        model: str | None = Field(default=None, max_length=128)

    @app.put("/models/defaults", dependencies=[Authed])
    async def set_model_default(body: ModelDefaultBody) -> dict:
        try:
            defaults = await asyncio.to_thread(set_default, config, body.task, body.model)
        except DefaultsTooNew as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown model: {exc}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except OSError as exc:
            # The override manifest could not be read to validate against.
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"defaults": defaults, "tasks": list(DEFAULTABLE_TASKS)}

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
            "video.i2v",
            "video.t2v",
            "image.gen",
            "text.llm",
            "speech.tts",
            "music.gen",
            "transcribe",
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

    # -- ComfyUI workflow import (Phase 3) ------------------------------------
    #
    # Two resources, deliberately separate: the node-pack grants are a
    # machine-level trust decision, and the workflows are documents judged
    # against it. Collapsing them into one "import" call would make enabling
    # third-party code a side effect of importing a file.

    WorkflowName = Annotated[str, PathParam(pattern=workflows.NAME_PATTERN.pattern)]
    PackId = Annotated[str, PathParam(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]

    def _allowlist():
        return comfy_allowlist.current(config.data_dir)

    @app.get("/comfy/node-packs", dependencies=[Authed])
    async def list_node_packs() -> dict:
        allowlist = await asyncio.to_thread(_allowlist)
        return {
            # Shipped with every response so no client can present the enable
            # action without the sentence that has to accompany it.
            "warning": comfy_allowlist.CODE_EXECUTION_WARNING,
            "builtin_nodes": sorted(allowlist.builtin),
            "packs": [
                {
                    **pack.model_dump(),
                    "enabled": pack.id in allowlist.grants,
                    "version": allowlist.grants.get(pack.id),
                }
                for pack in allowlist.packs
            ],
        }

    class EnablePackBody(BaseModel):
        # The version installed on THIS machine. See allowlist.py: a pin to a
        # version the engine guessed would be a pin to nothing.
        version: str = Field(min_length=1, max_length=64)
        # The explicit opt-in doc 07 risk 9 requires. Named for what it
        # admits, so no client can set it without reading it.
        acknowledge_code_execution: bool = False

    @app.post("/comfy/node-packs/{pack_id}/enable", dependencies=[Authed])
    async def enable_node_pack(pack_id: PackId, body: EnablePackBody) -> dict:
        try:
            grant = await asyncio.to_thread(
                comfy_allowlist.enable_pack,
                config.data_dir,
                pack_id,
                body.version,
                acknowledged=body.acknowledge_code_execution,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc).strip("'\"")) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except OSError as exc:
            logger.warning("could not record node-pack grant: %s", exc)
            raise HTTPException(
                status_code=500, detail="could not record the grant — check engine logs"
            ) from exc
        return {"ok": True, **grant.model_dump()}

    @app.delete("/comfy/node-packs/{pack_id}", dependencies=[Authed])
    async def disable_node_pack(pack_id: PackId) -> dict:
        try:
            removed = await asyncio.to_thread(
                comfy_allowlist.disable_pack, config.data_dir, pack_id
            )
        except OSError as exc:
            logger.warning("could not revoke node-pack grant: %s", exc)
            raise HTTPException(
                status_code=500, detail="could not revoke the grant — check engine logs"
            ) from exc
        return {"ok": True, "was_enabled": removed}

    class WorkflowBody(BaseModel):
        name: str = Field(default="", max_length=64)
        workflow: dict

    def _reviewed(document: dict, name: str = "") -> tuple[dict, workflows.WorkflowReview]:
        """Parse and judge, or raise the HTTP error the client should see."""
        allowlist = _allowlist()
        try:
            parsed = workflows.parse_workflow(document)
            verdict = workflows.review(parsed, allowlist)
        except workflows.WorkflowError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # Carried on the verdict rather than raised: replacing a packaged
        # workflow is a supported thing to do, and `--check` has to be able to
        # say so BEFORE the replacement happens.
        shadow = workflows.shadow_warning(name)
        if shadow:
            verdict.warnings.append(shadow)
        if not verdict.ok:
            # 409, not 422: the document is well-formed and this engine's
            # policy is what refuses it. Enabling a pack makes the same bytes
            # acceptable, which is a conflict of state, not of syntax.
            raise HTTPException(
                status_code=409,
                detail=workflows.rejection(verdict, allowlist),
            )
        return parsed, verdict

    @app.post("/comfy/workflows/review", dependencies=[Authed])
    async def review_workflow(body: WorkflowBody) -> dict:
        """Judge a workflow without storing it — what an import would say."""
        _, verdict = await asyncio.to_thread(_reviewed, body.workflow, body.name)
        return verdict.model_dump()

    @app.post("/comfy/workflows", dependencies=[Authed])
    async def import_workflow(body: WorkflowBody) -> dict:
        parsed, verdict = await asyncio.to_thread(_reviewed, body.workflow, body.name)
        try:
            path = await asyncio.to_thread(workflows.store, config.data_dir, body.name, parsed)
        except workflows.WorkflowError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except OSError as exc:
            logger.warning("could not store workflow %r: %s", body.name, exc)
            raise HTTPException(
                status_code=500, detail="could not write the workflow — check engine logs"
            ) from exc
        return {"ok": True, "name": path.stem, **verdict.model_dump()}

    @app.get("/comfy/workflows", dependencies=[Authed])
    async def list_workflows() -> list[dict]:
        return await asyncio.to_thread(workflows.installed, config.data_dir)

    @app.delete("/comfy/workflows/{name}", dependencies=[Authed])
    async def delete_workflow(name: WorkflowName) -> dict:
        try:
            removed = await asyncio.to_thread(workflows.remove, config.data_dir, name)
        except OSError as exc:
            logger.warning("could not remove workflow %r: %s", name, exc)
            raise HTTPException(
                status_code=500, detail="could not remove the workflow — check engine logs"
            ) from exc
        if not removed:
            raise HTTPException(status_code=404, detail="unknown workflow")
        return {"ok": True}

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
        # Script only: which local model writes it (a /llm/models name,
        # optionally `local:`-prefixed). Validated like FinalizeBody's
        # clip_model — this string is persisted onto the node — plus `:` and
        # `/`, which Ollama tags use (`llama3.2:latest`, `hf.co/u/m:Q4`).
        model: str | None = Field(
            default=None, max_length=128, pattern=r"^(local:|cloud:)?[\w./:\-]+$"
        )

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
        await _get_project(project_id)
        enqueued = await asyncio.to_thread(service.approve, project_id, body.checkpoint)
        return {"ok": True, "enqueued": enqueued}

    @app.post("/projects/{project_id}/promote", dependencies=[Authed])
    async def promote(project_id: ProjectId) -> dict:
        await _get_project(project_id)
        try:
            project = await asyncio.to_thread(service.promote_tool, project_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return project.model_dump()

    @app.get("/projects", dependencies=[Authed])
    async def list_projects() -> list[dict]:
        # Off the loop: a Home poll with 60 projects globs, reads and
        # validates 60 files, and _read_text_retry's backoff is a literal
        # time.sleep (up to 0.15s per contended file — and meta rewrites are
        # frequent during a render). On the loop that stalls the /ws progress
        # fan-out and every other in-flight request.
        projects = await asyncio.to_thread(store.list)
        return [p.model_dump() for p in projects]

    async def _get_project(project_id: str):
        # Same reason: this reads meta.json through the retrying reader, and
        # nearly every route calls it.
        project = await asyncio.to_thread(store.get, project_id)
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

    # -- templates: a project's shape, portable (Phase 3) ---------------------
    #
    # Declared before the /projects/{project_id} routes so "from-template" is
    # never read as a project id. FastAPI matches in declaration order, and a
    # literal segment losing to a path param is the classic version of this
    # bug — harmless today (only POST is declared here) and not worth relying
    # on if a GET is ever added.

    class TemplateBody(BaseModel):
        """The document plus what the importer chooses about it."""

        template: dict
        title: str = Field(default="", max_length=120)

    @app.post("/projects/from-template", dependencies=[Authed])
    async def create_from_template(body: TemplateBody) -> dict:
        try:
            # Off the loop like every other heavy call here: validating a
            # 500-node document re-encodes it to measure its size and then
            # runs an O(nodes x edges) topological sort, which is long enough
            # to stall the /ws progress fan-out and every in-flight request.
            template = await asyncio.to_thread(from_template, body.template)
        except TemplateError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        project = await asyncio.to_thread(service.create_from_template, template, title=body.title)
        return {
            "project": project.model_dump(),
            # Surfaced, never blocked on: rendering these spends the
            # importer's money on the author's choice of provider, so it has
            # to be visible before the first render rather than on the bill.
            "cloud_models": cloud_models(template),
            "dropped_assets": template.dropped_assets,
        }

    @app.get("/projects/{project_id}/template", dependencies=[Authed])
    async def export_template(
        project_id: ProjectId,
        name: Annotated[str, Query(max_length=120)] = "",
        description: Annotated[str, Query(max_length=2000)] = "",
    ) -> dict:
        await _get_project(project_id)
        try:
            return await asyncio.to_thread(
                service.export_template, project_id, name=name, description=description
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="project not found") from None

    @app.get("/projects/{project_id}", dependencies=[Authed])
    async def get_project(project_id: ProjectId) -> dict:
        project = await _get_project(project_id)
        # Board building reads sqlite + scans generated/ — keep it off the
        # loop that serves /ws progress fan-out.
        board = await asyncio.to_thread(service.scene_board, project_id)
        return {"project": project.model_dump(), "board": board}

    @app.get("/projects/{project_id}/graph", dependencies=[Authed])
    async def get_graph(project_id: ProjectId) -> dict:
        await _get_project(project_id)
        graph = await asyncio.to_thread(store.load_graph, project_id)
        return graph.model_dump()

    _IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
    _AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a"}
    # .mp4 only — what the engine's own clip artifacts are, so a tool
    # session's output can be added to another project through this door.
    _VIDEO_EXTENSIONS = {".mp4"}
    _ASSET_MAX_BYTES = 50 << 20

    @app.post("/projects/{project_id}/assets", dependencies=[Authed])
    async def upload_asset(
        project_id: ProjectId,
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=128)],
        consent: bool = False,
    ) -> dict:
        """Import a user asset (raw bytes body) as a graph node — images
        condition clips ('use my image as the shot source'); video and
        audio arrive as plain assets (a session output added to a project,
        a music bed). Audio uploaded WITH the consent affirmation is a
        voice sample for cloning: consent gates the `voice_consent` stamp
        here, at the only place it can be minted, and the voice_ref
        chokepoint (graph/patch.py) refuses any asset without it — so no
        unconsented voice can ever reach the TTS backend, while an
        unconsented music bed is not asked a question that isn't its."""
        await _get_project(project_id)
        name = PurePosixPath(filename.replace("\\", "/")).name  # basename only, no paths
        suffix = PurePosixPath(name).suffix.lower()
        accepted = _IMAGE_EXTENSIONS | _AUDIO_EXTENSIONS | _VIDEO_EXTENSIONS
        if suffix not in accepted:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported asset type {suffix!r} — one of: "
                f"{', '.join(sorted(accepted))}",
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
        # voice=True only for audio WITH the affirmation — the one place
        # `voice_consent` can be minted.
        return await asyncio.to_thread(
            service.add_asset, project_id, name, data, suffix in _AUDIO_EXTENSIONS and consent
        )

    class PatchBody(BaseModel):
        ops: list[PatchOp]

    @app.post("/projects/{project_id}/patch", dependencies=[Authed])
    async def patch_project(project_id: ProjectId, body: PatchBody) -> dict:
        await _get_project(project_id)
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
        # Propose-then-act: preview the compiled plan without committing it.
        # The response carries the plan and the graph revision it was built
        # against, which /edit/apply takes to land it later.
        dry_run: bool = False

    @app.post("/projects/{project_id}/edit", dependencies=[Authed])
    async def edit_project(project_id: ProjectId, body: EditBody) -> dict:
        """Natural-language edit: the LLM sees the whitelisted graph view,
        returns an edit plan, and the plan compiles into ordinary patch ops."""
        await _get_project(project_id)
        if body.model is not None and not body.model.startswith("cloud:"):
            raise HTTPException(status_code=422, detail="edit model must be a cloud:* text model")
        if body.model and not CLOUD_SPEND_ALLOWED.get():
            # The same rule the queue enforces for renders, applied to the one
            # spend that never reaches the queue: this route calls the BYOK
            # text provider inline, on the request path. The MCP tool refuses
            # a cloud model of its own accord, but that is a client-side gate
            # over a route, which is precisely the shape that leaked three
            # times before the rule was moved to the outcome.
            raise cloud_text_refusal(body.model)
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
            # Same explicit cap on both paths: an edit plan is a short list of
            # ops, and a silent truncation here surfaces as "the model
            # returned an invalid edit plan" rather than "it ran out of room".
            if body.model:
                raw = await cloud_gen.complete(
                    system=EDIT_SYSTEM_PROMPT, prompt=prompt, max_tokens=EDIT_MAX_TOKENS
                )
            else:
                # Interactive path onto the same local server as script jobs,
                # with the same VRAM-yield discipline (Ollama serializes
                # concurrent requests internally).
                raw = await LLMScriptBackend(
                    base_url=config.llm_url,
                    model=config.llm_model,
                    timeout_s=config.llm_timeout_s,
                    default_model=_llm_default_reader(config),
                ).complete(prompt, system=EDIT_SYSTEM_PROMPT, max_tokens=EDIT_MAX_TOKENS)
            plan = parse_edit_plan(raw)
        except (ProviderError, GenerationError, ValueError, httpx.HTTPError) as exc:
            # The model or its transport failed us, not the client.
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        try:
            if body.dry_run:
                result = await asyncio.to_thread(
                    service.preview_edit_plan, project_id, plan, body.scope, view.get("revision")
                )
                return {
                    "summary": plan.summary,
                    "plan": plan.model_dump(),
                    "revision": view.get("revision"),
                    **result,
                }
            result = await asyncio.to_thread(
                service.apply_edit_plan, project_id, plan, body.scope, view.get("revision")
            )
        except ConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"summary": plan.summary, **result}

    class EditApplyBody(BaseModel):
        plan: EditPlan
        scope: str = Field(default="project", pattern=NODE_ID_PATTERN)
        # The revision the plan was previewed against — the same stale-plan
        # refusal /edit itself uses when the graph moves mid-flight.
        revision: str | None = None

    @app.post("/projects/{project_id}/edit/apply", dependencies=[Authed])
    async def edit_apply(project_id: ProjectId, body: EditApplyBody) -> dict:
        """Second half of propose-then-act: land a plan a dry-run /edit
        returned, without a second LLM round trip. The plan is a client
        document here, but compile_edits re-validates every part of it
        against the whitelist exactly as it does the LLM's own output."""
        await _get_project(project_id)
        try:
            result = await asyncio.to_thread(
                service.apply_edit_plan, project_id, body.plan, body.scope, body.revision
            )
        except ConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"summary": body.plan.summary, **result}

    class EnhanceBody(BaseModel):
        notes: str = Field(min_length=1, max_length=2000)

    @app.post("/projects/{project_id}/script/enhance", dependencies=[Authed])
    async def enhance_script(project_id: ProjectId, body: EnhanceBody) -> dict:
        """Rewrite the script from user feedback. Internally a /patch on the
        script node (feedback + the screenplay it amends), so the re-render
        inherits the chokepoint's guarantees instead of a private path."""
        await _get_project(project_id)
        if not body.notes.strip():
            raise HTTPException(status_code=422, detail="feedback is empty")
        try:
            dirty = await asyncio.to_thread(service.enhance_script, project_id, body.notes)
        except (ValueError, KeyError) as exc:
            # KeyError: the script node was removed between the artifact read
            # and the patch. A lost race is still "there is nothing to
            # enhance", not a server fault.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"ok": True, "dirty": sorted(dirty)}

    class RegenerateBody(BaseModel):
        seed: int | None = None

    @app.post("/projects/{project_id}/nodes/{node_id}/regenerate", dependencies=[Authed])
    async def regenerate(project_id: ProjectId, node_id: NodeId, body: RegenerateBody) -> dict:
        await _get_project(project_id)
        try:
            await asyncio.to_thread(service.regenerate, project_id, node_id, body.seed)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown node: {exc}") from exc
        return {"ok": True}

    # -- undo/redo & save points --------------------------------------------

    @app.get("/projects/{project_id}/history", dependencies=[Authed])
    async def project_history(project_id: ProjectId) -> dict:
        """Stack depths, the descriptors of the next undo/redo step, and the
        save point list — never the snapshots themselves (each one is a whole
        graph, and this is polled alongside the board)."""
        await _get_project(project_id)
        return await asyncio.to_thread(service.history_info, project_id)

    @app.post("/projects/{project_id}/undo", dependencies=[Authed])
    async def undo_project(project_id: ProjectId) -> dict:
        await _get_project(project_id)
        try:
            return await asyncio.to_thread(service.undo, project_id)
        except ConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            # The snapshot failed the restore gate (cycle / consent) — the
            # stored history is bad, not the server.
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/projects/{project_id}/redo", dependencies=[Authed])
    async def redo_project(project_id: ProjectId) -> dict:
        await _get_project(project_id)
        try:
            return await asyncio.to_thread(service.redo, project_id)
        except ConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    class SavePointBody(BaseModel):
        label: str = Field(min_length=1, max_length=80)

    SavePointId = Annotated[str, PathParam(pattern=r"^sp\d{1,9}$")]

    @app.post("/projects/{project_id}/savepoints", dependencies=[Authed])
    async def create_savepoint(project_id: ProjectId, body: SavePointBody) -> dict:
        await _get_project(project_id)
        try:
            return await asyncio.to_thread(service.create_savepoint, project_id, body.label)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/projects/{project_id}/savepoints/{savepoint_id}/restore", dependencies=[Authed])
    async def restore_savepoint(project_id: ProjectId, savepoint_id: SavePointId) -> dict:
        await _get_project(project_id)
        try:
            return await asyncio.to_thread(service.restore_savepoint, project_id, savepoint_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown save point: {exc}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/projects/{project_id}/savepoints/{savepoint_id}", dependencies=[Authed])
    async def delete_savepoint(project_id: ProjectId, savepoint_id: SavePointId) -> dict:
        await _get_project(project_id)
        try:
            await asyncio.to_thread(service.delete_savepoint, project_id, savepoint_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown save point: {exc}") from exc
        return {"ok": True}

    class FinalizeBody(BaseModel):
        # The shell's Settings → Defaults video model; absent/None falls back
        # to the engine-configured final_clip_model. Validated: an unbounded
        # free string here is written to every unpinned clip node's model and
        # persisted, so a garbage value would corrupt the saved graph.
        clip_model: str | None = Field(
            default=None, max_length=128, pattern=r"^$|^(local:|cloud:)?[\w.\-]+$"
        )

    @app.post("/projects/{project_id}/render", dependencies=[Authed])
    async def render(project_id: ProjectId) -> dict:
        """Enqueue whatever the graph still owes, at draft quality — the
        draft-side counterpart of /finalize, and what a headless caller
        means by "render this". An empty /patch does NOT do this: it
        re-plans only when an op dirtied something."""
        await _get_project(project_id)
        return {"enqueued": await asyncio.to_thread(service.render, project_id)}

    @app.post("/projects/{project_id}/finalize", dependencies=[Authed])
    async def finalize(project_id: ProjectId, body: FinalizeBody | None = None) -> dict:
        await _get_project(project_id)
        clip_model = (body.clip_model if body else None) or config.final_clip_model
        return {"enqueued": await asyncio.to_thread(service.finalize, project_id, clip_model)}

    @app.post("/projects/{project_id}/package", dependencies=[Authed])
    async def package(project_id: ProjectId) -> dict:
        await _get_project(project_id)
        try:
            nodes = await asyncio.to_thread(service.package, project_id)
        except LookupError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"nodes": nodes}

    @app.get("/projects/{project_id}/export/otio", dependencies=[Authed])
    async def export_otio(project_id: ProjectId) -> JSONResponse:
        project = await _get_project(project_id)
        try:
            document = await asyncio.to_thread(service.export_otio, project_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return JSONResponse(
            document,
            headers={
                "Content-Disposition": f'attachment; filename="{download_stem(project)}.otio"'
            },
        )

    @app.get("/projects/{project_id}/export/fcpxml", dependencies=[Authed])
    async def export_fcpxml(project_id: ProjectId) -> Response:
        project = await _get_project(project_id)
        try:
            document = await asyncio.to_thread(service.export_fcpxml, project_id)
        except (LookupError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return Response(
            document,
            media_type="application/xml",
            headers={
                "Content-Disposition": f'attachment; filename="{download_stem(project)}.fcpxml"'
            },
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
        project = await _get_project(project_id)

        def resolve_and_name() -> tuple[Path, str] | None:
            # One hop, not two: the player issues one of these per range
            # request while scrubbing, and a bare to_thread round trip costs
            # an order of magnitude more than the naming it would offload.
            # The scan and the screenplay peek both stay off the loop.
            path = store.resolve_artifact(project_id, output_hash)
            if path is None:
                return None
            return path, artifact_filename(project.title, path, output_hash)

        resolved = await asyncio.to_thread(resolve_and_name)
        if resolved is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        path, filename = resolved
        # inline, not attachment: this same route feeds <video>/<audio>
        # playback — the header exists purely to name the file when the
        # desktop's bare <a download> saves it (the engine is another origin,
        # so a client-side download="name" would be ignored).
        return FileResponse(path, filename=filename, content_disposition_type="inline")

    # A dedicated decoder instance rather than a chain lookup: the chain may
    # not include an ffmpeg backend at all (all-mock demo config), and peaks
    # are a read-model concern, not a render.
    peaks_decoder = FFmpegBackend(ffmpeg_bin=config.resolved_ffmpeg_bin)

    @app.get("/projects/{project_id}/artifacts/{output_hash}/peaks", dependencies=[Authed])
    async def artifact_peaks(
        project_id: ProjectId,
        output_hash: OutputHash,
        bins: Annotated[int, Query(ge=16, le=4096)] = 512,
    ) -> dict:
        """Waveform peaks for an audio artifact — the audio-lane shape,
        computed engine-side once instead of every client decoding whole
        tracks through WebAudio. Cached per (artifact, bins) in cache/,
        which storage cleanup may drop at any time (it just recomputes)."""
        await _get_project(project_id)
        path = await asyncio.to_thread(store.resolve_artifact, project_id, output_hash)
        if path is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        cache_file = store.project_dir(project_id) / "cache" / f"peaks-{output_hash}-{bins}.json"
        if cache_file.exists():
            try:
                return json.loads(await asyncio.to_thread(cache_file.read_text, "utf-8"))
            except (json.JSONDecodeError, OSError):
                pass  # torn or swept mid-read — recompute below
        try:
            result = await peaks_decoder.audio_peaks(path, bins)
        except GenerationError as exc:
            # The ffmpeg binary itself is missing — an install problem, not
            # a property of this artifact.
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if result is None:
            raise HTTPException(status_code=422, detail="artifact is not decodable audio")
        payload = {"bins": bins, **result}

        def cache_write() -> None:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            # Plain write on purpose: a torn cache entry is recomputed by the
            # JSONDecodeError path above, so the atomic-writer ceremony state
            # files need would buy nothing here.
            cache_file.write_text(json.dumps(payload), encoding="utf-8")

        await asyncio.to_thread(cache_write)
        return payload

    # -- events (progress streaming end to end) --------------------------

    @app.websocket("/ws")
    async def ws_events(websocket: WebSocket, token: str | None = None) -> None:
        # Preference order: subprotocol, then Authorization, then ?token=.
        #
        # The subprotocol carries the token for browser clients, which cannot
        # set request headers on a WebSocket. A query parameter can: uvicorn
        # logs the handshake path at INFO on the `uvicorn.error` logger — a
        # logger `access_log=False` does not silence — so a ?token= lands in
        # journald, in Docker logs, and in any log a user attaches to a bug
        # report. `install_log_redaction()` scrubs it for clients still on the
        # query form; new clients never put it there in the first place.
        presented = token
        offered = [
            part.strip()
            for part in websocket.headers.get("sec-websocket-protocol", "").split(",")
            if part.strip()
        ]
        subprotocol: str | None = None
        if len(offered) == 2 and offered[0] == WS_TOKEN_SUBPROTOCOL:
            presented, subprotocol = offered[1], WS_TOKEN_SUBPROTOCOL
        else:
            authorization = websocket.headers.get("authorization", "")
            if authorization.startswith("Bearer "):
                presented = authorization.removeprefix("Bearer ")
        if not token_ok(presented):
            await websocket.close(code=4401)
            return
        # A server that does not echo a subprotocol the client offered makes
        # the browser fail the handshake, so echo it back when it was used.
        await websocket.accept(subprotocol=subprotocol)
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
