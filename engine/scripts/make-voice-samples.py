"""Renders the voice swatch previews the Home screen plays.

    apps/desktop/src/assets/voices/<voice>.wav   one per lib/tools.ts swatch

The previews exist so a brief can be heard before it is rendered, which
only works while they are synthesized the same way a render is. A preview
made by hand cannot hold that: nothing tells anyone it has drifted from
what the engine now produces, and the drift is audible only to a user
comparing the swatch with the finished cut. So the previews are derived
from the same backend the engine renders with, through the same manifest
paths, and re-running this reproduces them.

Needs the Kokoro pack (`localcut download kokoro-82m`); the previews ship
as committed bytes, so run this and commit the result after any change to
how narration is synthesized.

    engine/.venv/bin/python engine/scripts/make-voice-samples.py
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine" / "src"))

from localcut_engine.api.app import _model_dests  # noqa: E402
from localcut_engine.backends.kokoro import KokoroBackend  # noqa: E402
from localcut_engine.config import EngineConfig  # noqa: E402

ASSETS = ROOT / "apps" / "desktop" / "src" / "assets" / "voices"
SWATCHES = ROOT / "apps" / "desktop" / "src" / "lib" / "tools.ts"


def swatch_voices() -> list[str]:
    """The voices lib/tools.ts offers, read from it rather than repeated.

    A list here would be a third place the five are written down, which is
    the drift test_ui_contract.py already exists to catch between the other
    two.
    """
    block = re.search(
        r"const VOICE_SWATCHES\s*=\s*\[(.*?)\]\s*as const", SWATCHES.read_text("utf-8"), re.S
    )
    if not block:
        raise SystemExit("lib/tools.ts no longer declares VOICE_SWATCHES")
    return re.findall(r'voice:\s*"([^"]+)"', block.group(1))


async def main() -> int:
    # Constructed the way _build_backends constructs it, manifest dests and
    # all: a backend probing the packaged fallback paths would render the
    # committed previews from a pack the engine no longer narrates with, or
    # report no pack at all on a machine where narration works.
    config = EngineConfig.from_env()
    backend = KokoroBackend(
        models_dir=config.resolved_models_dir,
        file_dests=_model_dests(config, "kokoro-82m"),
    )
    installed = {voice["id"] for voice in backend.installed_voices()}
    if not installed:
        raise SystemExit("no Kokoro pack found - run: localcut download kokoro-82m")

    ASSETS.mkdir(parents=True, exist_ok=True)
    for voice in swatch_voices():
        if voice not in installed:
            raise SystemExit(f"the pack has no voice {voice!r}, which a swatch offers")
        rendered = await backend.render_preview(voice, ASSETS)
        print(f"  {rendered.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
