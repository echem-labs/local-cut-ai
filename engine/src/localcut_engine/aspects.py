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

# Export encode choices — the per-platform encode params the export node
# accepts. Closed sets on purpose, so the NL-edit whitelist, the ffmpeg
# consumer and the desktop's preset bundles agree; the desktop mirror lives
# in formats.ts and test_ui_contract compares the two.
EXPORT_FPS_CHOICES = (24, 25, 30, 50, 60)
# The short side of the frame; the aspect keeps its shape. Values at or
# above the aspect's own canvas mean "native" — export never upscales.
EXPORT_SHORT_SIDE_CHOICES = (480, 720, 1080)
EXPORT_VIDEO_KBPS_BOUNDS = (1000, 50000)
EXPORT_AUDIO_KBPS_BOUNDS = (64, 320)


def resolution_for(table: dict[str, tuple[int, int]], aspect: str) -> tuple[int, int]:
    return table.get(aspect, table[DEFAULT_ASPECT])
