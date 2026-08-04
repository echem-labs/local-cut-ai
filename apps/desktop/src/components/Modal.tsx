import { useEffect, useRef, type ReactNode } from "react";

/**
 * The modal shell: backdrop, focus trap, Escape, click-outside. Extracted
 * from ConfirmDialog when a second kind of dialog appeared (naming a
 * template, picking one) — the behaviours below are the ones that are easy
 * to get subtly wrong twice, and each comment is a bug that was fixed once.
 */
export function Modal({
  label,
  role = "dialog",
  className = "",
  onClose,
  children,
  initialFocus,
}: {
  label: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  onClose: () => void;
  children: ReactNode;
  /** Where focus lands on mount. Confirmations point it at the SAFE action;
   * a form points it at its first field. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // The callback lives in a ref so the effects below can depend on nothing:
  // callers pass inline arrows, a new identity every render, and with the
  // handler in the dependency list the focus effect re-ran on every parent
  // render — while anything re-rendered the parent continuously (a download,
  // a render) focus was yanked back on each pass.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const target =
      initialFocus?.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
      );
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Stop the event dead. Other window-level Escape handlers (the
        // Settings overlay, the Inspector drawer) would otherwise ALSO see
        // it, so dismissing a dialog dismissed the thing behind it in the
        // same keystroke. stopImmediatePropagation covers listeners
        // registered on window alongside this one, which stopPropagation
        // does not.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        close.current();
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
    <div className="modal-backdrop" onMouseDown={() => close.current()} role="presentation">
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
