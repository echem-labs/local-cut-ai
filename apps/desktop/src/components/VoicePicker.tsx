import { Check, Play, Search, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Voice, Voices } from "../api/types";
import { m, t } from "../i18n";
import { useApp } from "../store";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

/** How a voice's language reads, from the catalog rather than the wire.
 *
 * The engine sends `language_code` — an espeak code — precisely so the words
 * for it live here, where a translator can reach them. A code the catalog
 * does not know renders as the code itself rather than as nothing: a picker
 * row with a blank column is worse than one showing `pt-br`. */
export function languageLabel(code: string | null): string {
  if (!code) return m().voices.unknownLanguage;
  const languages = m().voices.languages as Record<string, string | undefined>;
  return languages[code] ?? code;
}

function genderLabel(gender: string | null): string {
  if (!gender) return m().voices.unknownGender;
  const genders = m().voices.genders as Record<string, string | undefined>;
  return genders[gender] ?? gender;
}

/** The ids whose derived name is shared with another installed voice.
 *
 * The pack's names are derived from the id and are not unique — it ships
 * three Santas and two Alphas — so a list showing names alone offers rows a
 * user cannot tell apart. Rather than print the id against all fifty-four
 * and make every row noisier, it is printed against exactly the ones that
 * need it. */
export function ambiguousNames(voices: Voice[]): Set<string> {
  const seen = new Map<string, number>();
  for (const voice of voices) seen.set(voice.name, (seen.get(voice.name) ?? 0) + 1);
  return new Set(voices.filter((v) => (seen.get(v.name) ?? 0) > 1).map((v) => v.id));
}

/** Voices grouped under their language, each group in pack order.
 *
 * Grouped because the flat list is fifty-four rows deep and the language is
 * the axis a user is actually choosing along. Ordered by the LABEL, not the
 * code: the code order puts Mandarin above both Englishes (`cmn` < `en-`),
 * which is not an order anyone reading the list can see a reason for. The
 * comparison is still code-unit rather than `localeCompare`, so the order is
 * the same on every machine for a given catalog. */
export function groupByLanguage(voices: Voice[]): [string | null, Voice[]][] {
  const groups = new Map<string | null, Voice[]>();
  for (const voice of voices) {
    const key = voice.language_code;
    const group = groups.get(key);
    if (group) group.push(voice);
    else groups.set(key, [voice]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    // Unrecognised last: it is the group a user is least likely to want, and
    // its heading is a word rather than a language.
    if (a === null) return 1;
    if (b === null) return -1;
    const [left, right] = [languageLabel(a), languageLabel(b)];
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Matches a voice against typed text, over the fields a row shows.
 *
 * The id is searched too even when the row does not print it: "bf" is how
 * someone who knows the pack asks for British female, and a picker that
 * only matched the display name would answer nothing. */
function matches(voice: Voice, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  return (
    voice.id.includes(needle) ||
    voice.name.toLowerCase().includes(needle) ||
    languageLabel(voice.language_code).toLowerCase().includes(needle)
  );
}

/** Choose one of the installed narration voices, auditioning before picking.
 *
 * `value` is the explicitly picked id, or null for "whatever the brief
 * resolves to".
 *
 * `canFollow` says whether that null is offered as a row of its own, and
 * only a scene in a project can say yes: clearing a pick there is how the
 * scene goes back to speaking like the rest of the project, which is a
 * choice with a name a reader recognises. Home's quick tool and a tool
 * session each speak for a single node whose "project" is its own session
 * — the row would name a fallback that does not exist. Those two carry the
 * swatch row instead, and a swatch is what drops a pick. Required rather
 * than defaulted: a surface that gains a picker has to answer this.
 */
export function VoicePicker({
  voices,
  value,
  canFollow,
  onPick,
  onClose,
}: {
  voices: Voices;
  value: string | null;
  canFollow: boolean;
  onPick: (voiceId: string | null) => void;
  onClose: () => void;
}) {
  const client = useApp((state) => state.client);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // One audio element for the whole picker: auditioning a second voice stops
  // the first, so two speakers never talk over each other while comparing.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const shown = useMemo(
    () => voices.voices.filter((voice) => matches(voice, query)),
    [voices.voices, query],
  );
  const ambiguous = useMemo(() => ambiguousNames(voices.voices), [voices.voices]);
  const groups = useMemo(() => groupByLanguage(shown), [shown]);

  const audition = (voiceId: string) => {
    audioRef.current?.pause();
    setFailed(null);
    if (playing === voiceId) {
      setPlaying(null);
      return;
    }
    if (!client) return;
    const audio = new Audio(client.voicePreviewUrl(voiceId));
    audioRef.current = audio;
    audio.addEventListener("ended", () => setPlaying(null));
    // The first audition of a voice renders it, which takes seconds; a
    // failure here is the engine saying it cannot, and the row has to say so
    // rather than leaving a play button that silently does nothing.
    audio.addEventListener("error", () => {
      // Both updaters are guarded, and for one reason: `audition` only
      // PAUSES the element it supersedes, so an abandoned request can still
      // fail seconds later. An unguarded setFailed would put "could not play
      // this one" on a row while a different voice is audibly playing.
      setPlaying((current) => (current === voiceId ? null : current));
      setFailed((current) => (audioRef.current === audio ? voiceId : current));
    });
    setPlaying(voiceId);
    const request = audio.play();
    if (request)
      void request.catch(() => {
        // Autoplay policy or a missing device. It rejects the promise
        // without firing `error`, so this is the only thing that can put
        // the row back — otherwise it shows a Stop that stops nothing.
        setPlaying((current) => (current === voiceId ? null : current));
      });
  };

  return (
    <Modal
      title={t("voices.pickerTitle")}
      subtitle={t("voices.pickerSubtitle")}
      size="m"
      onClose={onClose}
      initialFocus={searchRef}
    >
      {!voices.available ? (
        <div className="note" role="note">
          <p>{t("voices.unavailable")}</p>
          <p className="quiet">{t("voices.unavailableHint")}</p>
        </div>
      ) : (
        <>
          <label className="voice-search">
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("voices.searchPlaceholder")}
              aria-label={t("voices.searchAria")}
            />
          </label>

          <div className="voice-list" role="group" aria-label={t("voices.listAria")}>
            {canFollow && (
              <button
                className={`voice-row${value === null ? " active" : ""}`}
                onClick={() => onPick(null)}
              >
                <span className="voice-row-name">{t("voices.followProject")}</span>
                <span className="voice-row-meta">{t("voices.followProjectHint")}</span>
                {value === null && <Check size={14} strokeWidth={2} aria-hidden="true" />}
              </button>
            )}

            {groups.map(([code, group]) => (
              <div key={code ?? "unknown"} className="voice-group">
                <p className="eyebrow">{languageLabel(code)}</p>
                {group.map((voice) => (
                  <div
                    key={voice.id}
                    className={`voice-row-wrap${value === voice.id ? " active" : ""}`}
                  >
                    <Tip
                      label={
                        playing === voice.id
                          ? t("voices.stopAria", { name: voice.name })
                          : t("voices.playAria", { name: voice.name })
                      }
                      side="top"
                    >
                      <button
                        className="swatch-play"
                        onClick={() => audition(voice.id)}
                        aria-label={
                          playing === voice.id
                            ? t("voices.stopAria", { name: voice.name })
                            : t("voices.playAria", { name: voice.name })
                        }
                      >
                        {playing === voice.id ? (
                          <Square size={11} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <Play size={11} strokeWidth={2} aria-hidden="true" />
                        )}
                      </button>
                    </Tip>
                    <button className="voice-row" onClick={() => onPick(voice.id)}>
                      <span className="voice-row-name">
                        {voice.name}
                        {/* Only where the derived name is shared, so the id
                            earns its space instead of doubling every row. */}
                        {ambiguous.has(voice.id) && (
                          <span className="voice-row-id"> {voice.id}</span>
                        )}
                      </span>
                      <span className="voice-row-meta">{genderLabel(voice.gender)}</span>
                      {value === voice.id && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                    </button>
                    {failed === voice.id && (
                      <span className="voice-row-error" role="status">
                        {t("voices.previewFailed")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {shown.length === 0 && (
              <p className="quiet" role="status">
                {/* An available pack with no voices is a pack that could not
                    be read, not a search that missed — reporting a miss
                    against an empty query would describe the wrong thing. */}
                {voices.voices.length === 0
                  ? t("voices.noneInstalled")
                  : t("voices.noMatch", { query: query.trim() })}
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
