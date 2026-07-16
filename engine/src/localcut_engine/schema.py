"""Structured screenplay schema — the contract between modes.

The script LLM emits this, prompt-only auto-approves it, beginner mode
renders it as an editable table, and the graph compiler expands each
scene into a subgraph.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class SceneStyle(BaseModel):
    visual: str = "cinematic, natural light"
    voice: str = "neutral narrator"
    music: str = "ambient, understated"


class Scene(BaseModel):
    id: str
    duration_s: float = Field(gt=0, le=60)
    narration: str
    visual: str
    motion: str = "static shot"
    onscreen_text: str | None = None


class Screenplay(BaseModel):
    title: str
    hook: str = ""
    target_duration_s: int = Field(default=60, gt=0)
    aspect: str = "16:9"
    style: SceneStyle = SceneStyle()
    scenes: list[Scene] = []

    def scene(self, scene_id: str) -> Scene | None:
        return next((s for s in self.scenes if s.id == scene_id), None)
