"""Music beat analysis for beat-aligned cuts.

Generated music beds (ACE-Step and friends) hold a steady tempo, which is
exactly the regime a lightweight detector handles well: onset strength from
spectral-free energy flux, tempo by autocorrelation over the plausible BPM
range, beat phase by grid fit. No librosa/aubio dependency — numpy rides in
with the TTS stack already, and the whole analysis is a few milliseconds of
array math on a decoded mono track.

The timeline builder uses the resulting grid to *snap* scene boundaries: a
cut may only stretch or shrink the breathing pad after a narration line,
never the speech itself, so alignment degrades gracefully when beats and
narration disagree.
"""

from __future__ import annotations

import numpy as np

ANALYSIS_RATE = 22050  # mono decode rate for beat analysis
_FRAME = 1024
_HOP = 512
_BPM_MIN, _BPM_MAX = 60.0, 180.0


def onset_strength(samples: np.ndarray, hop: int = _HOP, frame: int = _FRAME) -> np.ndarray:
    """Positive log-energy flux per hop — spikes where hits/notes land."""
    if samples.size < frame:
        return np.zeros(0)
    count = 1 + (samples.size - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    energy = np.log1p(np.sum(samples[idx].astype(np.float64) ** 2, axis=1))
    flux = np.diff(energy, prepend=energy[:1])
    return np.maximum(flux, 0.0)


def estimate_beats(samples: np.ndarray, sample_rate: int = ANALYSIS_RATE) -> list[float]:
    """Beat times (seconds) for a steady-tempo track; [] when no periodicity
    stands out (ambient pads, silence) — callers then skip snapping."""
    flux = onset_strength(samples)
    if flux.size == 0 or float(np.max(flux)) <= 0.0:
        return []
    flux = flux / np.max(flux)

    seconds_per_hop = _HOP / sample_rate
    lag_min = max(2, int(round(60.0 / _BPM_MAX / seconds_per_hop)))
    lag_max = min(flux.size // 2, int(round(60.0 / _BPM_MIN / seconds_per_hop)))
    if lag_max <= lag_min:
        return []

    # Tempo: autocorrelation peak across the plausible lag range. The true
    # period is rarely a whole number of hops, and a fractional period scores
    # cleanly only at its integer multiples — so take the winner, then prefer
    # a subdivision of it that still carries real self-similarity (this also
    # lands hi-hat-subdivided tracks on the finer grid, which is what a cut
    # wants to snap to anyway).
    centered = flux - np.mean(flux)
    scores = {
        lag: float(np.dot(centered[:-lag], centered[lag:])) for lag in range(lag_min, lag_max + 1)
    }
    best = max(scores, key=lambda lag: scores[lag])
    if scores[best] <= 0.0:
        return []  # no self-similarity → no usable tempo
    period = float(best)
    for div in (3, 2):
        candidate = period / div
        if candidate >= lag_min:
            near = max(
                scores.get(int(np.floor(candidate)), 0.0),
                scores.get(int(np.ceil(candidate)), 0.0),
            )
            if near >= 0.4 * scores[best]:
                period = candidate
                break

    # Phase: circular mean of onset strength against the (possibly
    # fractional) period — drift-free, sub-hop resolution.
    angles = 2.0 * np.pi * (np.arange(flux.size) % period) / period
    y, x = float(np.sum(flux * np.sin(angles))), float(np.sum(flux * np.cos(angles)))
    offset = (np.arctan2(y, x) / (2.0 * np.pi)) % 1.0 * period if (x or y) else 0.0

    times = np.arange(offset, float(flux.size), period) * seconds_per_hop
    return [round(float(t), 3) for t in times]


def nearest_beat(
    t: float, beats: list[float], period: float | None, lo: float, hi: float
) -> float | None:
    """The beat closest to `t` inside [lo, hi], on a grid that repeats every
    `period` seconds (the music bed loops). None when no beat qualifies."""
    if not beats or hi <= lo:
        return None
    candidates: list[float] = []
    if period and period > 0:
        cycle = int(t // period)
        for k in (cycle - 1, cycle, cycle + 1):
            if k >= 0:
                candidates.extend(k * period + b for b in beats)
    else:
        candidates = beats
    # Filter to the window FIRST, then pick the closest — otherwise a nearer
    # out-of-window beat shadows a valid in-window one and the snap is skipped.
    in_window = [b for b in candidates if lo <= b <= hi]
    if not in_window:
        return None
    return round(min(in_window, key=lambda b: abs(b - t)), 3)
