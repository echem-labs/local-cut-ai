"""Beat analysis: pure-numpy tests on synthetic click tracks — no ffmpeg,
no model weights, deterministic."""

import numpy as np

from localcut_engine.audio import ANALYSIS_RATE, estimate_beats, nearest_beat


def click_track(period_s: float, duration_s: float, offset_s: float = 0.0) -> np.ndarray:
    """Silence with sharp noise bursts every `period_s`, starting at
    `offset_s` — the strongest possible onset signal."""
    rng = np.random.default_rng(7)
    pcm = np.zeros(int(ANALYSIS_RATE * duration_s), dtype=np.float32)
    t = offset_s
    while t < duration_s:
        i = int(t * ANALYSIS_RATE)
        burst = rng.uniform(-0.9, 0.9, 256).astype(np.float32)
        pcm[i : i + burst.size] = burst[: max(0, pcm.size - i)]
        t += period_s
    return pcm


def test_click_track_yields_the_click_grid():
    beats = estimate_beats(click_track(period_s=0.5, duration_s=8.0, offset_s=0.1))
    assert len(beats) >= 10
    intervals = np.diff(beats)
    # One steady tempo, at the click period (fractional-hop grid: intervals
    # may alternate by a rounding millisecond but never drift).
    assert float(np.max(intervals) - np.min(intervals)) <= 0.002
    assert 0.45 <= float(np.mean(intervals)) <= 0.55
    # Phase locks onto the clicks, not between them.
    assert abs(beats[0] - 0.1) < 0.06


def test_silence_yields_no_beats():
    assert estimate_beats(np.zeros(ANALYSIS_RATE * 4, dtype=np.float32)) == []
    assert estimate_beats(np.zeros(100, dtype=np.float32)) == []


def test_nearest_beat_respects_window_and_looping():
    beats = [0.0, 0.5, 1.0, 1.5]
    # Plain lookup inside the window.
    assert nearest_beat(1.4, beats, period=None, lo=1.2, hi=1.7) == 1.5
    # No beat inside the window → no snap.
    assert nearest_beat(1.4, beats, period=None, lo=1.45, hi=1.49) is None
    # The grid repeats with the (looped) track: 2.0s track → beat at 2.5.
    assert nearest_beat(2.45, beats, period=2.0, lo=2.2, hi=2.7) == 2.5
    assert nearest_beat(0.1, [], period=None, lo=0.0, hi=1.0) is None
