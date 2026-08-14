"""Preflight readiness — which tier will actually serve each node kind.

The backend chain degrades on purpose: a missing model routes to the
still-clip tier or to mock rather than failing jobs (see capability.py and
the chain in api.app._build_backends). What nothing did until now is SAY
so before a render is spent. This module is the one place that resolution
is turned into words: one row per (kind, model) pair with a verdict, a
stable reason code, and — where the engine knows one — a machine-actionable
fix.

The vocabulary crosses the wire as codes plus data, never English — the
notices.py discipline. The desktop translates codes through its
readiness.json catalog and mirrors the three closed sets below as TS
unions; test_ui_contract.py compares them, so adding a verdict, reason or
fix type is a two-sided change that cannot silently render as nothing.

Rows are computed from the same primitives the scheduler resolves with
(BackendRegistry.resolve, the capability probes, the persisted defaults),
never from a second copy of the routing rules — a readiness report that
drifted from what the scheduler actually does would be worse than none.

Known limitation, on purpose: a `local:chatterbox` narration row reports
ready without import-probing the chatterbox package — that import pulls
torch, far too heavy for a preflight. Clone failures stay execute-time and
loud (backends/chatterbox.py never falls back to a stock voice).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx

from .backends.base import BackendRegistry, GenerationError
from .config import EngineConfig
from .graph.model import NodeKind
from .manifest.capability import COMFY_TASKS, installed_comfy_models
from .manifest.defaults import DefaultsTooNew, load_defaults
from .manifest.downloads import is_downloaded
from .manifest.loader import load_manifest
from .providers.registry import configured_providers, provider_for_model
from .providers.textgen import ProviderError

READINESS_VERDICTS = ("ready", "degraded", "placeholder", "will_fail")

READINESS_REASONS = (
    "ok",
    "still_clip_tier",
    "no_model_installed",
    "llm_server_down",
    "llm_model_missing",
    "cloud_key_missing",
    "cloud_model_unknown",
    "comfyui_down",
    "no_ffmpeg",
)

READINESS_FIX_TYPES = ("download", "pick_model", "configure_provider", "install_ffmpeg")

# Manifest tasks whose entries can serve each kind, for the download fix.
# The ComfyUI kinds come from the capability table; the constructor-bound
# backends (kokoro, align) get theirs here because nothing else needs it.
_DOWNLOAD_TASKS: dict[NodeKind, tuple[str, ...]] = {
    **{kind: tasks for kind, tasks in COMFY_TASKS.items()},
    NodeKind.NARRATION: ("speech.tts",),
    NodeKind.CAPTIONS: ("transcribe",),
}


@dataclass
class _Snapshot:
    """One blocking read of everything row-building consults, so a
    multi-row report costs one manifest scan, not one per row."""

    entries: list = field(default_factory=list)
    defaults: dict[str, str] = field(default_factory=dict)
    installed: dict[NodeKind, list[str]] = field(default_factory=dict)


def _load_snapshot(config: EngineConfig) -> _Snapshot:
    snap = _Snapshot()
    try:
        snap.entries = list(load_manifest(config).models)
    except (OSError, ValueError):
        # A broken override manifest already surfaces on /models; readiness
        # keeps reporting with no download fixes rather than failing.
        snap.entries = []
    try:
        snap.defaults = load_defaults(config)
    except DefaultsTooNew:
        snap.defaults = {}
    snap.installed = installed_comfy_models(config)
    return snap


def _row(
    kind: NodeKind,
    *,
    verdict: str,
    reason: str,
    backend: str | None = None,
    model: str | None = None,
    data: dict | None = None,
    fix: dict | None = None,
) -> dict:
    return {
        "kind": kind.value,
        "model": model,
        "backend": backend,
        "verdict": verdict,
        "reason": reason,
        "data": data or {},
        "fix": fix,
    }


def _download_fix(snap: _Snapshot, config: EngineConfig, kind: NodeKind) -> dict | None:
    """The manifest's best downloadable candidate for a kind: the stored
    per-task default when it is downloadable, else the first entry for the
    kind's tasks with files (and, for ComfyUI kinds, a workflow template —
    weights with no graph to run them are not a capability)."""
    tasks = _DOWNLOAD_TASKS.get(kind, ())
    need_template = kind in COMFY_TASKS

    def usable(entry) -> bool:  # noqa: ANN001 — ModelEntry, typed at the manifest
        return bool(entry.files) and (bool(entry.comfy_graph_template) or not need_template)

    by_id = {entry.id: entry for entry in snap.entries}
    for task in tasks:
        preferred = by_id.get(snap.defaults.get(task, ""))
        if preferred is not None and preferred.task == task and usable(preferred):
            return _fix_for(preferred)
    for task in tasks:
        for entry in snap.entries:
            if entry.task == task and usable(entry):
                return _fix_for(entry)
    return None


def _fix_for(entry) -> dict:  # noqa: ANN001 — ModelEntry
    return {
        "type": "download",
        "model_id": entry.id,
        "size_bytes": sum(file.size for file in entry.files),
    }


def _task_of(kind: NodeKind) -> str | None:
    tasks = _DOWNLOAD_TASKS.get(kind)
    if tasks:
        return tasks[0]
    return "text.llm" if kind is NodeKind.SCRIPT else None


def _cloud_row(config: EngineConfig, backends: BackendRegistry, kind: NodeKind, model: str) -> dict:
    """cloud:* is an explicit provider choice that routes by model, never by
    chain — so the row checks what execute would die on: the key, and
    whether the cloud backend serves this kind/model at all."""
    try:
        provider = provider_for_model(model)
    except ProviderError:
        return _row(
            kind,
            verdict="will_fail",
            reason="cloud_model_unknown",
            backend="cloud",
            model=model,
            data={"model": model},
        )
    configured = {row["id"]: row["configured"] for row in configured_providers(config)}
    if not configured.get(provider):
        return _row(
            kind,
            verdict="will_fail",
            reason="cloud_key_missing",
            backend="cloud",
            model=model,
            data={"provider": provider, "model": model},
            fix={"type": "configure_provider", "provider": provider},
        )
    try:
        resolved = backends.resolve(kind, model)
    except GenerationError:
        return _row(
            kind,
            verdict="will_fail",
            reason="cloud_model_unknown",
            backend="cloud",
            model=model,
            data={"model": model},
        )
    return _row(kind, verdict="ready", reason="ok", backend=resolved.name, model=model)


def _local_row(
    snap: _Snapshot,
    config: EngineConfig,
    backends: BackendRegistry,
    kind: NodeKind,
    model: str | None,
) -> dict | tuple:
    """One row, or `(backend, resolved_model)` when the answer needs the LLM
    server's model list — the only async leg, finished by the caller."""
    task = _task_of(kind)
    data = {"task": task} if task else {}
    try:
        resolved = backends.resolve(kind, model)
    except GenerationError:
        if kind in (NodeKind.TIMELINE, NodeKind.EXPORT):
            return _row(
                kind,
                verdict="will_fail",
                reason="no_ffmpeg",
                fix={"type": "install_ffmpeg"},
            )
        return _row(
            kind,
            verdict="will_fail",
            reason="no_model_installed",
            model=model,
            data=data,
            fix=_download_fix(snap, config, kind),
        )

    name = resolved.name
    if name == "llm":
        return (resolved, resolved.resolve_model(model))

    if name == "comfyui":
        bare = (model or "").removeprefix("local:")
        if bare:
            entry = next((e for e in snap.entries if e.id == bare), None)
            if (
                entry is not None
                and entry.files
                and not is_downloaded(entry, config.resolved_models_dir)
            ):
                # Named-but-absent weights still route here (the kind is
                # claimable on some OTHER model's weights) and die inside
                # ComfyUI — say so first, with the download as the fix.
                return _row(
                    kind,
                    verdict="will_fail",
                    reason="no_model_installed",
                    backend=name,
                    model=bare,
                    data=data,
                    fix=_fix_for(entry),
                )
            return _row(kind, verdict="ready", reason="ok", backend=name, model=bare)
        auto = (snap.installed.get(kind) or [None])[0]
        # The resolved model is named even on Auto — the honest-Auto label
        # in Settings reads it.
        return _row(kind, verdict="ready", reason="ok", backend=name, model=auto)

    if name == "ffmpeg" and kind is NodeKind.CLIP:
        if snap.installed.get(kind):
            return _row(kind, verdict="degraded", reason="comfyui_down", backend=name, data=data)
        return _row(
            kind,
            verdict="degraded",
            reason="still_clip_tier",
            backend=name,
            data=data,
            fix=_download_fix(snap, config, kind),
        )

    if name == "mock":
        if kind is NodeKind.SCRIPT:
            return _row(
                kind, verdict="placeholder", reason="llm_server_down", backend=name, data=data
            )
        if kind in COMFY_TASKS and snap.installed.get(kind):
            return _row(kind, verdict="placeholder", reason="comfyui_down", backend=name, data=data)
        return _row(
            kind,
            verdict="placeholder",
            reason="no_model_installed",
            backend=name,
            data=data,
            fix=_download_fix(snap, config, kind),
        )

    # kokoro, align, chatterbox, ffmpeg assembly, and any future tier that
    # claimed the kind for real.
    return _row(kind, verdict="ready", reason="ok", backend=name, model=model)


async def _finish_llm_row(kind: NodeKind, backend, resolved_model: str) -> dict:  # noqa: ANN001
    try:
        names = await backend.list_models()
    except httpx.HTTPError:
        # The server vanished between the probe and the listing — at
        # execute time supports() would decline and mock would serve.
        return _row(
            kind,
            verdict="placeholder",
            reason="llm_server_down",
            backend="mock",
            data={"task": "text.llm"},
        )
    if resolved_model not in names:
        return _row(
            kind,
            verdict="will_fail",
            reason="llm_model_missing",
            backend=backend.name,
            model=resolved_model,
            data={"model": resolved_model, "task": "text.llm"},
            fix={"type": "pick_model", "task": "text.llm"},
        )
    return _row(kind, verdict="ready", reason="ok", backend=backend.name, model=resolved_model)


async def readiness_rows(
    config: EngineConfig,
    backends: BackendRegistry,
    pairs: list[tuple[NodeKind, str | None]],
) -> list[dict]:
    """One report row per (kind, model) pair, in the order given.

    Blocking work (manifest scans, resolve's capability probes) runs off
    the event loop; only the LLM server's model listing is awaited here.
    """
    snap = await asyncio.to_thread(_load_snapshot, config)
    rows: list[dict] = []
    for kind, model in pairs:
        if model and model.startswith("cloud:"):
            rows.append(await asyncio.to_thread(_cloud_row, config, backends, kind, model))
            continue
        result = await asyncio.to_thread(_local_row, snap, config, backends, kind, model)
        if isinstance(result, tuple):
            backend, resolved_model = result
            result = await _finish_llm_row(kind, backend, resolved_model)
        rows.append(result)
    return rows
