import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, RotateCw, X } from "lucide-react";

import type { PublishKit as PublishKitData } from "../api/types";
import { t } from "../i18n";
import { loadDraft, mergeDraft, saveDraft } from "../lib/publishDraft";
import { messageOf } from "../lib/errors";
import { isDone } from "../lib/status";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { FailureCard } from "./FailureCard";
import { MediaThumb } from "./MediaThumb";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";
import { Elapsed, Spinner, useElapsed } from "./Working";

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
  const { kit: engineKit, unreadable } = usePublishKit(kitUrl);

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

  // Transient acknowledgements for the two whole-kit copies. They expire on
  // their own, or the button lies about the next press.
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  useEffect(() => {
    if (!copiedAll) return;
    const timer = setTimeout(() => setCopiedAll(false), 1400);
    return () => clearTimeout(timer);
  }, [copiedAll]);
  useEffect(() => {
    if (!copiedImage) return;
    const timer = setTimeout(() => setCopiedImage(false), 1400);
    return () => clearTimeout(timer);
  }, [copiedImage]);

  const kit = engineKit ? mergeDraft(engineKit, draft) : null;
  const asked = !!metadata || !!thumbnail;

  // The two halves fail independently — a thumbnail that ran out of VRAM
  // says nothing about the title — so each reports for itself. Without
  // this the dialog kept saying it was writing text no job was writing:
  // the metadata node had died on a model that is not installed, and the
  // engine's reason sat in `error` with nothing on screen reading it.
  const metaFailed = metadata?.status === "failed";
  const thumbFailed = thumbnail?.status === "failed";

  const thumbUrl =
    thumbnail?.artifact_hash && client && currentProject && isDone(thumbnail.status)
      ? client.artifactUrl(currentProject.id, thumbnail.artifact_hash)
      : null;

  /** The thumbnail onto the clipboard as an IMAGE, so it can be pasted
   *  into the upload form beside the text. Returns a message rather than
   *  throwing: `ClipboardItem` is behind a permission and only speaks
   *  PNG, and a silent failure here looks identical to a successful one. */
  const copyImage = async (url: string): Promise<string | null> => {
    try {
      const blob = await fetch(url).then((response) => response.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopiedImage(true);
      return null;
    } catch (err) {
      return messageOf(err);
    }
  };

  const build = () => {
    setError(null);
    setBusy(true);
    void preparePublish()
      .then(setError)
      .finally(() => setBusy(false));
  };

  /**
   * Nothing asked for yet? Ask now.
   *
   * This opened onto a dialog whose only content was a button repeating the
   * one just pressed — two clicks and two headings to reach a task the user
   * had already named by opening it. The cost is a thumbnail render and one
   * LLM call, which is what "Publish kit" means; there is nothing here the
   * button was withholding a decision about.
   *
   * Once, on the mount that found nothing: `build` is also what "Write them
   * again" calls, and a dependency on `asked` would re-fire the moment that
   * request cleared the old nodes.
   */
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || asked || !currentProject) return;
    requested.current = true;
    build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, currentProject]);

  return (
    <Modal
      title={t("publish.title")}
      subtitle={t("publish.hint")}
      size="l"
      onClose={onClose}
      footer={
        <>
          {/* The regenerate is available in both states — before anything
              has been asked for it is a retry, after it is a rewrite. */}
          {(asked || error) && (
            <button className="btn-ghost" disabled={busy} onClick={build}>
              <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
              {asked
                ? busy
                  ? t("publish.preparing")
                  : t("publish.regenerate")
                : t("common.retry")}
            </button>
          )}
          <div className="spacer" />
          <button className="btn-ghost" onClick={() => closeRef.current()}>
            {t("common.close")}
          </button>
          {/* The gradient goes to the verb this dialog exists for. Close
              wore it, which put the app's one accent on the act of
              leaving without taking anything. */}
          <button
            className="btn-primary"
            disabled={!kit}
            onClick={() => {
              if (!kit) return;
              void navigator.clipboard
                .writeText(
                  `${kit.title}\n\n${kit.description}\n\n${formatTags(kit.hashtags)}`.trim(),
                )
                .then(() => setCopiedAll(true));
            }}
          >
            {copiedAll ? (
              <Check size={14} strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={2} aria-hidden="true" />
            )}
            {copiedAll ? t("publish.copiedAll") : t("publish.copyAll")}
          </button>
        </>
      }
    >
      {!asked ? (
        // The request is in flight (or was refused). Not a second button
        // repeating the one that opened this — only a way back in when the
        // engine said no.
        <>
          <Busy label={busy ? t("publish.preparing") : t("publish.pending")} />
          {error && <Alert message={error} onDismiss={() => setError(null)} />}
        </>
      ) : (
        <>
          {/* The hero, full width. It sat at 390px in a 620px dialog with
              nothing beside it — and the picture is the one part of the kit
              that cannot be copied as text, so it also carries its own way
              out. */}
          <div className="publish-hero">
            <MediaThumb
              className="publish-thumb"
              src={thumbUrl}
              alt={t("publish.thumbAlt")}
              fallback={<span className="publish-thumb empty" aria-hidden="true" />}
            />
            {thumbUrl && (
              <div className="hero-tray">
                <Tip label={t("publish.copyImage")}>
                  <button
                    type="button"
                    className="icon-btn-sm"
                    aria-label={t("publish.copyImage")}
                    onClick={() => void copyImage(thumbUrl).then(setError)}
                  >
                    {copiedImage ? (
                      <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                    ) : (
                      <Copy size={14} strokeWidth={2} aria-hidden="true" />
                    )}
                  </button>
                </Tip>
                <Tip label={t("publish.saveImage")}>
                  {/* A real link, so the browser's own download path runs
                      — an onClick that fabricates one is the same thing
                      with a keyboard hole in it. */}
                  <a
                    className="icon-btn-sm"
                    href={thumbUrl}
                    download={`${currentProject?.title ?? "thumbnail"}.png`}
                    aria-label={t("publish.saveImage")}
                  >
                    <Download size={14} strokeWidth={2} aria-hidden="true" />
                  </a>
                </Tip>
              </div>
            )}
          </div>
          {thumbFailed && thumbnail && (
            <>
              <p className="hint">{t("publish.thumbFailed")}</p>
              {/* The OOM ladder's chips apply here as they do on a scene:
                  a title-safe 16:9 render is the same kind of job. */}
              <FailureCard node={thumbnail} />
            </>
          )}
          {kit ? (
            <>
              {/* The caps are what every platform this gets pasted into
                  enforces silently; a model writing the text knows nothing
                  about them. Amber near the ceiling, red past it — the
                  reserved hues, used semantically. */}
              <Field
                label={t("publish.fieldTitle")}
                value={kit.title}
                limit={TITLE_LIMIT}
                onChange={(title) => edit({ title })}
              />
              <Field
                label={t("publish.fieldDescription")}
                value={kit.description}
                limit={DESCRIPTION_LIMIT}
                onChange={(description) => edit({ description })}
                multiline
              />
              <Hashtags
                tags={kit.hashtags}
                // The engine strips the `#`, so it is added back for
                // display and on copy — pasting bare words into a caption
                // box is not what anyone means by "hashtags".
                onChange={(hashtags) => edit({ hashtags })}
              />
              <p className="hint">{t("publish.editNote")}</p>
            </>
          ) : metaFailed && metadata ? (
            // The job died. "Write them again" in the footer is the way
            // back, once whatever the message names has been dealt with.
            <>
              <p className="hint">{t("publish.metaFailed")}</p>
              <FailureCard node={metadata} />
            </>
          ) : unreadable ? (
            // Rendered, but the artifact would not come back over HTTP.
            // Reported rather than warned to the console: the symptom is
            // identical to still-rendering, and it never resolves.
            <Alert message={t("publish.unreadable")} />
          ) : (
            // Asked for, still rendering. Said plainly rather than shown
            // as empty fields: two model runs is not instant, and a blank
            // form reads as broken.
            <Busy label={t("publish.pending")} />
          )}
          {error && <Alert message={error} onDismiss={() => setError(null)} />}
        </>
      )}
    </Modal>
  );
}

/**
 * The busy line: a spinner, what is being waited on, and how long it has
 * been.
 *
 * A static sentence was all this state had, and it is what a hung dialog
 * looks like — the same words for a job three seconds in and a job that has
 * been stuck for ten minutes.
 *
 * Elapsed seconds, not a percentage. Both halves are local model runs that
 * report no progress, so a bar here would be a drawing of a guess; "how long
 * has this been going" is the question a waiting user actually has, and it is
 * one the client can answer honestly.
 *
 * The mark, the clock and the threshold all come from `Working` — this line
 * and the project's script wait were built a day apart and had already
 * drifted into two spinners, two timers and two rules about announcing them.
 */
function Busy({ label }: { label: string }) {
  const elapsed = useElapsed();
  return (
    <p className="hint publish-status" role="status">
      <Spinner size={16} />
      <span>{label}</span>
      <Elapsed seconds={elapsed} />
    </p>
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

/** What the platforms this text is pasted into will silently cut it at.
 *  YouTube's two, which are the tightest of the set a short lands on. */
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 5000;

/** The hashtag well: one chip per tag, wrapping, none of them truncating.
 *
 * This was a single-line input, so five multi-word tags ended at "#se…" —
 * a field that cannot show its own contents. Chips wrap instead, each one
 * copies itself on click, and each carries the remove the design's own
 * sketch left out (dropping the ability to edit a tag was not a trade
 * worth making for the look of it). New tags arrive through the field at
 * the end, on Enter, comma or space. */
function Hashtags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [entry, setEntry] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const commit = (text: string) => {
    const added = parseTags(text);
    if (added.length === 0) return;
    // Deduped case-insensitively: the same tag twice is a paste artefact,
    // never an intention, and platforms count the repeat against the cap.
    const seen = new Set(tags.map((tag) => tag.toLowerCase()));
    onChange([...tags, ...added.filter((tag) => !seen.has(tag.toLowerCase()))]);
    setEntry("");
  };

  return (
    <div className="field publish-tags">
      <div className="tags-label">
        <span>{t("publish.fieldHashtags")}</span>
        <Tip label={t("publish.copyField", { field: t("publish.fieldHashtags") })}>
          <button
            type="button"
            className="icon-btn-sm"
            aria-label={t("publish.copyField", { field: t("publish.fieldHashtags") })}
            disabled={tags.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(formatTags(tags)).then(() => setCopied("*"));
            }}
          >
            {copied === "*" ? (
              <Check size={13} strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <Copy size={13} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        </Tip>
      </div>
      <div className="well tag-well">
        {tags.map((tag) => (
          <span className={`tag-chip${copied === tag ? " copied" : ""}`} key={tag}>
            <button
              type="button"
              className="tag-copy"
              aria-label={t("publish.copyTag", { tag })}
              onClick={() => {
                void navigator.clipboard.writeText(`#${tag}`).then(() => setCopied(tag));
              }}
            >
              <span className="hash" aria-hidden="true">
                #
              </span>
              {tag}
            </button>
            <button
              type="button"
              className="tag-remove"
              aria-label={t("publish.removeTag", { tag })}
              onClick={() => onChange(tags.filter((other) => other !== tag))}
            >
              <X size={11} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          className="tag-entry"
          value={entry}
          aria-label={t("publish.addTag")}
          placeholder={t("publish.addTag")}
          onChange={(event) => {
            // A separator ends the tag rather than joining the next word to
            // it, which is what the old parse-per-keystroke field did.
            if (/[\s,]/.test(event.target.value)) commit(event.target.value);
            else setEntry(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(entry);
            }
            // Backspace on an empty box takes the last chip — the standard
            // token-field reflex, and the only way to remove one without
            // the pointer.
            if (event.key === "Backspace" && entry === "" && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={() => commit(entry)}
        />
      </div>
    </div>
  );
}

/** One editable, copyable field. The copy button is a sibling of the input,
 * never wrapping it — a control inside a control is unreachable to a screen
 * reader, and a `<textarea>` you cannot click into is not editable at all. */
function Field({
  label,
  value,
  onChange,
  limit,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The platform ceiling this text is heading for, if it has one. */
  limit?: number;
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

  // `.field` is the app's own modal-field recipe — the uppercase micro-cap
  // label, the surface-2 control, the accent focus ring. The copy button
  // rides in a row beside the control rather than in the label's flow, so
  // both stay on the recipe instead of beside it.
  return (
    <label className="field publish-field">
      <span>{label}</span>
      {/* A DIV, not a span. `.modal .field span` is the label rule and it
          matches every span in the field, so a span here was laid out as a
          block — the copy button fell under the input — and the control
          inherited the label's 10px uppercase type. */}
      <div className="field-row">
        {multiline ? (
          <textarea
            rows={3}
            value={value}
            aria-label={label}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <input
            value={value}
            aria-label={label}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        <Tip label={t("publish.copyField", { field: label })}>
          <button
            type="button"
            className="icon-btn-sm"
            aria-label={t("publish.copyField", { field: label })}
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
        </Tip>
      </div>
      {limit !== undefined && (
        <div
          className={`char-count${value.length > limit ? " over" : value.length > limit * 0.9 ? " near" : ""}`}
        >
          <span className="readout">
            {value.length} / {limit}
          </span>
        </div>
      )}
    </label>
  );
}

/** The metadata artifact, fetched like the screenplay is. Its own hook so
 * the null-URL case (not packaged, or still rendering) is one branch.
 *
 * `unreadable` is the third state, and it used to be invisible: a fetch that
 * threw logged to the console and left `kit` null, which the dialog reads as
 * "still rendering" — a message that would never change. */
function usePublishKit(url: string | null): {
  kit: PublishKitData | null;
  unreadable: boolean;
} {
  const [kit, setKit] = useState<PublishKitData | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    setKit(null);
    setUnreadable(false);
    if (!url) return;
    let stale = false;
    fetch(url)
      .then((response) => response.json())
      .then((data) => {
        if (!stale) setKit(data as PublishKitData);
      })
      .catch((err) => {
        console.warn("publish kit fetch failed:", err);
        if (!stale) setUnreadable(true);
      });
    return () => {
      stale = true;
    };
  }, [url]);

  return { kit, unreadable };
}
