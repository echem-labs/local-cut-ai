"""Engine configuration. Defaults are the local topology: bind localhost,
token auth, data under ~/.localcut. Network bind is an explicit opt-in and
requires a pairing token.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from pydantic import BaseModel, Field


class EngineConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 7830
    token: str = Field(default_factory=lambda: secrets.token_urlsafe(24))
    data_dir: Path = Field(default_factory=lambda: Path.home() / ".localcut")
    models_dir: Path | None = None  # default: <data_dir>/models (ComfyUI layout)
    # Comma-separated backend chain, first match wins per node kind.
    # Shorthands: "mock", "local" (= llm,comfy,ffmpeg). A trailing "mock"
    # makes a hybrid: real backends where available, mock for the rest.
    backend: str = "mock"
    comfyui_url: str = "http://127.0.0.1:8188"
    # Node kinds ComfyUI serves; narration/music join once their custom
    # node packs are part of the managed ComfyUI component.
    comfy_kinds: str = "keyframe,thumbnail,clip"
    llm_url: str = "http://127.0.0.1:11434/v1"
    llm_model: str = "qwen3:14b"
    ffmpeg_bin: str = "ffmpeg"

    @classmethod
    def from_env(cls) -> EngineConfig:
        overrides: dict = {}
        for field in cls.model_fields:
            value = os.environ.get(f"LOCALCUT_{field.upper()}")
            if value is not None:
                overrides[field] = value
        return cls(**overrides)

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def queue_db(self) -> Path:
        return self.data_dir / "queue.db"

    @property
    def resolved_models_dir(self) -> Path:
        return self.models_dir if self.models_dir is not None else self.data_dir / "models"

    @property
    def backend_chain(self) -> list[str]:
        chain: list[str] = []
        for name in self.backend.split(","):
            name = name.strip()
            if name == "local":
                chain += ["llm", "comfy", "ffmpeg"]
            elif name:
                chain.append(name)
        return chain
