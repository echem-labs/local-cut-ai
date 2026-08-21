import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Voices } from "../api/types";
import { m, t } from "../i18n";
import { VOICE_SWATCHES } from "../lib/tools";

/** The bundled 2-second samples the voice swatches play. Resolved at build
 * time by Vite; keyed by the kokoro speaker each swatch's brief picks. */
const VOICE_SAMPLES: Record<string, string> = Object.fromEntries(
  VOICE_SWATCHES.map((swatch) => [
    swatch.voice,
    new URL(`../assets/voices/${swatch.voice}.wav`, import.meta.url).href,
  ]),
);

/** The five-swatch fast path onto a narration voice, with the way into the
 * rest of the pack beside it.
 *
 * A swatch writes a BRIEF ("deep"), not the id of the voice its sample
 * happens to be: the brief is what the engine is asked for, and what the
 * chain resolves when no pack is installed. The samples are bundled, so
 * the row is useful with no engine at all — only the button into the other
 * forty-nine needs one.
 *
 * Shared by Home's voiceover panel and a voiceover session, which is why
 * the caller owns the state: on Home the brief is a draft, in a session it
 * is a node's params, and one of those re-renders when it moves.
 */
export function VoiceSwatches({
  voices,
  brief,
  voiceId,
  onPickBrief,
  onOpenPicker,
}: {
  voices: Voices | null;
  brief: string;
  voiceId: string | null;
  onPickBrief: (brief: string) => void;
  onOpenPicker: () => void;
}) {
  // The one swatch audio element — starting a second sample stops the
  // first, so two speakers never talk over each other. `playing` mirrors it
  // into render state so the active swatch shows a stop.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const playSample = (voice: string) => {
    audioRef.current?.pause();
    if (playing === voice) {
      setPlaying(null);
      return;
    }
    const audio = new Audio(VOICE_SAMPLES[voice]);
    audioRef.current = audio;
    audio.addEventListener("ended", () => setPlaying(null));
    setPlaying(voice);
    // play() returns undefined in environments without media (jsdom).
    const request = audio.play();
    if (request)
      void request.catch(() => {
        /* autoplay policy or a missing device — the swatch still selects */
        setPlaying((current) => (current === voice ? null : current));
      });
  };

  return (
    <div className="voice-swatches" role="group" aria-label={t("voices.swatchesAria")}>
      {VOICE_SWATCHES.map((swatch) => {
        const name = m().voices.names[swatch.voice];
        // A picked id outranks the brief at render, and a node can hold
        // both — picking from the full pack leaves whatever brief was
        // already there. So a swatch is only shown as chosen when nothing
        // else is speaking for the node; otherwise the row would name one
        // voice while another is heard.
        const active = !voiceId && brief.trim() === swatch.brief;
        return (
          <span key={swatch.voice} className={`voice-swatch${active ? " active" : ""}`}>
            <button
              className="swatch-play"
              onClick={() => playSample(swatch.voice)}
              aria-label={t(
                playing === swatch.voice ? "voices.sampleStopAria" : "voices.samplePlayAria",
                { name },
              )}
            >
              {playing === swatch.voice ? (
                <Square size={11} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Play size={11} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
            <button
              className="swatch-name"
              // Clears the pick for the reason picking clears nothing:
              // the brief is only read when no id is set, so leaving an
              // id behind would light this swatch up while another voice
              // is what actually speaks.
              onClick={() => onPickBrief(swatch.brief)}
              aria-label={t("voices.swatchAria", { name })}
            >
              {name}
            </button>
          </span>
        );
      })}
      {/* The five swatches are the fast path and keep their bundled
          samples; the pack holds fifty-four, and the rest are one press
          away rather than unreachable. It names the pick when there is
          one — no swatch is lit for a voice chosen from the pack, so this
          is the only thing on the row that can say what speaks. */}
      {voices?.available && (
        <button className="swatch-more" onClick={onOpenPicker}>
          {voiceId
            ? t("voices.current", {
                name: voices.voices.find((v) => v.id === voiceId)?.name ?? voiceId,
              })
            : t("voices.more", { count: voices.voices.length })}
        </button>
      )}
    </div>
  );
}
