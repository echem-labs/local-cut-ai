"""Renders the voice swatch previews the Home screen plays.

    apps/desktop/src/assets/voices/<voice>.wav   one per lib/tools.ts swatch

The previews exist so a brief can be heard before it is rendered, which
only works while they are synthesized the same way a render is. They were
generated once by hand, and when the phonemizer language stopped being
hardcoded to American English the British swatch kept the American vowels
it had been baked with -- the preview and the render disagreed, with
nothing to catch it. This script is the answer to that: the previews are
derived from the same backend the engine renders with, so re-running it
reproduces them rather than reproducing whatever was done the first time.

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

from localcut_engine.backends.base import ExecutionContext  # noqa: E402
from localcut_engine.backends.kokoro import KokoroBackend  # noqa: E402
from localcut_engine.config import EngineConfig  # noqa: E402
from localcut_engine.graph.compiler import JobSpec  # noqa: E402
from localcut_engine.graph.model import NodeKind  # noqa: E402

# One line for every swatch, so the previews differ only by voice. Long
# enough to hear a vowel the accents actually disagree on -- "last" and
# "past" are the ones that separate en-gb from en-us.
SAMPLE_LINE = "The last of the light passed over the water, and the harbour went quiet."

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
    backend = KokoroBackend(models_dir=EngineConfig.from_env().resolved_models_dir)
    installed = {voice["id"] for voice in backend.installed_voices()}
    if not installed:
        raise SystemExit("no Kokoro pack found - run: localcut download kokoro-82m")

    ASSETS.mkdir(parents=True, exist_ok=True)
    for voice in swatch_voices():
        if voice not in installed:
            raise SystemExit(f"the pack has no voice {voice!r}, which a swatch offers")
        spec = JobSpec(
            node_id="voiceover",
            kind=NodeKind.NARRATION,
            output_hash=voice,
            params={"text": SAMPLE_LINE, "voice_id": voice},
            model=None,
            seed=0,
            input_hashes={},
        )
        rendered = await backend.execute(spec, ExecutionContext(output_dir=ASSETS))
        # execute() publishes under the content hash; the app loads these by
        # voice id, and the id IS the hash above, so this only fixes the suffix.
        rendered.replace(ASSETS / f"{voice}.wav")
        print(f"  {voice}.wav")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
