"""Aspect-ratio registry — the single home for supported aspects and the
per-stage resolutions they map to. Backends must not define their own
tables: adding an aspect here is the whole change.
"""

from __future__ import annotations

# SDXL-native sizes for storyboard images.
IMAGE_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "1:1": (1024, 1024),
}

# LTX-friendly draft sizes for video generation (/32 dims).
VIDEO_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "16:9": (768, 448),
    "9:16": (448, 768),
    "1:1": (576, 576),
}

# Final export canvas.
EXPORT_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
}

DEFAULT_ASPECT = "16:9"


def resolution_for(table: dict[str, tuple[int, int]], aspect: str) -> tuple[int, int]:
    return table.get(aspect, table[DEFAULT_ASPECT])
