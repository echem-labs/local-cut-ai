import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { AudioPeaks } from "../api/types";
import { t } from "../i18n";
import { shortDuration } from "../lib/time";
import { useApp } from "../store";

/** Enough bars for any panel width this renders at; the engine caches per
 * (artifact, bins), so a shared constant also means a shared cache entry. */
const BINS = 192;

/** Waveform player for an audio artifact — the wave IS the player: one
 * play/pause control, the bars as the seek surface, a time readout.
 *
 * The shape comes from the engine's peaks route — computed once and cached
 * server-side — so the renderer never decodes audio. A session whose
 * artifact is not decodable audio (mock placeholders) just gets the bare
 * native player: the wave is a reading aid, never a gate.
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
  const [playing, setPlaying] = useState(false);
  /** Pointer position over the bars, 0..1 — drives the seek-time tip. */
  const [hover, setHover] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const fractionAt = (event: React.MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };

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
        /* undecodable or no ffmpeg — the native player below still works */
      });
    return () => {
      stale = true;
    };
  }, [client, projectId, hash]);

  const seek = (event: React.MouseEvent<HTMLButtonElement>) => {
    const audio = audioRef.current;
    if (!audio || !peaks) return;
    const fraction = fractionAt(event);
    audio.currentTime = fraction * peaks.duration_s;
    setPlayed(fraction);
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // play() returns undefined in environments without media (jsdom).
      const request = audio.play();
      if (request) void request.catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  return (
    <div className="waveform">
      {peaks && peaks.peaks.length > 0 && (
        <div className="wave-player">
          <button
            type="button"
            className="wave-toggle"
            aria-label={t(playing ? "toolSession.wavePauseAria" : "toolSession.wavePlayAria")}
            onClick={toggle}
          >
            {playing ? (
              <Pause size={15} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Play size={15} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="wave-plot"
            aria-label={t("toolSession.waveSeekAria")}
            onClick={seek}
            onMouseMove={(event) => setHover(fractionAt(event))}
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox={`0 0 ${peaks.peaks.length} 64`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
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
            {/* Presentational only (the button already carries the seek
                aria); shows where a click would land you. */}
            {hover != null && (
              <span
                className="wave-seek-tip"
                style={{ left: `${hover * 100}%` }}
                aria-hidden="true"
              >
                {shortDuration(hover * peaks.duration_s)}
              </span>
            )}
          </button>
          <span className="wave-time">
            {shortDuration(played * peaks.duration_s)} / {shortDuration(peaks.duration_s)}
          </span>
        </div>
      )}
      {/* With peaks the element is the hidden driver behind the wave; with
          none it stays visible as the whole player. */}
      <audio
        ref={audioRef}
        controls={!peaks || peaks.peaks.length === 0}
        hidden={!!peaks && peaks.peaks.length > 0}
        src={src}
        aria-label={ariaLabel}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          if (audio.duration > 0) setPlayed(audio.currentTime / audio.duration);
        }}
        onEnded={() => {
          setPlayed(1);
          setPlaying(false);
        }}
      />
    </div>
  );
}
