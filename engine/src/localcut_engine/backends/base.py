"""ExecutionBackend — the swappable seam in front of every runtime
(headless ComfyUI, llama.cpp, FFmpeg, cloud providers, mocks). ComfyUI is
wrapped behind this from day one so a future in-house backend is a drop-in.
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from ..graph.compiler import JobSpec
from ..graph.model import NodeKind


class GenerationError(RuntimeError):
    pass


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
            raise GenerationError(
                f"cloud model {model!r} is not available for {kind.value} nodes"
            )
        for backend in self._backends:
            if backend.supports(kind) and backend.serves_model(model):
                return backend
        detail = f" with model {model!r}" if model else ""
        raise GenerationError(f"no backend registered for node kind: {kind}{detail}")
