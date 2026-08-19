import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { t } from "../i18n";
import { Tip } from "./Tooltip";

/** Three widths, named. Every dialog in the app is one of these: a
 * confirmation's column, a form's, or a list's. Four ad-hoc `max-width`
 * overrides (400/460/520/560) is how a set of dialogs stops looking like
 * one set. */
export type ModalSize = "s" | "m" | "l";

/**
 * The dialog. One shell, one anatomy, one set of behaviours.
 *
 * ANATOMY — `head` and `foot` are pinned and only `body` scrolls. That is
 * the part worth stating: before this, one dialog scrolled its whole self
 * (so the title left the screen and you could not find the close) and
 * another scrolled just its list, each having invented its own answer. A
 * dialog is a small window; the thing that identifies it and the thing that
 * dismisses it are the two that must never scroll away.
 *
 * BEHAVIOUR — backdrop, focus trap, Escape, click-outside. These are the
 * ones that are easy to get subtly wrong twice, and each comment below is a
 * bug that was fixed once. Five dialogs used to hand-roll the backdrop
 * around them; two of those trapped no focus at all, so Tab walked out into
 * the page behind a thing calling itself `aria-modal`.
 *
 * PLACE — portaled to `<body>`, like `Tip`'s bubble and for the same kind of
 * reason: a dialog must not inherit the context of whatever opened it. The
 * rail's Help menu renders its dialog beside the ? button, which put the
 * dialog inside `.rail` — where `.rail .tip-wrap { width: 100% }` found the
 * close button's tooltip wrapper and stretched ✕ across the header, leaving
 * the title 0px wide and stacked one letter per line. `position: fixed`
 * takes a dialog out of the visual flow but not out of the selector tree
 * (nor out of an ancestor's stacking context or `overflow`), so the portal
 * is the only thing that actually makes placement irrelevant.
 */
export function Modal({
  title,
  subtitle,
  label,
  role = "dialog",
  size = "s",
  className = "",
  onClose,
  footer,
  children,
  initialFocus,
  bodyRef,
}: {
  /** Rendered as the dialog's heading, and its accessible name unless
   * `label` overrides. A dialog with no title is one you cannot describe. */
  title: string;
  /** One quiet line under the title — what this dialog is about, when the
   * title cannot carry it (a repository, a project, a file path). */
  subtitle?: ReactNode;
  /** Only when the accessible name must differ from the visible title. */
  label?: string;
  role?: "dialog" | "alertdialog";
  size?: ModalSize;
  className?: string;
  onClose: () => void;
  /** The action row. Pinned under the body behind a rule; omit for a
   * dialog whose only exit is the close button. */
  footer?: ReactNode;
  children: ReactNode;
  /** Where focus lands on mount. Confirmations point it at the SAFE action;
   * a form points it at its first field. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** For a caller that has to scroll the body itself (the licenses list
   * jumps to a package). The body is the scroll container. */
  bodyRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // The callback lives in a ref so the effects below can depend on nothing:
  // callers pass inline arrows, a new identity every render, and with the
  // handler in the dependency list the focus effect re-ran on every parent
  // render — while anything re-rendered the parent continuously (a download,
  // a render) focus was yanked back on each pass.
  const close = useRef(onClose);
  close.current = onClose;

  // Hand focus back where it came from on close, so a keyboard user is not
  // dumped at the top of the document — they resume at the control that
  // opened the dialog. Lifted from the help overlay, which was the only
  // dialog that did it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const target =
      initialFocus?.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        // The close button is deliberately not first in this list's reach:
        // it is the LAST control in the DOM, so a form's first field still
        // wins. Landing on ✕ would make Enter dismiss the dialog.
        '.modal-body input, .modal-body select, .modal-body textarea, .modal-body button, .modal-body [href], .modal-body [tabindex]:not([tabindex="-1"]), .modal-foot button',
      ) ??
      dialogRef.current?.querySelector<HTMLElement>(".modal-close");
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
        // `summary` is in the list because it is natively focusable without
        // carrying a tabindex, so it is invisible to every other clause here.
        // The licenses dialog's disclosures are the app's first ones, and they
        // only wrap correctly today because a button happens to sit on either
        // side of them — move the close control and Tab walks out.
        'button, summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => close.current()} role="presentation">
      <div
        className={`modal modal-${size}${className ? ` ${className}` : ""}`}
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-label={label ?? title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-titles">
            <h2>{title}</h2>
            {subtitle !== undefined && <p className="modal-sub">{subtitle}</p>}
          </div>
          {/* In the header, so source order matches what the eye sees: it
              is the first control in the dialog and the first Tab reaches
              it. What it is NOT is where focus LANDS — that goes to the
              body's first field below, or the first Enter would dismiss
              the dialog instead of submitting it. */}
          <Tip label={t("common.close")} shortcut={t("common.escapeKey")}>
            <button
              className="modal-close"
              aria-label={t("common.close")}
              onClick={() => close.current()}
            >
              <X size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </Tip>
        </div>
        <div className="modal-body" ref={bodyRef}>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
