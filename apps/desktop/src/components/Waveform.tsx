import { useEffect, useRef, useState } from "react";
import type { AudioPeaks } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";

/** Enough bars for any panel width this renders at; the engine caches per
 * (artifact, bins), so a shared constant also means a shared cache entry. */
const BINS = 192;

/** Waveform + player for an audio artifact.
 *
 * The shape comes from the engine's peaks route — computed once and cached
 * server-side — so the renderer never decodes audio. A session whose
 * artifact is not decodable audio (mock placeholders) just gets the bare
 * player: the wave is a reading aid, never a gate.
 */
export function Waveform({
  projectId,
  hash,
  src,
  ariaLabel,
}: {
  projectId: string;
  hash: string;
  src: string;
  ariaLabel: string;
}) {
  const client = useApp((state) => state.client);
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null);
  /** Fraction of the track played, 0..1 — paints the bars behind it. */
  const [played, setPlayed] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    setPeaks(null);
    setPlayed(0);
    if (!client) return;
    let stale = false;
    client
      .artifactPeaks(projectId, hash, BINS)
      .then((result) => {
        if (!stale) setPeaks(result);
      })
      .catch(() => {
        /* undecodable or no ffmpeg — the player below still works */
      });
    return () => {
      stale = true;
    };
  }, [client, projectId, hash]);

  const seek = (event: React.MouseEvent<HTMLButtonElement>) => {
    const audio = audioRef.current;
    if (!audio || !peaks) return;
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    audio.currentTime = fraction * peaks.duration_s;
    setPlayed(fraction);
  };

  return (
    <div className="waveform">
      {peaks && peaks.peaks.length > 0 && (
        <button
          type="button"
          className="wave-plot"
          aria-label={t("toolSession.waveSeekAria")}
          onClick={seek}
        >
          <svg viewBox={`0 0 ${peaks.peaks.length} 64`} preserveAspectRatio="none" aria-hidden="true">
            {peaks.peaks.map((peak, index) => {
              const height = Math.max(2, peak * 60);
              return (
                <rect
                  key={index}
                  x={index + 0.12}
                  y={(64 - height) / 2}
                  width={0.76}
                  height={height}
                  className={(index + 1) / peaks.peaks.length <= played ? "played" : undefined}
                />
              );
            })}
          </svg>
        </button>
      )}
      <audio
        ref={audioRef}
        controls
        src={src}
        aria-label={ariaLabel}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (audio.duration > 0) setPlayed(audio.currentTime / audio.duration);
        }}
        onEnded={() => setPlayed(1)}
      />
    </div>
  );
}
