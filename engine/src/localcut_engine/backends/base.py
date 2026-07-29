"""ExecutionBackend — the swappable seam in front of every runtime
(headless ComfyUI, llama.cpp, FFmpeg, cloud providers, mocks). ComfyUI is
wrapped behind this from day one so a future in-house backend is a drop-in.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..notices import NOTICE_CODES, Notice


logger = logging.getLogger(__name__)


class GenerationError(RuntimeError):
    pass


class ServiceProbe:
    """TTL-cached liveness of a companion server (Ollama, ComfyUI), so a
    backend can decline kinds its server cannot currently serve and let the
    chain's fallbacks catch them.

    supports() hooks are sync and run ON THE EVENT LOOP (the scheduler and
    the API both call BackendRegistry.resolve), so refreshes happen on a
    worker thread and available() answers from cache. A blocking probe here
    freezes the whole engine every TTL when the server is unreachable —
    dropped SYNs burn the full timeout, and a hostname whose DNS is down
    stalls in getaddrinfo for far longer than any timeout we pass.

    The very first answer is probed synchronously: that call lands during
    startup, and guessing "down" there would route real work to the mock
    backend and write placeholder artifacts into a real project."""

    def __init__(self, url: str, timeout_s: float = 0.75, ttl_s: float = 15.0) -> None:
        self.url = url
        self.timeout_s = timeout_s
        self.ttl_s = ttl_s
        self._checked_at: float | None = None
        self._alive = False
        # A Condition, not a Lock: callers that arrive while the FIRST probe
        # is still running have to wait for its verdict (see available()).
        self._lock = threading.Condition()
        self._refreshing = False

    def _refresh(self) -> None:
        try:
            alive = httpx.get(self.url, timeout=self.timeout_s).status_code < 500
        except httpx.HTTPError:
            alive = False
        except Exception:  # a resolver/socket error the client didn't wrap
            alive = False
        with self._lock:
            self._alive = alive
            self._checked_at = time.monotonic()
            self._refreshing = False
            self._lock.notify_all()

    def available(self) -> bool:
        with self._lock:
            # Someone else is producing the first verdict — wait for it rather
            # than answer from the uninitialized default. Returning False here
            # is exactly the "route real work to the mock backend and write
            # placeholder artifacts into a real project" outcome the
            # synchronous first probe exists to prevent. The timeout is a
            # backstop against a lost notify, never the expected path.
            while self._checked_at is None and self._refreshing:
                self._lock.wait(timeout=self.timeout_s + 5.0)
            first = self._checked_at is None
            fresh = not first and time.monotonic() - self._checked_at < self.ttl_s
            if fresh or self._refreshing:
                return self._alive
            self._refreshing = True
        if first:
            self._refresh()  # startup: the first verdict must be real
        else:
            try:
                threading.Thread(target=self._refresh, daemon=True).start()
            except RuntimeError:
                # Thread exhaustion, or interpreter shutdown. _refresh is the
                # only thing that clears the flag, so leaving it latched would
                # freeze this verdict for the life of the process — a server
                # that came back up would be reported down forever.
                with self._lock:
                    self._refreshing = False
        with self._lock:
            return self._alive


class OOMError(GenerationError):
    """VRAM exhaustion — triggers the fallback ladder."""


ProgressFn = Callable[[float], Awaitable[None]]


@dataclass
class ExecutionContext:
    """Everything a backend may touch. Backends never reach into project
    internals; they read input artifacts and write one output artifact."""

    output_dir: Path  # project generated/ directory
    input_artifacts: dict[str, Path] = field(default_factory=dict)  # port -> path
    report_progress: ProgressFn | None = None
    # Non-fatal signals for the user, collected during execute and persisted
    # onto the job by the scheduler when the job completes. A notice on a
    # failed attempt dies with it: the retry re-emits or the error dominates.
    notices: list[Notice] = field(default_factory=list)
    # The model that actually produced the artifact, reported by the backend
    # at execute time and persisted with the finished job. spec.model is the
    # *request* (usually None = "the configured default"), and config changes
    # between runs — this is the only record of what really ran.
    model_used: str | None = None

    def record_model(self, name: str) -> None:
        self.model_used = name

    def notify(self, code: str, **data: bool | int | float | str) -> None:
        """Record something the user should know about a job that will still
        finish.

        An unregistered code is dropped with a log line rather than raised:
        it means the emit site and the catalog have drifted (which
        test_ui_contract catches), and an advisory must never break the render
        it is advising about — that would trade a missing sentence for a
        missing video."""
        if code not in NOTICE_CODES:
            logger.warning("dropping notice with unregistered code %r", code)
            return
        self.notices.append(Notice(code=code, data=data))

    def output_path(self, output_hash: str, suffix: str) -> Path:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        return self.output_dir / f"{output_hash}{suffix}"

    def publish_bytes(self, output_hash: str, suffix: str, data: bytes) -> Path:
        """Write an artifact atomically: build in a temp file on the SAME
        filesystem, then rename into place. A crash mid-write must never leave
        a truncated `{hash}{suffix}` that the existence-cache then serves as a
        valid render forever. The leading-dot temp name is not matched by the
        flat `{hash}.*` artifact scan."""
        out = self.output_path(output_hash, suffix)
        tmp = out.with_name(f".partial-{uuid.uuid4().hex}{suffix}")
        try:
            tmp.write_bytes(data)
            tmp.replace(out)
        finally:
            tmp.unlink(missing_ok=True)
        return out

    def publish_text(self, output_hash: str, suffix: str, text: str) -> Path:
        return self.publish_bytes(output_hash, suffix, text.encode())

    @contextmanager
    def publishing(self, output_hash: str, suffix: str) -> Iterator[Path]:
        """publish_bytes for producers that write the file themselves (ffmpeg,
        soundfile): yields a temp path on the same filesystem and renames it
        into place only if the block completes. The temp keeps `suffix` so
        muxers that pick a format by extension still choose right.

        Handing the final path to a producer that can die mid-write is the
        bug this exists to prevent: cached_hashes() reads the cache off bare
        filenames, so a truncated `{hash}{suffix}` is served as a finished
        render forever and the node is never re-enqueued."""
        out = self.output_path(output_hash, suffix)
        tmp = out.with_name(f".partial-{uuid.uuid4().hex}{suffix}")
        try:
            yield tmp
            tmp.replace(out)
        finally:
            tmp.unlink(missing_ok=True)

    async def progress(self, fraction: float) -> None:
        if self.report_progress is not None:
            await self.report_progress(max(0.0, min(1.0, fraction)))


class ExecutionBackend(ABC):
    """One backend serves one or more node kinds."""

    name: str = "backend"

    @abstractmethod
    def supports(self, kind: NodeKind) -> bool: ...

    def serves_model(self, model: str | None) -> bool:
        """Whether this backend can honor a node's `local:*` model choice.
        Default: yes — most backends interpret the model internally (ComfyUI
        maps it to a workflow template). Specialist backends override this so
        e.g. a voice-cloning node never lands on a plain TTS backend and
        silently loses the clone."""
        del model
        return True

    @abstractmethod
    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        """Run the job, return the produced artifact path. Raise OOMError
        for VRAM failures so the scheduler can walk the fallback ladder."""


class BackendRegistry:
    def __init__(self) -> None:
        self._backends: list[ExecutionBackend] = []
        self._cloud: ExecutionBackend | None = None

    def register(self, backend: ExecutionBackend) -> None:
        self._backends.append(backend)

    def register_cloud(self, backend: ExecutionBackend) -> None:
        """The cloud backend is model-driven, not chain-driven: any node
        whose model is `cloud:*` routes here regardless of the chain."""
        self._cloud = backend

    def resolve(self, kind: NodeKind, model: str | None = None) -> ExecutionBackend:
        if model and model.startswith("cloud:"):
            # A cloud:* model is an explicit provider choice. It must route to
            # the cloud backend or fail — never silently fall through to a
            # local backend (whose default serves_model() accepts any model)
            # and hand back local output the user believes came from the cloud.
            if self._cloud is not None and self._cloud.supports(kind):
                return self._cloud
            raise GenerationError(f"cloud model {model!r} is not available for {kind.value} nodes")
        for backend in self._backends:
            if backend.supports(kind) and backend.serves_model(model):
                return backend
        if kind in (NodeKind.TIMELINE, NodeKind.EXPORT):
            # The overwhelmingly likely cause, and one the user can fix. The
            # generic message below would send them hunting through backend
            # config for what is really a missing system dependency.
            raise GenerationError(
                f"cannot assemble the {kind.value}: no working ffmpeg was found. Install "
                "ffmpeg and restart, or point LOCALCUT_FFMPEG_BIN at it."
            )
        detail = f" with model {model!r}" if model else ""
        raise GenerationError(f"no backend registered for node kind: {kind}{detail}")
