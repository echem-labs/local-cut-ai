import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { t } from "../i18n";
import { shortDuration } from "../lib/time";
import { WavePlot, useArtifactPeaks } from "./WavePlot";

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
  const peaks = useArtifactPeaks(projectId, hash);
  /** Fraction of the track played, 0..1 — paints the bars behind it. */
  const [played, setPlayed] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Pointer position over the bars, 0..1 — drives the seek-time tip. */
  const [hover, setHover] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // The transport belongs to the artifact, not to this component. A
  // regenerate swaps `hash` under a mounted player: the element's own
  // currentTime resets with its src, but nothing fires `timeupdate` until the
  // new track plays, so a position left over from the old one paints the new
  // bars and its clock to somewhere it has never been.
  useEffect(() => setPlayed(0), [projectId, hash]);

  const fractionAt = (event: React.MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };

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
            <WavePlot peaks={peaks.peaks} played={played} />
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
