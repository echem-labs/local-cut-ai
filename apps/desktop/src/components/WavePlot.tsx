import { useEffect, useState } from "react";

import type { AudioPeaks } from "../api/types";
import { useApp } from "../store";

/** Enough bars for any width this renders at; the engine caches per
 * (artifact, bins), so a shared constant also means a shared cache entry —
 * the timeline lane and the session player ask for the same file and the
 * engine decodes it once. */
export const BINS = 192;

/**
 * The bars, and nothing else.
 *
 * Extracted from `Waveform` so the timeline's audio lanes can draw the same
 * shape without inheriting a play button, a seek surface and a clock. The
 * player is one use of a waveform; a lane in a timeline is another, and the
 * only thing they share is this.
 */
export function WavePlot({
  peaks,
  played = 0,
  className,
}: {
  peaks: number[];
  /** Fraction already played, 0..1 — those bars take the `played` class.
   * A lane that is not a transport passes nothing. */
  played?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${peaks.length} 64`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {peaks.map((peak, index) => {
        const height = Math.max(2, peak * 60);
        return (
          <rect
            key={index}
            x={index + 0.12}
            y={(64 - height) / 2}
            width={0.76}
            height={height}
            className={(index + 1) / peaks.length <= played ? "played" : undefined}
          />
        );
      })}
    </svg>
  );
}

/**
 * An artifact's waveform shape, computed and cached engine-side.
 *
 * Null while loading AND when the artifact is not decodable audio (a mock
 * placeholder) or the engine has no ffmpeg. Callers treat all three the
 * same: no wave. It is a reading aid, never a gate — a 422 or 503 here must
 * not take the surface down with it.
 */
export function useArtifactPeaks(projectId: string | null, hash: string | null): AudioPeaks | null {
  const client = useApp((state) => state.client);
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null);

  useEffect(() => {
    setPeaks(null);
    if (!client || !projectId || !hash) return;
    let stale = false;
    client
      .artifactPeaks(projectId, hash, BINS)
      .then((result) => {
        if (!stale) setPeaks(result);
      })
      .catch(() => {
        /* undecodable, or an engine with no ffmpeg — no wave, no error */
      });
    return () => {
      stale = true;
    };
  }, [client, projectId, hash]);

  return peaks;
}
