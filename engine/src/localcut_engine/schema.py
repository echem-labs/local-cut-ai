"""Structured screenplay schema — the contract between modes.

The script LLM emits this, prompt-only auto-approves it, beginner mode
renders it as an editable table, and the graph compiler expands each
scene into a subgraph.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


def _drop_blank(data: object, fields: tuple[str, ...]) -> object:
    """Let a declared default apply when the model sent `""` for it.

    Pydantic fills defaults for *missing* keys only, and a small script model
    with nothing to say for a field returns an empty string, not an omission —
    `style.music: ""` shipped a music bed generated from the bare word
    "instrumental", and an empty `style.visual` would silently unstyle every
    keyframe and clip. Only fields whose default is real fallback text are
    listed; blank is a legitimate value for prose like `hook`."""
    if not isinstance(data, dict):
        return data
    blank = [f for f in fields if isinstance(data.get(f), str) and not data[f].strip()]
    # A copy, not a del: validation is a read of the caller's payload, and
    # a validator that quietly edits the dict it was handed would surprise
    # anyone who validates a document they still hold a reference to.
    return {k: v for k, v in data.items() if k not in blank} if blank else data


class SceneStyle(BaseModel):
    visual: str = "cinematic, natural light"
    voice: str = "neutral narrator"
    music: str = "ambient, understated"

    @model_validator(mode="before")
    @classmethod
    def _defaults_beat_blank(cls, data: object) -> object:
        return _drop_blank(data, ("visual", "voice", "music"))


class Scene(BaseModel):
    id: str
    duration_s: float = Field(gt=0, le=60)
    narration: str
    visual: str
    motion: str = "static shot"
    onscreen_text: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _defaults_beat_blank(cls, data: object) -> object:
        return _drop_blank(data, ("motion",))


class Screenplay(BaseModel):
    title: str
    hook: str = ""
    target_duration_s: int = Field(default=60, gt=0)
    aspect: str = "16:9"
    style: SceneStyle = SceneStyle()
    scenes: list[Scene] = []
