"""Deterministic mock backend — the whole pipeline runs without any model
weights, GPU, or ComfyUI install. Used by tests and `--backend mock` dev
mode. Artifacts are small JSON/placeholder files keyed by output hash, so
caching, dirty-subgraph re-execution and the scene-board state machine are
all exercised for real.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..aspects import DEFAULT_ASPECT
from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..schema import Scene, Screenplay
from .base import ExecutionBackend, ExecutionContext

_SUFFIX = {
    NodeKind.SCRIPT: ".screenplay.json",
    NodeKind.KEYFRAME: ".png",
    NodeKind.CLIP: ".mp4",
    NodeKind.NARRATION: ".wav",
    NodeKind.MUSIC: ".wav",
    NodeKind.CAPTIONS: ".srt",
    NodeKind.TIMELINE: ".timeline.json",
    NodeKind.EXPORT: ".mp4",
    NodeKind.THUMBNAIL: ".png",
}

# Minimal valid 1x1 dark PNG so image artifacts open in a viewer.
_PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415408d763606060000000040001a3612bf80000000049"
    "454e44ae426082"
)


def mock_screenplay(prompt: str, target_duration_s: int, aspect: str, seed: int) -> Screenplay:
    scene_count = max(2, min(10, target_duration_s // 8))
    scenes = [
        Scene(
            id=f"s{i + 1}",
            duration_s=round(target_duration_s / scene_count, 1),
            narration=f"Beat {i + 1} of the story about {prompt[:60]}.",
            visual=f"scene {i + 1}: {prompt[:60]}, establishing shot, variation {seed}",
            motion="slow push-in" if i % 2 == 0 else "gentle pan",
            onscreen_text=None if i else prompt[:24].upper(),
        )
        for i in range(scene_count)
    ]
    return Screenplay(
        title=prompt[:80],
        hook=scenes[0].narration,
        target_duration_s=target_duration_s,
        aspect=aspect,
        scenes=scenes,
    )


_PROGRESS_STEPS = 4


class MockBackend(ExecutionBackend):
    name = "mock"

    def supports(self, kind: NodeKind) -> bool:
        return kind in _SUFFIX

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        for step in range(_PROGRESS_STEPS):
            await ctx.progress((step + 1) / _PROGRESS_STEPS)

        out = ctx.output_path(spec.output_hash, _SUFFIX[spec.kind])
        if spec.kind is NodeKind.SCRIPT:
            screenplay = mock_screenplay(
                prompt=str(spec.params.get("prompt", "")),
                target_duration_s=int(spec.params.get("target_duration_s", 60)),
                aspect=str(spec.params.get("aspect", DEFAULT_ASPECT)),
                seed=spec.seed,
            )
            out.write_text(screenplay.model_dump_json(indent=2))
        elif spec.kind in (NodeKind.KEYFRAME, NodeKind.THUMBNAIL):
            out.write_bytes(_PNG_1PX)
        elif spec.kind in (NodeKind.TIMELINE, NodeKind.CAPTIONS):
            out.write_text(
                json.dumps({"node": spec.node_id, "inputs": spec.input_hashes}, indent=2)
            )
        else:
            # Media placeholder: enough to exercise artifact plumbing.
            out.write_bytes(json.dumps({"mock": spec.node_id, "seed": spec.seed}).encode())
        return out
