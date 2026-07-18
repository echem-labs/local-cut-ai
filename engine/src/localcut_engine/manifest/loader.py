"""Manifest resolution: a user/CDN-refreshed manifest in the data dir wins,
falling back to the packaged default (signature verification joins when the
manifest CDN ships). User-added custom entries live in a SEPARATE
custom-models.json and are merged on top, so adding a personal model never
freezes the curated catalog. Parsed manifests are cached on the source
files' mtimes so per-request reads don't re-validate multi-KB JSON."""

from __future__ import annotations

import importlib.resources

from ..config import EngineConfig
from .model import ModelManifest

_cache: dict[tuple[str, float, float], ModelManifest] = {}


def _mtime(path) -> float:
    return path.stat().st_mtime if path.exists() else -1.0


def load_manifest(config: EngineConfig) -> ModelManifest:
    override = config.data_dir / "model-manifest.json"
    custom = config.data_dir / "custom-models.json"
    key = (str(override), _mtime(override), _mtime(custom))
    if key not in _cache:
        _cache.clear()  # only ever one live manifest per process
        if key[1] >= 0:
            manifest = ModelManifest.load(override)
        else:
            bundled = (
                importlib.resources.files("localcut_engine.manifest") / "default-manifest.json"
            )
            manifest = ModelManifest.model_validate_json(bundled.read_text())
        if key[2] >= 0:
            extra = ModelManifest.load(custom)
            known = {m.id for m in manifest.models}
            merged = manifest.models + [m for m in extra.models if m.id not in known]
            manifest = manifest.model_copy(update={"models": merged})
        _cache[key] = manifest
    return _cache[key]
