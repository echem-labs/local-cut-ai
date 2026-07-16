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
    backend: str = "mock"  # mock | local  (local = ComfyUI + llama.cpp + FFmpeg)
    comfyui_url: str = "http://127.0.0.1:8188"
    llm_url: str = "http://127.0.0.1:11434/v1"
    llm_model: str = "qwen3:14b"

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
