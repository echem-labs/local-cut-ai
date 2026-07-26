import { useEffect, useRef } from "react";
import { t } from "../i18n";

/** Modal confirmation — reserved for genuinely destructive acts (doc 09).
 * Escape cancels, the safe action holds initial focus, clicking the
 * backdrop cancels, and Tab cycles within the dialog. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Callbacks live in a ref so the effects below can depend on nothing.
  // Callers pass inline arrows (`onCancel={() => setPending(null)}`), which
  // are a new function identity on every render — with onCancel in the
  // dependency list, the focus effect re-ran on every parent render, and
  // while anything re-rendered the parent continuously (a download, a
  // render) focus was yanked back to Cancel on each pass. The confirm button
  // could then never be reached by keyboard at all.
  const handlers = useRef({ onConfirm, onCancel });
  handlers.current = { onConfirm, onCancel };

  // Initial focus: the SAFE action, exactly once per mount.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Stop the event dead. Other window-level Escape handlers (the
        // Settings overlay, the Inspector drawer) would otherwise ALSO see
        // it, so dismissing a confirmation dismissed the thing behind it in
        // the same keystroke. stopImmediatePropagation covers listeners
        // registered on window alongside this one, which stopPropagation
        // does not.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        handlers.current.onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      // Focus trap: a modal that lets Tab walk out into the page behind it
      // is a modal only visually.
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
    // Capture phase: this dialog is the topmost layer, so it gets first
    // refusal on the keystroke before anything below it can act on it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={() => handlers.current.onCancel()} role="presentation">
      <div
        className="modal"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="modal-actions">
          <button className="btn-ghost" ref={cancelRef} onClick={() => handlers.current.onCancel()}>
            {t("common.keepIt")}
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={() => handlers.current.onConfirm()}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
