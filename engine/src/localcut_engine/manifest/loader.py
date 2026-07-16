"""Manifest resolution: a user/CDN-refreshed manifest in the data dir wins,
falling back to the packaged default (signature verification joins when the
manifest CDN ships)."""

from __future__ import annotations

import importlib.resources

from ..config import EngineConfig
from .model import ModelManifest


def load_manifest(config: EngineConfig) -> ModelManifest:
    override = config.data_dir / "model-manifest.json"
    if override.exists():
        return ModelManifest.load(override)
    bundled = importlib.resources.files("localcut_engine.manifest") / "default-manifest.json"
    return ModelManifest.model_validate_json(bundled.read_text())
