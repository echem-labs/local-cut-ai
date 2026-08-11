import { useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCw } from "lucide-react";

import type { PublishKit as PublishKitData } from "../api/types";
import { t } from "../i18n";
import { loadDraft, mergeDraft, saveDraft } from "../lib/publishDraft";
import { isDone } from "../lib/status";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { FailureCard } from "./FailureCard";
import { MediaThumb } from "./MediaThumb";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

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

  // The hashtag field's text WHILE it is being typed. The stored value is a
  // list, and rebuilding the text from it on every keystroke deletes the
  // separator just pressed — so "#a b" became "#ab". Null means "nothing
  // typed yet, show the list"; a regenerate clears it so a rewritten set of
  // tags is not shadowed by the text of the old one.
  const [tagText, setTagText] = useState<string | null>(null);

  const kit = engineKit ? mergeDraft(engineKit, draft) : null;
  const asked = !!metadata || !!thumbnail;

  // The two halves fail independently — a thumbnail that ran out of VRAM
  // says nothing about the title — so each reports for itself. Without
  // this the dialog kept saying it was writing text no job was writing:
  // the metadata node had died on a model that is not installed, and the
  // engine's reason sat in `error` with nothing on screen reading it.
  const metaFailed = metadata?.status === "failed";
  const thumbFailed = thumbnail?.status === "failed";

  const build = () => {
    setError(null);
    setBusy(true);
    setTagText(null);
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
          <button className="btn-primary" onClick={() => closeRef.current()}>
            {t("common.close")}
          </button>
        </>
      }
    >
      {!asked ? (
        // The request is in flight (or was refused). Not a second button
        // repeating the one that opened this — only a way back in when the
        // engine said no.
        <>
          <p className="hint" role="status">
            {busy ? t("publish.preparing") : t("publish.pending")}
          </p>
          {error && <Alert message={error} onDismiss={() => setError(null)} />}
        </>
      ) : (
        <>
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
            <p className="hint" role="status">
              {t("publish.pending")}
            </p>
          )}
          {error && <Alert message={error} onDismiss={() => setError(null)} />}
        </>
      )}
    </Modal>
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
