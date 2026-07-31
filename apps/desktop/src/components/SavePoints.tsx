import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useApp } from "../store";

/** Save points — named versions of the project's graph (doc 10). Restore
 * lands through the same undo history as any edit, so there is no confirm
 * step: walking back out of a restore is one Ctrl+Z. */
export function SavePoints({ onClose }: { onClose: () => void }) {
  const { history, createSavepoint, restoreSavepoint, deleteSavepoint } = useApp();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Same discipline as ConfirmDialog: the topmost layer consumes the
        // keystroke, or Escape here would also deselect the Inspector node.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const run = (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    void action()
      .then((message) => setError(message))
      .finally(() => setBusy(false));
  };

  const savepoints = history?.savepoints ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={() => closeRef.current()} role="presentation">
      <div
        className="modal savepoints"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("project.savepoints.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{t("project.savepoints.title")}</h2>
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
        <div className="modal-actions">
          <button className="btn-ghost" onClick={() => closeRef.current()}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
