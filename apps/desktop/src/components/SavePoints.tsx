import { useRef, useState } from "react";
import { t } from "../i18n";
import { useApp } from "../store";
import { Modal } from "./Modal";

/** Save points — named versions of the project's graph (doc 10). Restore
 * lands through the same undo history as any edit, so there is no confirm
 * step: walking back out of a restore is one Ctrl+Z. */
export function SavePoints({ onClose }: { onClose: () => void }) {
  const { history, createSavepoint, restoreSavepoint, deleteSavepoint } = useApp();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
      size="m"
      onClose={onClose}
      initialFocus={inputRef}
      footer={
        <button className="btn-ghost" onClick={() => closeRef.current()}>
          {t("common.close")}
        </button>
      }
    >
      <p>{t("project.savepoints.hint")}</p>
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
      {savepoints.length === 0 ? (
        <p className="savepoints-empty">{t("project.savepoints.empty")}</p>
      ) : (
        <ul className="savepoint-list" aria-label={t("project.savepoints.listAria")}>
          {savepoints.map((savepoint) => (
            <li key={savepoint.id}>
              <span className="savepoint-label">{savepoint.label}</span>
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() => run(() => restoreSavepoint(savepoint.id))}
              >
                {t("project.savepoints.restore")}
              </button>
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() => run(() => deleteSavepoint(savepoint.id))}
              >
                {t("project.savepoints.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div role="status">{error}</div>}
    </Modal>
  );
}
