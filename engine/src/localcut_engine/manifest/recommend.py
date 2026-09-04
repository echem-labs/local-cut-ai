"""Recommendation = manifest × hardware profile. Honesty is a
feature: every recommendation carries quality/speed scores and the license
badge so the UI can show expected time on *your* hardware.
"""

from __future__ import annotations

from pydantic import BaseModel

from ..hardware.probe import HardwareProfile
from .capability import COMFY_TASKS, DOWNLOADED_TASKS
from .model import ModelEntry, ModelManifest

TASKS = ["text.llm", "image.gen", "video.i2v", "speech.tts", "music.gen", "transcribe"]


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
        and profile.disk_free_gb >= model.requirements.disk_gb
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
