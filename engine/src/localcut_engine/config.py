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
    # None = <data_dir>/models, derived lazily: materializing it eagerly
    # would freeze the default into model_dump() and break rebuilding the
    # config with a different data_dir (the CLI override path).
    models_dir: Path | None = None
    # Comma-separated backend chain, first match wins per node kind.
    # Shorthands: "mock", "local" (= llm,comfy,chatterbox,kokoro,align,ffmpeg).
    # A trailing "mock" makes a hybrid: real backends where available, mock
    # for the rest.
    backend: str = "mock"
    comfyui_url: str = "http://127.0.0.1:8188"
    # Node kinds ComfyUI serves (music = ACE-Step via native ComfyUI nodes).
    # "auto" claims a kind only while an installed manifest model can serve
    # it — no video model means clips fall to the still-clip tier instead
    # of failing. An explicit list is a static override for power users.
    comfy_kinds: str = "auto"
    llm_url: str = "http://127.0.0.1:11434/v1"
    llm_model: str = "qwen3:14b"
    # Ceiling for one local completion. Thinking models on modest GPUs can
    # spend many minutes on a long screenplay (cold load + reasoning), so
    # this must be generous — and tunable (LOCALCUT_LLM_TIMEOUT_S) for
    # machines where even the default is tight.
    llm_timeout_s: int = 600
    # Exactly one browser origin allowed to make CORS requests, or "" for no
    # CORS surface at all (the default — the packaged renderer needs none).
    # The desktop's dev flow sets this (LOCALCUT_ALLOW_ORIGIN) to vite's
    # http origin, where Chromium preflights every token-carrying request;
    # without an answer the preflight-exempt WebSocket connects while every
    # fetch dies, which reads as "engine up, all lists broken".
    allow_origin: str = ""
    ffmpeg_bin: str = "ffmpeg"
    # "Finalize" swaps unpinned clips to this model (e.g.
    # "local:wan2.2-i2v-14b-fp8" on 16 GB+ tiers). None = same model,
    # higher steps/resolution only.
    final_clip_model: str | None = None
    # BYOK cloud keys (never persisted by the engine; the desktop shell
    # sources them from the OS keychain and passes them via environment).
    anthropic_key: str | None = None
    openai_key: str | None = None
    gemini_key: str | None = None
    fal_key: str | None = None

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
    def previews_dir(self) -> Path:
        """Auditioned voice previews, engine-wide rather than per-project: a
        preview is a property of the installed pack, and every project
        auditions the same voices out of it."""
        return self.data_dir / "previews"

    @property
    def resolved_models_dir(self) -> Path:
        return self.models_dir if self.models_dir is not None else self.data_dir / "models"

    @property
    def resolved_ffmpeg_bin(self) -> str:
        """An explicit ffmpeg_bin wins; the bare default falls back to the
        managed download in <data_dir>/bin when one exists. The desktop
        shell installs ffmpeg there but spawns the engine without pointing
        at it, so PATH-less machines would otherwise fail every assembly."""
        if self.ffmpeg_bin != "ffmpeg":
            return self.ffmpeg_bin
        exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        managed = self.data_dir / "bin" / exe
        return str(managed) if managed.exists() else self.ffmpeg_bin

    @property
    def backend_chain(self) -> list[str]:
        chain: list[str] = []
        for name in self.backend.split(","):
            name = name.strip()
            if name == "local":
                # chatterbox before kokoro: it only claims `local:chatterbox`
                # narration; everything else falls through to stock voices.
                chain += ["llm", "comfy", "chatterbox", "kokoro", "align", "ffmpeg"]
            elif name:
                chain.append(name)
        return chain
