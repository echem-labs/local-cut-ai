"""Deterministic mock backend — the whole pipeline runs without any model
weights, GPU, or ComfyUI install. Used by tests and `--backend mock` dev
mode. Artifacts are small placeholder files keyed by output hash, so
caching, dirty-subgraph re-execution and the scene-board state machine are
all exercised for real.

Stills and audio are real media, slate PNGs and silent WAVs: in a hybrid
chain ffmpeg assembles them, so they have to decode. Clips and exports are
JSON stand-ins, since an MP4 takes an encoder this backend does not have,
and the timeline and captions are JSON records of their inputs.
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import json
import math
import struct
import wave
import zlib
from pathlib import Path

from ..aspects import DEFAULT_ASPECT
from ..graph.compiler import JobSpec
from ..graph.model import NodeKind
from ..graph.templates import GENERATOR_MAX_MUSIC_S
from ..schema import Scene, Screenplay
from .base import ExecutionBackend, ExecutionContext
from .llm import SPEECH_WORDS_PER_S

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


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _slate_png(node_id: str, seed: int, width: int = 320, height: int = 180) -> bytes:
    """A deep-hue gradient slate whose color is stable per (node, seed) —
    the mock board reads as distinct content instead of a black void, and
    a new take visibly changes the card."""
    digest = hashlib.sha256(f"{node_id}:{seed}".encode()).digest()
    hue = digest[0] / 255
    r, g, b = colorsys.hsv_to_rgb(hue, 0.45, 0.34)
    rows = bytearray()
    for y in range(height):
        shade = 1.0 - 0.55 * y / height
        rows.append(0)  # scanline filter: none
        rows += (
            bytes((round(r * 255 * shade), round(g * 255 * shade), round(b * 255 * shade))) * width
        )
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + _png_chunk(b"IEND", b"")
    )


# Placeholder audio has Kokoro's shape (mono 16-bit PCM at 24 kHz), so it
# takes the path real narration takes through assembly.
_AUDIO_RATE = 24_000
# Even a one-word line gets a second. An empty text would otherwise give a
# file with no samples, and the aligner refuses one of those outright.
_MIN_NARRATION_S = 1.0


def silent_wav(seconds: float) -> bytes:
    """`seconds` of silence as a WAV file. The same length gives the same
    bytes."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(_AUDIO_RATE)
        out.writeframes(bytes(2 * round(seconds * _AUDIO_RATE)))
    return buffer.getvalue()


def narration_seconds(text: str) -> float:
    """How long `text` takes to say at the rate scripts are budgeted
    against. Assembly gives each scene the length of its narration, so this
    is what makes a placeholder cut run as long as its script."""
    return max(_MIN_NARRATION_S, len(text.split()) / SPEECH_WORDS_PER_S)


def music_seconds(params: dict) -> float:
    """The length the music node asks for, held inside what the generator
    accepts. A cut longer than the bed loops it, the same as a real one."""
    try:
        seconds = float(params.get("target_duration_s") or 60)
    except (TypeError, ValueError):
        seconds = 60.0
    return min(float(GENERATOR_MAX_MUSIC_S), max(1.0, seconds))


# Distinct per-scene beats — a board of identical filler sentences reads as
# lorem ipsum and hides real layout problems (design review 3). The first
# beat is the hook and carries the prompt, so a script re-run with a new
# prompt visibly (and testably) lands in the scene nodes.
_NARRATION_BEATS = (
    "The first clue hides in plain sight, easy to miss.",
    "Zoom in, and the picture changes completely.",
    "Here the story takes its first real turn.",
    "The numbers behind this are stranger than they look.",
    "Almost nobody expects what happens next.",
    "One small detail ties everything together.",
    "Step back, and the whole pattern becomes visible.",
    "This is the part everyone remembers afterwards.",
    "And that is why it matters more than you'd think.",
)


def mock_screenplay(prompt: str, target_duration_s: int, aspect: str, seed: int) -> Screenplay:
    # ~8s scenes capped at 10 for short videos, but never fewer scenes than
    # the schema's 60s-per-scene ceiling requires (a 1200s target needs ≥20).
    scene_count = max(2, min(10, target_duration_s // 8), math.ceil(target_duration_s / 60))
    scenes = [
        Scene(
            id=f"s{i + 1}",
            duration_s=round(target_duration_s / scene_count, 1),
            narration=(
                f"{prompt[:60]} — it starts with a question most people never ask."
                if i == 0
                else _NARRATION_BEATS[(i - 1) % len(_NARRATION_BEATS)]
            ),
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


# Assembly kinds: the ones that produce something the user takes away and
# treats as the finished thing. A placeholder here is not a degraded result,
# it is a wrong one.
_ASSEMBLY_KINDS = {NodeKind.TIMELINE, NodeKind.EXPORT}


class MockBackend(ExecutionBackend):
    name = "mock"

    def __init__(self, assembly: bool = True) -> None:
        """`assembly=False` makes this backend decline TIMELINE and EXPORT.

        Mock is the catch-all at the end of the hybrid chain, so on a machine
        with no ffmpeg — a stock Windows or macOS box, or a minimal Ubuntu
        install, since the deb declares no dependency — the FFmpeg backend
        declined every kind and assembly fell through to here. The user then
        got a completed "export" that was a placeholder MP4, presented
        exactly like a real one. Declining is what turns that into an error
        they can act on.

        Left on for an explicit all-mock chain, which is the demo/test
        configuration and is not pretending to be anything else.
        """
        self.assembly = assembly

    def supports(self, kind: NodeKind) -> bool:
        if kind in _ASSEMBLY_KINDS and not self.assembly:
            return False
        return kind in _SUFFIX

    async def execute(self, spec: JobSpec, ctx: ExecutionContext) -> Path:
        for step in range(_PROGRESS_STEPS):
            await ctx.progress((step + 1) / _PROGRESS_STEPS)

        # Published like every real backend's output — same temp-and-rename
        # path, so the tests exercise the plumbing the real renders use.
        suffix = _SUFFIX[spec.kind]
        if spec.kind is NodeKind.SCRIPT and spec.params.get("task") == "metadata":
            suffix = ".metadata.json"
            body = json.dumps(
                {
                    "title": "Mock publish title",
                    "description": "Mock description of the video.",
                    "hashtags": ["mock", "localcut"],
                },
                indent=2,
            ).encode()
        elif spec.kind is NodeKind.SCRIPT:
            screenplay = mock_screenplay(
                prompt=str(spec.params.get("prompt", "")),
                target_duration_s=int(spec.params.get("target_duration_s", 60)),
                aspect=str(spec.params.get("aspect", DEFAULT_ASPECT)),
                seed=spec.seed,
            )
            body = screenplay.model_dump_json(indent=2).encode()
        elif spec.kind in (NodeKind.KEYFRAME, NodeKind.THUMBNAIL):
            body = _slate_png(spec.node_id, spec.seed)
        elif spec.kind is NodeKind.NARRATION:
            body = silent_wav(narration_seconds(str(spec.params.get("text", ""))))
        elif spec.kind is NodeKind.MUSIC:
            body = silent_wav(music_seconds(spec.params))
        elif spec.kind in (NodeKind.TIMELINE, NodeKind.CAPTIONS):
            body = json.dumps(
                {"node": spec.node_id, "inputs": spec.input_hashes}, indent=2
            ).encode()
        else:
            # Clip and export: enough to exercise artifact plumbing.
            body = json.dumps({"mock": spec.node_id, "seed": spec.seed}).encode()
        return ctx.publish_bytes(spec.output_hash, suffix, body)
