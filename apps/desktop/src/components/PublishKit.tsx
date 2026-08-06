import { useEffect, useState } from "react";
import { Copy, Check, Megaphone } from "lucide-react";

import type { PublishKit as PublishKitData } from "../api/types";
import { t } from "../i18n";
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
 * Both halves are ordinary graph nodes (`thumbnail`, `metadata`), so they
 * render through the queue, cache, and regenerate like everything else. This
 * component only asks for them and reads what comes back.
 */
export function PublishKit() {
  const board = useApp((state) => state.board);
  const client = useApp((state) => state.client);
  const currentProject = useApp((state) => state.currentProject);
  const preparePublish = useApp((state) => state.preparePublish);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metadata = board?.aux.metadata;
  const thumbnail = board?.aux.thumbnail;
  const kitUrl =
    metadata?.artifact_hash && client && currentProject && isDone(metadata.status)
      ? client.artifactUrl(currentProject.id, metadata.artifact_hash)
      : null;
  const kit = usePublishKit(kitUrl);

  // Nothing asked for yet: one button, and it is the whole surface.
  if (!metadata && !thumbnail) {
    return (
      <div className="publish-kit">
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setBusy(true);
            void preparePublish()
              .then(setError)
              .finally(() => setBusy(false));
          }}
        >
          <Megaphone size={14} strokeWidth={2} aria-hidden="true" />
          {busy ? t("publish.preparing") : t("publish.prepare")}
        </button>
        {error && <Alert message={error} onDismiss={() => setError(null)} />}
      </div>
    );
  }

  // Asked for, still rendering. Said plainly rather than shown as an empty
  // card: two model runs is not instant, and a blank panel reads as broken.
  const pending = !kit || !metadata || !isDone(metadata.status);

  return (
    <section className="publish-kit ready" aria-label={t("publish.title")}>
      <p className="eyebrow">{t("publish.title")}</p>
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
        {pending ? (
          <p className="publish-pending" role="status">
            {t("publish.pending")}
          </p>
        ) : (
          <dl className="publish-fields">
            <Field label={t("publish.fieldTitle")} value={kit.title} />
            <Field label={t("publish.fieldDescription")} value={kit.description} multiline />
            <Field
              label={t("publish.fieldHashtags")}
              // The engine strips the `#`, so it is added back here rather
              // than assumed — pasting bare words into a caption box is not
              // what anyone means by "hashtags".
              value={kit.hashtags.map((tag) => `#${tag}`).join(" ")}
            />
          </dl>
        )}
      </div>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
    </section>
  );
}

/** One copyable field. The copy button is a sibling of the value, never
 * wrapping it: a `<dd>` holding a button would make the text itself
 * unselectable by pointer, which is the other way people take text. */
function Field({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
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
    <div className={`publish-field${multiline ? " tall" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
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
    </div>
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
