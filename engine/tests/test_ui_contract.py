"""Bounds the desktop UI mirrors from the engine.

There is no desktop test infrastructure, so numbers duplicated in the React
app have nothing asserting they still match the engine — and DURATION_BOUNDS
has already drifted once. These tests parse the TypeScript source and compare
it against the Python constants, which costs nothing and fails loudly on the
next drift.

Skipped when the desktop app is not checked out beside the engine (an
engine-only deployment is a supported layout).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_FORMATS = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src" / "lib" / "formats.ts"

pytestmark = pytest.mark.skipif(
    not _FORMATS.exists(), reason="desktop app not present beside the engine"
)


def _source() -> str:
    return _FORMATS.read_text(encoding="utf-8")


def _number(pattern: str) -> float:
    match = re.search(pattern, _source())
    assert match, f"{_FORMATS.name} no longer matches {pattern!r} — update this test with it"
    return float(match.group(1))


def test_target_duration_bounds_match_the_api():
    """DURATION_BOUNDS mirrors CreateProject.target_duration_s. A UI maximum
    above the API's produces a 422 the user cannot act on; below it, a length
    the engine would happily accept is unreachable."""
    import inspect

    from localcut_engine.api import app as app_module

    source = inspect.getsource(app_module)
    api = re.search(r"target_duration_s: int = Field\(default=\d+, ge=(\d+), le=(\d+)\)", source)
    assert api, "the target_duration_s Field no longer matches — update this test with it"

    bounds = re.search(r"DURATION_BOUNDS = \{ min: (\d+), max: (\d+) \}", _source())
    assert bounds, "DURATION_BOUNDS no longer matches — update this test with it"
    assert bounds.group(1) == api.group(1), "UI minimum duration drifted from the API"
    assert bounds.group(2) == api.group(2), "UI maximum duration drifted from the API"


def test_clip_duration_bounds_match_the_editor():
    """The Inspector clamps duration_s to these before sending. Drift means
    either a value the engine silently re-clamps (so the UI lies about what
    was saved) or one it rejects outright."""
    from localcut_engine.graph.editor import _CLIP_MAX_S, _CLIP_MIN_S

    assert _number(r"export const CLIP_MIN_S = ([\d.]+)") == _CLIP_MIN_S
    assert _number(r"export const CLIP_MAX_S = ([\d.]+)") == _CLIP_MAX_S


def test_speed_bounds_match_the_editor():
    from localcut_engine.graph.editor import _SPEED_MAX, _SPEED_MIN

    assert _number(r"export const SPEED_MIN = ([\d.]+)") == _SPEED_MIN
    assert _number(r"export const SPEED_MAX = ([\d.]+)") == _SPEED_MAX


def test_the_ws_token_subprotocol_matches_on_both_sides():
    """The client offers this marker and the server must echo it back; a
    mismatch fails every WebSocket handshake, so the app connects and then
    never receives a progress event again."""
    from localcut_engine.api.app import WS_TOKEN_SUBPROTOCOL

    client = _FORMATS.parent.parent / "api" / "client.ts"
    match = re.search(r'const WS_TOKEN_SUBPROTOCOL = "([^"]+)"', client.read_text(encoding="utf-8"))
    assert match, "client.ts no longer declares WS_TOKEN_SUBPROTOCOL"
    assert match.group(1) == WS_TOKEN_SUBPROTOCOL
