"""Capability probe — which node kinds the installed weights can serve.

The default ("auto") comfy_kinds claims kinds from this instead of a
hand-set list: a machine without a video model falls through to the
still-clip tier instead of failing renders, and starts claiming clips
the moment the weights finish downloading — no restart, no env var.
"""

from __future__ import annotations

import logging

from ..config import EngineConfig
from ..graph.model import NodeKind
from .downloads import is_downloaded
from .loader import load_manifest

logger = logging.getLogger(__name__)

# Manifest task ids able to serve each ComfyUI-eligible node kind.
COMFY_TASKS: dict[NodeKind, tuple[str, ...]] = {
    NodeKind.KEYFRAME: ("image.gen",),
    NodeKind.THUMBNAIL: ("image.gen",),
    NodeKind.CLIP: ("video.i2v", "video.t2v"),
    NodeKind.MUSIC: ("music.gen",),
}


def installed_comfy_models(config: EngineConfig) -> dict[NodeKind, list[str]]:
    """Kind -> ids of fully-downloaded models able to serve it. Recomputed
    per call (a stat per manifest file): a download finishing mid-session
    must flip capability without an engine restart."""
    try:
        manifest = load_manifest(config)
    except (OSError, ValueError):
        # A broken override manifest already surfaces on /models; claiming
        # nothing here keeps renders on the fallback tiers instead of
        # submitting workflows whose weights are unknowable.
        logger.warning("model manifest unreadable — ComfyUI claims no kinds")
        return {kind: [] for kind in COMFY_TASKS}
    models_dir = config.resolved_models_dir
    ready: dict[str, list[str]] = {}
    for entry in manifest.models:
        if is_downloaded(entry, models_dir):
            ready.setdefault(entry.task, []).append(entry.id)
    return {
        kind: [mid for task in tasks for mid in ready.get(task, [])]
        for kind, tasks in COMFY_TASKS.items()
    }


def installed_comfy_kinds(config: EngineConfig) -> set[NodeKind]:
    return {kind for kind, models in installed_comfy_models(config).items() if models}
