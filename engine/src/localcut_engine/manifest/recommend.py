"""Recommendation = manifest × hardware profile. Honesty is a
feature: every recommendation carries quality/speed scores and the license
badge so the UI can show expected time on *your* hardware.
"""

from __future__ import annotations

from pydantic import BaseModel

from ..config import EngineConfig
from ..hardware.probe import HardwareProfile, machine_profile
from .capability import COMFY_TASKS, DOWNLOADED_TASKS
from .defaults import DefaultsTooNew, load_defaults
from .loader import load_manifest
from .model import ModelEntry, ModelManifest

TASKS = ["text.llm", "image.gen", "video.i2v", "speech.tts", "music.gen", "transcribe"]

# The script model when nothing names one: no LOCALCUT_LLM_MODEL, no pick in
# Settings, and no local text model this machine fits (the slate sends its
# scripts to the cloud).
FALLBACK_LLM_MODEL = "qwen3:14b"


class Recommendation(BaseModel):
    task: str
    model: ModelEntry | None
    reason: str


def _runs_on(model: ModelEntry, backend: str) -> bool:
    """Whether this machine's runtime is one the model can use at all.

    `cpu` anywhere in the list means no GPU is required — matching it exactly
    (`backends == ["cpu"]`) treated kokoro-82m and faster-whisper, which both
    declare `["cuda", "mps", "cpu"]` and both run on CPU in this repo, as
    GPU-only: every AMD box was told "no local model supports your GPU
    runtime (rocm)" for text.llm and transcribe, and a machine with no GPU
    was told "no local model runs on CPU alone" for all six tasks.
    """
    return backend in model.requirements.backends or "cpu" in model.requirements.backends


def _fits(model: ModelEntry, profile: HardwareProfile) -> bool:
    backend = profile.primary_gpu.backend if profile.primary_gpu else "none"
    vram = profile.primary_gpu.vram_gb if profile.primary_gpu else 0.0
    if not _runs_on(model, backend):
        return False
    return (
        vram >= model.requirements.vram_gb
        and profile.ram_gb >= model.requirements.ram_gb
        # Free disk is measured on LocalCut's data folder, where the app's
        # own downloads land, and only those are held to it. A text.llm
        # model lives in Ollama's store, which the app does not fill. The
        # figure falls with every video model downloaded, so holding the
        # script model to it would move Auto (auto_llm_model) off the model
        # the user pulled, and the wizard's pick along with it.
        and (
            model.task not in DOWNLOADED_TASKS or profile.disk_free_gb >= model.requirements.disk_gb
        )
    )


def _why_nothing_fits(models: list[ModelEntry], profile: HardwareProfile) -> str:
    """Name the actual blocker.

    "no local model fits this hardware" next to a Tier C badge reads as a bug
    in the app: the user can see their 24 GB card being recognised and still
    gets told to use the cloud. The two reasons are entirely different
    problems for them — an unsupported RUNTIME is nothing they can fix by
    buying hardware, while short VRAM is."""
    if not models:
        return "no local model is published for this task yet — cloud recommended"
    backend = profile.primary_gpu.backend if profile.primary_gpu else "none"
    vram = profile.primary_gpu.vram_gb if profile.primary_gpu else 0.0
    # One list, used for both the "nothing runs here" answer and the VRAM
    # floor. Deriving the floor from a second, differently-guarded pass is how
    # `min()` came to be reachable with an empty sequence (a GPU whose backend
    # string is falsy skipped the guard and crashed /system outright).
    runnable = [m for m in models if _runs_on(m, backend)]
    if not runnable:
        if profile.primary_gpu is None:
            return "no GPU detected, and no local model runs on CPU alone — cloud recommended"
        return f"no local model supports your GPU runtime ({backend}) yet — cloud recommended"
    needed = min(m.requirements.vram_gb for m in runnable)
    if vram < needed:
        # Checked before "no GPU detected": a task whose smallest model still
        # wants VRAM has a blocker the user can act on, and saying "nothing
        # runs on CPU" about a model that does is simply false.
        if profile.primary_gpu is None:
            return f"needs {needed:g} GB VRAM and no GPU was detected — cloud recommended"
        return f"needs {needed:g} GB VRAM, this GPU has {vram:g} GB — cloud recommended"
    return "no local model fits this hardware — cloud recommended"


def _installable(model: ModelEntry) -> bool:
    """Whether this recommendation is one the user can act on.

    For a task whose weights the app downloads, an entry with no `files` is a
    name rather than something to install: the wizard offers it, downloads
    nothing, and reports the stage covered over a machine that has no weights
    for it. A ComfyUI task additionally needs a workflow template — weights
    with no graph to run them are not a capability. That is the same bar
    `readiness._download_fix` applies before offering a model as the
    one-click fix, and its comment already claimed the slate held it.

    text.llm is deliberately exempt: Ollama installs those, so a fileless
    entry there is still a real recommendation.
    """
    if model.task not in DOWNLOADED_TASKS:
        return True
    if not model.files:
        return False
    comfy_tasks = {task for tasks in COMFY_TASKS.values() for task in tasks}
    return bool(model.comfy_graph_template) or model.task not in comfy_tasks


def recommend_slate(manifest: ModelManifest, profile: HardwareProfile) -> list[Recommendation]:
    slate: list[Recommendation] = []
    for task in TASKS:
        usable = [m for m in manifest.for_task(task) if m.license.commercial and _installable(m)]
        candidates = [m for m in usable if _fits(m, profile)]
        if not candidates:
            slate.append(
                Recommendation(task=task, model=None, reason=_why_nothing_fits(usable, profile))
            )
            continue
        best = max(candidates, key=lambda m: (m.quality_score, m.speed_score))
        slate.append(
            Recommendation(
                task=task,
                model=best,
                reason=f"best quality fit for tier {profile.tier} "
                f"({best.requirements.vram_gb:g} GB VRAM needed)",
            )
        )
    return slate


def server_tag(entry: ModelEntry) -> str | None:
    """The name the LLM server knows a text.llm entry by: its `ollama`
    source. The manifest id (`qwen3-8b-q4`) names the entry in the catalog,
    and no server has heard of it."""
    return next(
        (source["ollama"] for source in entry.sources if source.get("ollama")),
        None,
    )


def auto_llm_model(config: EngineConfig) -> str:
    """What Auto means for text.llm: the model a script is written with when
    neither the node nor a Settings pick names one.

    LOCALCUT_LLM_MODEL when the operator set it. Otherwise the text model
    the slate recommends for this hardware, which is the one the first-run
    wizard showed and the one a user who followed it has pulled. An engine
    that asked for a fixed model instead failed that user's first script
    over a model nothing had told them to get.

    Deliberately not "whatever the server has" when the recommended model
    is missing. The server's list says nothing about which names can write a
    screenplay (embedding models are listed like any other), and readiness
    already names the missing model with the picker as its fix, which is a
    choice the user makes rather than one made for them.

    Blocking on its first call, while the hardware is probed
    (machine_profile), so callers on the event loop take it to a thread.
    """
    if config.llm_model:
        return config.llm_model
    try:
        manifest = load_manifest(config)
    except (OSError, ValueError):
        # The manifest's own routes refuse an unreadable one with a reason;
        # a script job still has a model to ask for.
        return FALLBACK_LLM_MODEL
    profile = machine_profile(str(config.data_dir))
    recommended = next(
        (row.model for row in recommend_slate(manifest, profile) if row.task == "text.llm"),
        None,
    )
    return (server_tag(recommended) if recommended else None) or FALLBACK_LLM_MODEL


def script_model(config: EngineConfig) -> str:
    """The model a script with no model of its own is written with: the
    user's text.llm pick in Settings, else Auto. The one answer readiness,
    GET /programs, GET /llm/models and the script backend all give.

    A defaults file from a newer build is refused on its own routes; here
    it reads as no pick, so a script job still runs."""
    try:
        picked = load_defaults(config).get("text.llm")
    except DefaultsTooNew:
        picked = None
    return picked or auto_llm_model(config)
