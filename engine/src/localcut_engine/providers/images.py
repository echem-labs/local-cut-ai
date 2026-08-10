"""Encoding an image for a provider that takes one inline.

Shared rather than per-adapter: fal's video models and the vision-capable
text models all take the same picture, and the one thing that is easy to get
wrong is the same for all of them — a conditioning image reaches us either
as a generated keyframe (.png) or as a user asset, which the API accepts as
.jpg/.jpeg/.webp too and stores under that suffix. Declaring every one of
them as png mislabels the payload for every scene the user conditioned on
their own photo.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path

IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def mime_type(path: Path) -> str:
    """The image's real media type, or the honest fallback.

    `application/octet-stream` rather than a guess: a provider rejecting an
    unlabelled payload is a better outcome than one decoding a .webp as a
    .png and returning something plausible about the wrong picture.
    """
    return IMAGE_MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _encode(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


async def encoded(path: Path) -> str:
    """The image's bytes, base64'd, without stalling the event loop.

    An asset is allowed up to `_ASSET_MAX_BYTES`, and reading one of those
    and encoding it inline blocks the loop for the whole read plus a buffer
    a third larger again — during which no other request advances and no
    progress frame reaches the `/ws` fan-out. The routes that reach these
    adapters already put their own file work behind `asyncio.to_thread`;
    an adapter awaited from one of them has to keep the same rule.
    """
    return await asyncio.to_thread(_encode, path)


async def data_url(path: Path) -> str:
    """`data:<mime>;base64,<bytes>` — the form every inline-image API takes."""
    return f"data:{mime_type(path)};base64,{await encoded(path)}"
