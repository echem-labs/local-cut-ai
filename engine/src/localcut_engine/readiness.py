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

WHERE a job lands is asked, never re-derived: `BackendRegistry.resolve` is
the same call the scheduler makes. WHY it landed there is this module's own
work, and the rule is to ask the registry what it holds
(`BackendRegistry.find`) rather than infer a cause from the winner's name —
"mock served the script" means the LLM server is down only if an `llm`
backend is in the chain at all, and "ffmpeg served the clip" means ComfyUI
is down only if ComfyUI is there to be down. Inferring from the name got
both of those wrong for real configurations.

Every row carries the task id in `data` and the model that would actually
render it, on ready rows too: the desktop's model picker reads the resolved
model to say what "Auto" means, and its per-task surfaces key on the task.
A row that omits either is a row those surfaces silently drop.

Known limitation, on purpose: a `local:chatterbox` narration row reports
ready without probing for the chatterbox package — the import pulls torch,
far too heavy for a preflight. Clone failures stay execute-time and loud
(backends/chatterbox.py never falls back to a stock voice).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx

from .backends.base import BackendRegistry, GenerationError, ServiceProbe
from .backends.ffmpeg import ffmpeg_available
from .config import EngineConfig
from .graph.model import NodeKind
from .manifest.capability import COMFY_TASKS, installed_by_task, installed_comfy_models
from .manifest.defaults import DEFAULTABLE_TASKS, load_defaults
from .manifest.downloads import is_downloaded
from .manifest.loader import load_manifest
from .manifest.recommend import _fits
from .providers.registry import (
    PROVIDERS,
    VISION_MODELS,
    Capability,
    configured_providers,
    provider_for_model,
)
from .providers.textgen import ProviderError

READINESS_VERDICTS = ("ready", "degraded", "placeholder", "will_fail")

READINESS_REASONS = (
    "ok",
    "still_clip_tier",
    "no_model_installed",
    # The weights (or server) are fine — nothing in this engine's backend
    # chain can use them. A download would change nothing, so no fix.
    "backend_not_configured",
    # The node names a model ComfyUI will not run: unknown to the manifest,
    # or carrying no workflow template. Something else renders it instead.
    "model_ignored",
    "llm_server_down",
    "llm_model_missing",
    "cloud_key_missing",
    "cloud_model_unknown",
    "comfyui_down",
    "no_ffmpeg",
)

READINESS_FIX_TYPES = ("download", "pick_model", "configure_provider", "install_ffmpeg")

# Kinds that assemble the deliverable. Mock declines these in any hybrid
# chain (a placeholder MP4 named "your export" is worse than a failure), so
# reaching mock here means an explicit all-mock chain.
_ASSEMBLY_KINDS = (NodeKind.TIMELINE, NodeKind.EXPORT)

# Manifest tasks whose entries can serve each kind, and the backend that
# would consume them. The ComfyUI kinds come from the capability table; the
# constructor-bound backends declare theirs here.
_DOWNLOAD_TASKS: dict[NodeKind, tuple[str, ...]] = {
    **COMFY_TASKS,
    NodeKind.NARRATION: ("speech.tts",),
    NodeKind.CAPTIONS: ("transcribe",),
}

# What a prompt project's graph expands into once the screenplay lands
# (templates.py::expand_screenplay). The project route reports an
# unexpanded graph against these, because a script-only graph is a stage
# rather than the whole job. Thumbnail is absent on purpose: it exists only
# in the publish kit and the thumbnail tool.
# test_readiness.py compares this against a real expansion, so it cannot
# drift from what the compiler actually builds.
PIPELINE_KINDS = (
    NodeKind.SCRIPT,
    NodeKind.KEYFRAME,
    NodeKind.CLIP,
    NodeKind.NARRATION,
    NodeKind.CAPTIONS,
    NodeKind.MUSIC,
    NodeKind.TIMELINE,
    NodeKind.EXPORT,
)

# Every job-producing kind, in pipeline order — PIPELINE_KINDS plus the
# thumbnail, which only the publish kit and the thumbnail tool build.
PIPELINE_ORDER = (
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

_CONSUMING_BACKEND: dict[NodeKind, str] = {
    **{kind: "comfyui" for kind in COMFY_TASKS},
    NodeKind.NARRATION: "kokoro",
    NodeKind.CAPTIONS: "align",
}


def task_of(kind: NodeKind) -> str | None:
    """The manifest task a kind renders from, or None for the assembly
    kinds, which have no model at all."""
    tasks = _DOWNLOAD_TASKS.get(kind)
    if tasks:
        return tasks[0]
    return "text.llm" if kind is NodeKind.SCRIPT else None


def auto_defaults(config: EngineConfig) -> dict[str, str | None]:
    """What "Auto" resolves to for each defaultable task, with any STORED
    default deliberately ignored. None means nothing would render it.

    The picker needs this rather than the readiness report, for two reasons
    the report cannot cover. It resolves WITH the stored default applied, so
    on a task that has one it can only answer with that same pick — while
    choosing Auto is precisely what discards it, making the label a promise
    the engine would not keep. And `vision.llm` has no node kind at all
    (nothing in a render reads an image; `/suggest-scene` does), so no row
    is ever produced for it and its picker read "Auto" forever.

    Each branch mirrors the resolution it describes: text.llm is
    LLMBackend.resolve_model's last resort, vision.llm is
    default_vision_model minus its local branch (the stored pick), and the
    ComfyUI tasks are the head of the un-jumped installed queue that
    `_template_for_installed` renders from.
    """
    installed = installed_by_task(config)
    configured = {row["id"]: row["configured"] for row in configured_providers(config)}
    auto: dict[str, str | None] = {}
    for task in DEFAULTABLE_TASKS:
        if task == "text.llm":
            auto[task] = config.llm_model
        elif task == "vision.llm":
            auto[task] = None
            for info in PROVIDERS:
                model = VISION_MODELS.get(info.id)
                if model and Capability.VISION in info.capabilities and configured.get(info.id):
                    auto[task] = model
                    break
        else:
            ids = installed.get(task) or []
            auto[task] = ids[0] if ids else None
    return auto


def project_pairs(graph, *, is_tool_session: bool) -> list[tuple[NodeKind, str | None]]:
    """The (kind, model) pairs a project should be judged on.

    One per distinct pair in the graph, in pipeline order, so a per-node
    model override is judged as itself rather than as the default.

    A prompt project's graph is two-stage (graph/templates.py): until the
    screenplay lands it holds the script node ALONE. Judging only that told
    a user with nothing installed that their project was one script away
    from fine, while every job the expansion was about to queue fell to a
    placeholder — so an unexpanded graph is judged against the kinds the
    expansion will create.

    A tool session is exempt: its graph is complete on creation (the script
    tool really does render nothing but a script), so padding it would warn
    about models it will never use.
    """
    pairs: list[tuple[NodeKind, str | None]] = []
    seen: set[tuple[NodeKind, str | None]] = set()
    for kind in PIPELINE_ORDER:
        for node in graph.nodes.values():
            if node.kind is kind and (kind, node.model) not in seen:
                seen.add((kind, node.model))
                pairs.append((kind, node.model))
    unexpanded = not any(kind is NodeKind.CLIP for kind, _ in pairs)
    if unexpanded and not is_tool_session:
        # Padded per KIND, not per (kind, model): a script node already
        # pinned to a cloud model must not also gain a phantom Auto row
        # judged against the local default it will never use — a row no
        # node in the graph corresponds to, which the gate would then
        # raise a dialog about.
        covered = {kind for kind, _ in pairs}
        pairs += [(kind, None) for kind in PIPELINE_KINDS if kind not in covered]
    return pairs


@dataclass
class _Snapshot:
    """Per-request state: the manifest reads that would otherwise repeat
    once per row, plus the LLM server's model list, memoized because a
    report can hold several script rows and each listing is an HTTP call.

    It deliberately does NOT try to save the capability probes inside
    `resolve()` — those are recomputed per call by design (capability.py),
    which is what lets a finishing download flip a verdict mid-report.
    """

    entries: list = field(default_factory=list)
    defaults: dict[str, str] = field(default_factory=dict)
    installed: dict[NodeKind, list[str]] = field(default_factory=dict)
    llm_names: list[str] | None = None
    llm_listed: bool = False
    # This machine, when the caller already has it. Only used to keep the
    # offered download to something the box can actually run; None means
    # "not probed", and the fix is then offered unfiltered rather than the
    # preflight paying for a hardware probe of its own.
    profile: object | None = None


def _load_snapshot(config: EngineConfig, profile: object | None = None) -> _Snapshot:
    """Raises OSError/ValueError for an unreadable manifest and
    DefaultsTooNew for a defaults file from a newer build — the routes map
    both the way every sibling route does (503/409). Swallowing them here
    would answer "no model installed, no fix" to a user whose actual
    problem is a corrupt file, which is the one message that fixes it."""
    snap = _Snapshot(profile=profile)
    snap.entries = list(load_manifest(config).models)
    snap.defaults = load_defaults(config)
    snap.installed = installed_comfy_models(config)
    return snap


def _row(
    kind: NodeKind,
    *,
    verdict: str,
    reason: str,
    backend: str | None = None,
    model: str | None = None,
    extra: dict | None = None,
    fix: dict | None = None,
) -> dict:
    """`data` always carries the task (when the kind has one) — the
    desktop's per-task surfaces key on it, including for ready rows."""
    task = task_of(kind)
    data = {**({"task": task} if task else {}), **(extra or {})}
    return {
        "kind": kind.value,
        "model": model,
        "backend": backend,
        "verdict": verdict,
        "reason": reason,
        "data": data,
        "fix": fix,
    }


def _fix_for(entry) -> dict:  # noqa: ANN001 — ModelEntry, typed at the manifest
    # size_bytes can legitimately be 0: a custom model registered from a URL
    # declares no size until it is fetched. The desktop renders the size
    # only when it has one.
    return {
        "type": "download",
        "model_id": entry.id,
        "size_bytes": sum(file.size for file in entry.files),
    }


def _download_fix(snap: _Snapshot, kind: NodeKind, *, consumable: bool) -> dict | None:
    """The manifest's best downloadable candidate for a kind: the stored
    per-task default when it is downloadable, else the first entry for the
    kind's tasks with files (and, for ComfyUI kinds, a workflow template —
    weights with no graph to run them are not a capability).

    `consumable=False` returns nothing: with no backend in the chain able to
    load the weights, the download would finish and change no verdict, and
    offering it as the fix is worse than offering none."""
    if not consumable:
        return None
    tasks = _DOWNLOAD_TASKS.get(kind, ())
    need_template = kind in COMFY_TASKS

    def usable(entry) -> bool:  # noqa: ANN001 — ModelEntry
        # Commercial-only, the same bar `recommend_slate` holds the slate to
        # (doc 04's licensing matrix, and `lint_defaults` is a CI gate on
        # it). A custom entry is recorded `commercial=False` unverified, so
        # this also keeps the banner from pushing one as THE fix.
        return (
            bool(entry.files)
            and entry.license.commercial
            and (bool(entry.comfy_graph_template) or not need_template)
            # And it has to run here. Manifest order puts the 16 GB / 36 GB
            # wan2.2 first for video, so without this the banner offered it
            # as THE one-click fix on an 8 GB box while /system recommended
            # LTX on the adjacent surface — two answers to one question.
            and (snap.profile is None or _fits(entry, snap.profile))
        )

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


def _cloud_row(config: EngineConfig, backends: BackendRegistry, kind: NodeKind, model: str) -> dict:
    """cloud:* is an explicit provider choice that routes by model, never by
    chain — so the row checks what execute would die on: the provider's key,
    and whether that provider has the capability this kind needs."""
    unknown = _row(
        kind,
        verdict="will_fail",
        reason="cloud_model_unknown",
        backend="cloud",
        model=model,
        extra={"model": model},
    )
    try:
        provider = provider_for_model(model)
    except ProviderError:
        return unknown
    # CloudBackend.supports() claims SCRIPT and CLIP for ANY cloud model, so
    # resolve() alone cannot tell a text model on a clip from a real pairing;
    # execute then dies in textgen_for_model/videogen_for_model. The provider
    # table already knows which way round it is.
    needed = Capability.VIDEO if kind is NodeKind.CLIP else Capability.TEXT
    info = next((entry for entry in PROVIDERS if entry.id == provider), None)
    if info is None or needed not in info.capabilities:
        return unknown
    configured = {row["id"]: row["configured"] for row in configured_providers(config)}
    if not configured.get(provider):
        return _row(
            kind,
            verdict="will_fail",
            reason="cloud_key_missing",
            backend="cloud",
            model=model,
            extra={"provider": provider, "model": model},
            fix={"type": "configure_provider", "provider": provider},
        )
    try:
        resolved = backends.resolve(kind, model)
    except GenerationError:
        return unknown
    return _row(kind, verdict="ready", reason="ok", backend=resolved.name, model=model)


def _comfy_claims(backends: BackendRegistry, kind: NodeKind) -> bool:
    """Whether a ComfyUI backend is in the chain AND configured to serve
    this kind — the question `comfyui_down` is only allowed to answer yes
    to."""
    comfy = backends.find("comfyui")
    return comfy is not None and kind in getattr(comfy, "kinds", set())


def _missing_model_row(
    snap: _Snapshot,
    backends: BackendRegistry,
    kind: NodeKind,
    *,
    verdict: str,
    backend: str | None,
    model: str | None = None,
) -> dict:
    """The row for "a real backend did not serve this kind", with the cause
    established from what the chain actually holds rather than guessed.

    `model` is the model the NODE asked for, carried through even though
    nothing resolved it: it is what makes two rows for the same kind
    distinguishable when scenes pin different models."""
    consumer = _CONSUMING_BACKEND.get(kind)
    in_chain = consumer is not None and backends.find(consumer) is not None
    if kind in COMFY_TASKS:
        # Weights are installed and ComfyUI is configured for this kind, so
        # the only thing left that can have declined it is the server probe.
        if snap.installed.get(kind) and _comfy_claims(backends, kind):
            return _row(kind, verdict=verdict, reason="comfyui_down", backend=backend, model=model)
        in_chain = in_chain and _comfy_claims(backends, kind)
    if not in_chain:
        return _row(
            kind, verdict=verdict, reason="backend_not_configured", backend=backend, model=model
        )
    return _row(
        kind,
        verdict=verdict,
        reason="no_model_installed",
        backend=backend,
        model=model,
        fix=_download_fix(snap, kind, consumable=True),
    )


def _transcribe_weights_installed(snap: _Snapshot, config: EngineConfig) -> bool:
    """Whether anything the aligner could load is on disk.

    Read off the manifest rather than `snap.installed`, which holds only the
    ComfyUI kinds — captions has never had an entry there, so a membership
    test against it answers False on a fully downloaded machine.
    """
    tasks = _DOWNLOAD_TASKS[NodeKind.CAPTIONS]
    return any(
        entry.task in tasks and is_downloaded(entry, config.resolved_models_dir)
        for entry in snap.entries
    )


# One probe per URL, kept between calls. ServiceProbe is TTL-cached and
# refreshes on a worker thread, but only an instance that survives can answer
# from that cache: its FIRST answer is deliberately synchronous, so building a
# fresh one per row would block the event loop for the connect timeout on
# every /readiness, once per ComfyUI kind.
_COMFY_PROBES: dict[str, ServiceProbe] = {}


def _comfy_alive(config: EngineConfig) -> bool:
    url = f"{config.comfyui_url.rstrip('/')}/queue"
    probe = _COMFY_PROBES.get(url)
    if probe is None:
        probe = _COMFY_PROBES.setdefault(url, ServiceProbe(url))
    return probe.available()


def _comfy_row(snap: _Snapshot, config: EngineConfig, kind: NodeKind, model: str | None) -> dict:
    """ComfyUI won the kind. What it will actually load depends on the
    node's model and on `_template_path`'s fallback chain, not on the fact
    that ComfyUI answered."""
    bare = (model or "").removeprefix("local:")
    installed = snap.installed.get(kind) or []
    # Weights on disk are not a running server. In "auto" mode the capability
    # closure gates on the probe, so a stopped ComfyUI takes the kind out of
    # the chain and never reaches here. An explicit LOCALCUT_COMFY_KINDS list
    # — what docs/running-real-models.md calls the static override — claims
    # the kind unconditionally, so without asking here the one screen whose
    # whole job is to warn before an expensive render reported `ready` for
    # keyframe, thumbnail, clip and music with nothing listening.
    if not _comfy_alive(config):
        return _row(
            kind,
            verdict="will_fail",
            reason="comfyui_down",
            backend="comfyui",
            model=bare or (installed[0] if installed else None),
        )
    if not bare:
        if not installed:
            # An explicit (non-"auto") comfy_kinds claims the kind whatever
            # is on disk, so this is reachable: the workflow would load a
            # checkpoint nobody installed and fail inside ComfyUI.
            return _row(
                kind,
                verdict="will_fail",
                reason="no_model_installed",
                backend="comfyui",
                fix=_download_fix(snap, kind, consumable=True),
            )
        # Named even on Auto: the Settings picker reads this to say what
        # "Auto" resolves to on this machine.
        return _row(kind, verdict="ready", reason="ok", backend="comfyui", model=installed[0])

    entry = next((candidate for candidate in snap.entries if candidate.id == bare), None)
    if entry is None or not entry.comfy_graph_template:
        # `_template_path` maps a model to a workflow through the manifest's
        # template map, which holds only entries that declare one. Anything
        # else falls through to the first INSTALLED model's template — the
        # job succeeds, rendering a model the node did not ask for. Reachable
        # from the shipped "Add custom model" flow, which defaults the
        # template to empty.
        return _row(
            kind,
            verdict="degraded",
            reason="model_ignored",
            backend="comfyui",
            model=bare,
            extra={"model": bare},
            fix=_fix_for(entry) if entry is not None and entry.files else None,
        )
    if entry.files and not is_downloaded(entry, config.resolved_models_dir):
        # The template exists, so ComfyUI runs it — against weights that are
        # not there. It dies inside ComfyUI on a validation error.
        return _row(
            kind,
            verdict="will_fail",
            reason="no_model_installed",
            backend="comfyui",
            model=bare,
            fix=_fix_for(entry),
        )
    return _row(kind, verdict="ready", reason="ok", backend="comfyui", model=bare)


def _local_row(
    snap: _Snapshot,
    config: EngineConfig,
    backends: BackendRegistry,
    kind: NodeKind,
    model: str | None,
) -> dict | tuple:
    """One row, or `(backend, resolved_model)` when the answer needs the LLM
    server's model list — the only async leg, finished by the caller."""
    try:
        resolved = backends.resolve(kind, model)
    except GenerationError:
        if kind in _ASSEMBLY_KINDS:
            return _row(
                kind, verdict="will_fail", reason="no_ffmpeg", fix={"type": "install_ffmpeg"}
            )
        if kind is NodeKind.SCRIPT:
            return _row(
                kind,
                verdict="will_fail",
                reason=("llm_server_down" if backends.find("llm") else "backend_not_configured"),
                model=model,
            )
        return _missing_model_row(
            snap, backends, kind, verdict="will_fail", backend=None, model=model
        )

    name = resolved.name
    if name == "llm":
        return (resolved, resolved.resolve_model(model))
    if name == "comfyui":
        return _comfy_row(snap, config, kind, model)
    if name == "ffmpeg" and kind is NodeKind.CLIP:
        # The still-clip tier: a real render, one tier down. Which is only
        # the *interesting* answer when a video model could have served it.
        if snap.installed.get(kind) and _comfy_claims(backends, kind):
            return _row(kind, verdict="degraded", reason="comfyui_down", backend=name, model=model)
        return _row(
            kind,
            verdict="degraded",
            reason="still_clip_tier",
            backend=name,
            model=model,
            fix=_download_fix(snap, kind, consumable=_comfy_claims(backends, kind)),
        )
    if name == "mock":
        if kind in _ASSEMBLY_KINDS:
            # Only an explicit all-mock chain gets here (the demo/test
            # configuration): no real assembly backend is configured.
            return _row(kind, verdict="placeholder", reason="backend_not_configured", backend=name)
        if kind is NodeKind.SCRIPT:
            return _row(
                kind,
                verdict="placeholder",
                reason=("llm_server_down" if backends.find("llm") else "backend_not_configured"),
                backend=name,
                model=model,
            )
        if (
            kind is NodeKind.CAPTIONS
            and not ffmpeg_available(config.resolved_ffmpeg_bin)
            and _transcribe_weights_installed(snap, config)
        ):
            # Weights are installed and the aligner is in the chain, so the
            # only thing left that can have declined captions is the ffmpeg
            # binary it decodes narration through — the same shape as the
            # ComfyUI branch in `_missing_model_row`. Gated on the weights
            # because a machine with neither is better told about the model:
            # `_missing_model_row` names one it can download, and this row
            # would replace that with a binary no download supplies.
            return _row(
                kind,
                verdict="placeholder",
                reason="no_ffmpeg",
                backend=name,
                model=model,
                fix={"type": "install_ffmpeg"},
            )
        return _missing_model_row(
            snap, backends, kind, verdict="placeholder", backend=name, model=model
        )

    # kokoro, align, chatterbox, ffmpeg assembly, and any future tier that
    # claimed the kind for real.
    return _row(kind, verdict="ready", reason="ok", backend=name, model=model)


def _lists_model(names: list[str], resolved: str) -> bool:
    """Whether the server's list holds the resolved model.

    Ollama reports a tagged name, so a perfectly good `LOCALCUT_LLM_MODEL=
    llama3.2` has to match the `llama3.2:latest` it lists — an exact
    membership test declares that machine broken.
    """
    wanted = resolved.removesuffix(":latest")
    return any(name.removesuffix(":latest") == wanted for name in names)


async def _finish_llm_row(snap: _Snapshot, kind: NodeKind, backend, resolved: str) -> dict:  # noqa: ANN001
    if not snap.llm_listed:
        snap.llm_listed = True
        try:
            snap.llm_names = await backend.list_models()
        except (httpx.HTTPError, AttributeError, TypeError, ValueError):
            # A server whose /v1/models is missing, guarded, or not shaped
            # the way the client expects. Unknown, not empty — and a
            # diagnostic must never be the thing that 500s.
            snap.llm_names = None
    if snap.llm_names is None:
        # The server answered the probe and then could not be listed. At
        # execute time supports() would decline and mock would serve.
        return _row(kind, verdict="placeholder", reason="llm_server_down", backend="mock")
    if not snap.llm_names:
        # `list_models` flattens any non-200 to an empty list, and plenty of
        # OpenAI-compatible servers serve chat completions without serving
        # /v1/models at all (llama.cpp builds, anything behind an auth
        # proxy). "I could not enumerate" is not "the model is absent", and
        # blocking a render that would have worked is the worse error.
        return _row(kind, verdict="ready", reason="ok", backend=backend.name, model=resolved)
    if not _lists_model(snap.llm_names, resolved):
        return _row(
            kind,
            verdict="will_fail",
            reason="llm_model_missing",
            backend=backend.name,
            model=resolved,
            extra={"model": resolved},
            fix={"type": "pick_model", "task": "text.llm"},
        )
    return _row(kind, verdict="ready", reason="ok", backend=backend.name, model=resolved)


async def readiness_rows(
    config: EngineConfig,
    backends: BackendRegistry,
    pairs: list[tuple[NodeKind, str | None]],
    profile: object | None = None,
) -> list[dict]:
    """One report row per (kind, model) pair, in the order given.

    `profile` is this machine's hardware, when the caller already holds it
    — it only narrows the offered download to something the box can run.

    Blocking work (manifest scans, resolve's capability probes) runs off
    the event loop; only the LLM server's model listing is awaited here.
    """
    snap = await asyncio.to_thread(_load_snapshot, config, profile)
    rows: list[dict] = []
    for kind, model in pairs:
        if model and model.startswith("cloud:"):
            rows.append(await asyncio.to_thread(_cloud_row, config, backends, kind, model))
            continue
        result = await asyncio.to_thread(_local_row, snap, config, backends, kind, model)
        if isinstance(result, tuple):
            backend, resolved_model = result
            result = await _finish_llm_row(snap, kind, backend, resolved_model)
        rows.append(result)
    return rows
