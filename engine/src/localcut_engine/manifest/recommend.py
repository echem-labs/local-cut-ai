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


def _fits(model: ModelEntry, profile: HardwareProfile) -> bool:
    backend = profile.primary_gpu.backend if profile.primary_gpu else "none"
    vram = profile.primary_gpu.vram_gb if profile.primary_gpu else 0.0
    if backend not in model.requirements.backends and model.requirements.backends != ["cpu"]:
        return False
    return (
        vram >= model.requirements.vram_gb
        and profile.ram_gb >= model.requirements.ram_gb
        and profile.disk_free_gb >= model.requirements.disk_gb
    )


def recommend_slate(manifest: ModelManifest, profile: HardwareProfile) -> list[Recommendation]:
    slate: list[Recommendation] = []
    for task in TASKS:
        candidates = [
            m for m in manifest.for_task(task) if m.license.commercial and _fits(m, profile)
        ]
        if not candidates:
            slate.append(
                Recommendation(
                    task=task,
                    model=None,
                    reason="no local model fits this hardware — cloud recommended",
                )
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
