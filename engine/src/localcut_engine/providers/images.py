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
from collections.abc import Iterator
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


# A multiple of 3, so every block but the last encodes to a whole number of
# base64 quads and the concatenation is byte-identical to encoding the file
# in one call. 768 KiB costs about 8ms a block, which is the granularity at
# which the loop gets to run.
_BLOCK_BYTES = 3 * 256 * 1024


def _blocks(path: Path) -> Iterator[str]:
    """The file's base64, a block at a time.

    Block by block rather than in one `b64encode`, because that is a single
    C call that never releases the GIL: handed a 50 MiB asset it pins the
    interpreter for its whole duration, and putting it in a thread then buys
    nothing at all — the loop thread cannot run a bytecode until it returns.
    Between blocks the GIL is released, so the loop actually advances.
    """
    with path.open("rb") as handle:
        while block := handle.read(_BLOCK_BYTES):
            yield base64.b64encode(block).decode()


def _encode(path: Path) -> str:
    return "".join(_blocks(path))


def _data_url(path: Path) -> str:
    # The prefix joins in the same pass, so the caller's thread does the
    # whole assembly: prepending it after the fact would copy the entire
    # encoded string again, on the event loop.
    return "".join([f"data:{mime_type(path)};base64,", *_blocks(path)])


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
    return await asyncio.to_thread(_data_url, path)
