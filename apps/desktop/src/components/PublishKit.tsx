import { useEffect, useRef, useState } from "react";
import { Check, Copy, Megaphone, RotateCw } from "lucide-react";

import type { PublishKit as PublishKitData } from "../api/types";
import { t } from "../i18n";
import { loadDraft, mergeDraft, saveDraft } from "../lib/publishDraft";
import { isDone } from "../lib/status";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { MediaThumb } from "./MediaThumb";

/**
 * The last mile: what you paste into the upload form.
 *
 * `POST /package` has existed since the engine grew a publish kit, and
 * nothing called it. A finished video left the app as a file, and the title,
 * description and hashtags — which the engine writes from the screenplay it
 * already has — were never produced at all.
 *
 * A dialog, not a band above the board. It shipped as a full-width panel
 * between the header and the storyboard, which put the LAST step of the work
 * above all the earlier ones and gave a text-copying task the visual weight
 * of the project itself. It opens from a button beside "Create final video",
 * where the end of the job belongs.
 *
 * Both halves are ordinary graph nodes (`thumbnail`, `metadata`), so they
 * render through the queue, cache and regenerate like everything else.
 */
export function PublishKit({ onClose }: { onClose: () => void }) {
  const board = useApp((state) => state.board);
  const client = useApp((state) => state.client);
  const currentProject = useApp((state) => state.currentProject);
  const preparePublish = useApp((state) => state.preparePublish);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const projectId = currentProject?.id ?? null;
  const metadata = board?.aux.metadata;
  const thumbnail = board?.aux.thumbnail;
  const ready = !!metadata && isDone(metadata.status);
  const kitUrl =
    metadata?.artifact_hash && client && currentProject && ready
      ? client.artifactUrl(currentProject.id, metadata.artifact_hash)
      : null;
  const engineKit = usePublishKit(kitUrl);

  // Hand edits, over whatever the engine last wrote. Kept separate rather
  // than merged into one editable blob: a regenerate has to be able to
  // replace the parts nobody touched.
  const [draft, setDraft] = useState<Partial<PublishKitData>>({});
  useEffect(() => setDraft(projectId ? loadDraft(projectId) : {}), [projectId]);
  const edit = (patch: Partial<PublishKitData>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (projectId) saveDraft(projectId, next);
  };

  // The hashtag field's text WHILE it is being typed. The stored value is a
  // list, and rebuilding the text from it on every keystroke deletes the
  // separator just pressed — so "#a b" became "#ab". Null means "nothing
  // typed yet, show the list"; a regenerate clears it so a rewritten set of
  // tags is not shadowed by the text of the old one.
  const [tagText, setTagText] = useState<string | null>(null);

  // Escape closes, and consumes the keystroke: the Inspector's own Escape
  // would otherwise deselect the node behind this dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const kit = engineKit ? mergeDraft(engineKit, draft) : null;
  const asked = !!metadata || !!thumbnail;

  const build = () => {
    setError(null);
    setBusy(true);
    setTagText(null);
    void preparePublish()
      .then(setError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => closeRef.current()} role="presentation">
      <div
        className="modal publish-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("publish.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{t("publish.title")}</h2>
        <p>{t("publish.hint")}</p>

        {!asked ? (
          // Nothing asked for yet: one button, and it is the whole dialog.
          <div className="publish-empty">
            <button className="btn-primary" disabled={busy} onClick={build}>
              <Megaphone size={14} strokeWidth={2} aria-hidden="true" />
              {busy ? t("publish.preparing") : t("publish.prepare")}
            </button>
          </div>
        ) : (
          <>
            <div className="publish-body">
              <MediaThumb
                className="publish-thumb"
                src={
                  thumbnail?.artifact_hash && client && currentProject && isDone(thumbnail.status)
                    ? client.artifactUrl(currentProject.id, thumbnail.artifact_hash)
                    : null
                }
                alt={t("publish.thumbAlt")}
                fallback={<span className="publish-thumb empty" aria-hidden="true" />}
              />
              {kit ? (
                <div className="publish-fields">
                  <Field
                    label={t("publish.fieldTitle")}
                    value={kit.title}
                    onChange={(title) => edit({ title })}
                  />
                  <Field
                    label={t("publish.fieldDescription")}
                    value={kit.description}
                    onChange={(description) => edit({ description })}
                    multiline
                  />
                  <Field
                    label={t("publish.fieldHashtags")}
                    // The engine strips the `#`, so it is added back here
                    // rather than assumed — pasting bare words into a caption
                    // box is not what anyone means by "hashtags". Typing them
                    // back with or without it works either way.
                    //
                    // Displayed from `tagText` while it is being typed, not
                    // from the stored list: parsing on every keystroke drops
                    // the separator you just pressed, so the space between
                    // two tags vanished and the next word joined the last.
                    value={tagText ?? formatTags(kit.hashtags)}
                    onChange={(text) => {
                      setTagText(text);
                      edit({ hashtags: parseTags(text) });
                    }}
                  />
                </div>
              ) : (
                // Asked for, still rendering. Said plainly rather than shown
                // as empty fields: two model runs is not instant, and a blank
                // form reads as broken.
                <p className="publish-pending" role="status">
                  {t("publish.pending")}
                </p>
              )}
            </div>
            <div className="publish-actions">
              <button className="btn-ghost" disabled={busy} onClick={build}>
                <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                {busy ? t("publish.preparing") : t("publish.regenerate")}
              </button>
              <span className="publish-note">{t("publish.editNote")}</span>
              <div className="spacer" />
              <button className="btn-primary" onClick={() => closeRef.current()}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}
        {error && <Alert message={error} onDismiss={() => setError(null)} />}
      </div>
    </div>
  );
}

/** The list as one line of `#tag`s. Tolerant of a stored value that already
 * carries the hash — a hand-typed "#a" round-trips through the draft. */
const formatTags = (tags: string[]) => tags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ");

/** One line of tags back into the bare words the engine's own format uses.
 * Splits on whitespace AND commas, because both are how people write them. */
const parseTags = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#+/, "").trim())
    .filter(Boolean);

/** One editable, copyable field. The copy button is a sibling of the input,
 * never wrapping it — a control inside a control is unreachable to a screen
 * reader, and a `<textarea>` you cannot click into is not editable at all. */
function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  // The tick is a transient acknowledgement, not state — it has to expire on
  // its own or the button lies about the NEXT copy.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <label className={`publish-field${multiline ? " tall" : ""}`}>
      <span className="publish-label">{label}</span>
      {multiline ? (
        <textarea
          rows={4}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
      )}
      <button
        type="button"
        className="icon-btn-sm"
        aria-label={t("publish.copyField", { field: label })}
        title={t("publish.copyField", { field: label })}
        disabled={value.trim() === ""}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? (
          <Check size={13} strokeWidth={2.2} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    </label>
  );
}

/** The metadata artifact, fetched like the screenplay is. Its own hook so
 * the null-URL case (not packaged, or still rendering) is one branch. */
function usePublishKit(url: string | null): PublishKitData | null {
  const [kit, setKit] = useState<PublishKitData | null>(null);

  useEffect(() => {
    setKit(null);
    if (!url) return;
    let stale = false;
    fetch(url)
      .then((response) => response.json())
      .then((data) => {
        if (!stale) setKit(data as PublishKitData);
      })
      .catch((err) => console.warn("publish kit fetch failed:", err));
    return () => {
      stale = true;
    };
  }, [url]);

  return kit;
}
