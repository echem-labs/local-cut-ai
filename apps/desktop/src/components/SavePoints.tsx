import { Bookmark, Check, History, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SavePointInfo } from "../api/types";
import { t } from "../i18n";
import { absoluteTime, relativeTime } from "../lib/time";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { Tip } from "./Tooltip";

/** Save points — named versions of the project's graph (doc 10).
 *
 * Restore lands through the same undo history as any edit, so there is no
 * confirm step: walking back out of a restore is one Ctrl+Z. Delete is the
 * other thing entirely — it leaves the history alone and takes the save
 * point with it — so it asks first. The two sat side by side, identically
 * styled, with neither asking anything.
 *
 * A restore that works changes nothing IN HERE, though — the graph it
 * rewinds is behind the dialog — so it said nothing at all, and the only
 * reading available was that the button was broken. It now acknowledges
 * itself, and the acknowledgement carries the way back out, because "one
 * Ctrl+Z" is the reason there was no confirm and the user was never told.
 *
 * No footer: the dialog's one productive verb is Save, which lives beside
 * the field it completes, and a footer holding nothing but "Close"
 * duplicates the ✕ the shell already draws.
 */
export function SavePoints({ onClose }: { onClose: () => void }) {
  const { history, createSavepoint, restoreSavepoint, deleteSavepoint } = useApp();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<SavePointInfo | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Longer than the 1.4s tick the copy buttons use: this one is a sentence
  // that teaches the undo, and a transient nobody can finish reading is a
  // flicker rather than a message.
  useEffect(() => {
    if (restored === null) return;
    const timer = setTimeout(() => setRestored(null), 6000);
    return () => clearTimeout(timer);
  }, [restored]);

  const run = (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    void action()
      .then((message) => setError(message))
      .finally(() => setBusy(false));
  };

  const savepoints = history?.savepoints ?? [];

  return (
    <Modal
      title={t("project.savepoints.title")}
      subtitle={t("project.savepoints.hint")}
      size="m"
      onClose={onClose}
      initialFocus={inputRef}
    >
      <form
        className="savepoint-new"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = label.trim();
          if (!trimmed || busy) return;
          run(async () => {
            const message = await createSavepoint(trimmed);
            if (!message) setLabel("");
            return message;
          });
        }}
      >
        <input
          ref={inputRef}
          value={label}
          maxLength={80}
          placeholder={t("project.savepoints.placeholder")}
          aria-label={t("project.savepoints.nameAria")}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={busy || !label.trim()}>
          {t("project.savepoints.save")}
        </button>
      </form>

      <div className="well savepoint-well">
        {savepoints.length === 0 ? (
          /* The same well with the needle at zero, never a different
             illustration — and it says what the first entry buys rather
             than only that there are none. */
          <div className="well-empty">
            <History size={20} strokeWidth={1.8} aria-hidden="true" />
            <b>{t("project.savepoints.empty")}</b>
            <span>{t("project.savepoints.emptyWhy")}</span>
          </div>
        ) : (
          <ul className="plist" aria-label={t("project.savepoints.listAria")}>
            {savepoints.map((savepoint) => (
              <li className="prow vrow" key={savepoint.id}>
                <Bookmark size={14} strokeWidth={1.8} aria-hidden="true" />
                <span className="vnames">
                  <span className="pname">{savepoint.label}</span>
                  {/* The absolute time is the identifying one; the
                      relative is the orienting one, so it rides in the
                      bubble rather than taking a second line. */}
                  <Tip label={absoluteTime(savepoint.at)} hint={relativeTime(savepoint.at)}>
                    <span className="readout">{absoluteTime(savepoint.at)}</span>
                  </Tip>
                </span>
                <button
                  className="btn-ghost sp-restore"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const message = await restoreSavepoint(savepoint.id);
                      if (!message) setRestored(savepoint.label);
                      return message;
                    })
                  }
                >
                  {t("project.savepoints.restore")}
                </button>
                <Tip
                  label={t("project.savepoints.delete")}
                  hint={t("project.savepoints.deleteTipHint")}
                >
                  <button
                    className="icon-btn-sm sp-delete"
                    disabled={busy}
                    aria-label={t("project.savepoints.deleteAria", { name: savepoint.label })}
                    onClick={() => setDoomed(savepoint)}
                  >
                    <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </Tip>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The instrument line the rest of the family uses for a reading,
          carrying the one fact this dialog never said out loud. Polite,
          not assertive: nothing was lost, and the undo it names is
          available for as long as the history is. */}
      {restored && (
        <p className="sp-restored" role="status">
          <Check size={13} strokeWidth={2.2} aria-hidden="true" />
          <span>{t("project.savepoints.restored", { name: restored })}</span>
        </p>
      )}

      {/* `<Alert>`, not a bare div: this was an unstyled `role="status"`
          node, which is both invisible and — being a polite live region —
          silent about the one thing in here that can lose work. */}
      {error && <Alert message={error} onDismiss={() => setError(null)} />}

      {doomed && (
        <ConfirmDialog
          title={t("project.savepoints.deleteTitle")}
          message={t("project.savepoints.deleteMessage")}
          confirmLabel={t("project.savepoints.delete")}
          danger
          victim={{ name: doomed.label, detail: absoluteTime(doomed.at) }}
          onCancel={() => setDoomed(null)}
          onConfirm={() => {
            const target = doomed;
            setDoomed(null);
            run(() => deleteSavepoint(target.id));
          }}
        />
      )}
    </Modal>
  );
}
