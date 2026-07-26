"""Recommendation = manifest × hardware profile. Honesty is a
feature: every recommendation carries quality/speed scores and the license
badge so the UI can show expected time on *your* hardware.
"""

from __future__ import annotations

from pydantic import BaseModel

from ..hardware.probe import HardwareProfile
from .model import ModelEntry, ModelManifest

TASKS = ["text.llm", "image.gen", "video.i2v", "speech.tts", "music.gen", "transcribe"]


class Recommendation(BaseModel):
    task: str
    model: ModelEntry | None
    reason: str


def _runs_on(model: ModelEntry, backend: str) -> bool:
    """Whether this machine's GPU runtime is one the model can use at all.
    A model declaring only `cpu` needs no GPU and runs anywhere."""
    return backend in model.requirements.backends or model.requirements.backends == ["cpu"]


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
    backend = profile.primary_gpu.backend if profile.primary_gpu else None
    if backend and not any(_runs_on(m, backend) for m in models):
        return f"no local model supports your GPU runtime ({backend}) yet — cloud recommended"
    if not profile.primary_gpu:
        return "no GPU detected, and no local model runs on CPU alone — cloud recommended"
    needed = min(m.requirements.vram_gb for m in models if _runs_on(m, backend or "none"))
    if profile.primary_gpu.vram_gb < needed:
        return (
            f"needs {needed:g} GB VRAM, this GPU has "
            f"{profile.primary_gpu.vram_gb:g} GB — cloud recommended"
        )
    return "no local model fits this hardware — cloud recommended"


def recommend_slate(manifest: ModelManifest, profile: HardwareProfile) -> list[Recommendation]:
    slate: list[Recommendation] = []
    for task in TASKS:
        usable = [m for m in manifest.for_task(task) if m.license.commercial]
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
