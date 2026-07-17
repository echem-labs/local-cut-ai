"""Manifest resolution: a user/CDN-refreshed manifest in the data dir wins,
falling back to the packaged default (signature verification joins when the
manifest CDN ships). Parsed manifests are cached on the override file's
mtime so per-request reads don't re-validate multi-KB JSON."""

from __future__ import annotations

import importlib.resources

from ..config import EngineConfig
from .model import ModelManifest

_cache: dict[tuple[str, float], ModelManifest] = {}


def load_manifest(config: EngineConfig) -> ModelManifest:
    override = config.data_dir / "model-manifest.json"
    mtime = override.stat().st_mtime if override.exists() else -1.0
    key = (str(override), mtime)
    if key not in _cache:
        _cache.clear()  # only ever one live manifest per process
        if mtime >= 0:
            _cache[key] = ModelManifest.load(override)
        else:
            bundled = (
                importlib.resources.files("localcut_engine.manifest") / "default-manifest.json"
            )
            _cache[key] = ModelManifest.model_validate_json(bundled.read_text())
    return _cache[key]
