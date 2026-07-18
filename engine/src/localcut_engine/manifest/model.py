"""Model manifest — the recommendation engine is a data problem, not a
code problem. The app ships (and remotely refreshes) a signed
model-manifest.json; no model names are baked into product code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["commercial", "conditions", "personal-only"]


class LicenseInfo(BaseModel):
    id: str  # spdx-ish: apache-2.0, openrail++, ...
    commercial: bool
    verdict: Verdict = "commercial"
    notes: str = ""


class Requirements(BaseModel):
    vram_gb: float
    ram_gb: float = 16
    disk_gb: float
    backends: list[str] = ["cuda"]


class ModelFile(BaseModel):
    """One downloadable weight file. `dest` is relative to the models dir
    and follows ComfyUI's layout (checkpoints/, vae/, clip/, ...)."""

    url: str
    dest: str
    sha256: str = ""
    size: int = 0


class ModelEntry(BaseModel):
    id: str
    task: str  # video.i2v | video.t2v | image.gen | text.llm | speech.tts | music.gen | transcribe
    family: str
    version: str = ""
    quant: str = ""
    requirements: Requirements
    perf_class: dict[str, str] = Field(default_factory=dict)
    quality_score: float = 5.0
    speed_score: float = 5.0
    license: LicenseInfo
    sources: list[dict[str, str]] = Field(default_factory=list)
    files: list[ModelFile] = Field(default_factory=list)
    comfy_graph_template: str = ""
    # User-added entry (custom-models.json) — outside the curated catalog,
    # so the UI shows a neutral "custom" tag and a license self-ack badge
    # instead of the curated verdicts.
    custom: bool = False


class ModelManifest(BaseModel):
    schema_version: int = 1
    updated: str = ""
    models: list[ModelEntry] = Field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> ModelManifest:
        return cls.model_validate(json.loads(path.read_text()))

    def for_task(self, task: str) -> list[ModelEntry]:
        return [m for m in self.models if m.task == task]

    def lint_defaults(self) -> list[str]:
        """CI gate: no personal-only licenses can ship as
        defaults. Returns violations."""
        return [
            m.id
            for m in self.models
            if m.license.verdict == "personal-only" or not m.license.commercial
        ]
