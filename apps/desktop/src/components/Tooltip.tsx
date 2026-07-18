import type { ReactNode } from "react";

/** CSS-only tooltip: label · optional qualifier · optional shortcut chip.
 * Shows on hover and keyboard focus of the wrapped control (doc 09: every
 * icon-only control explains itself, with its shortcut). The bubble is
 * aria-hidden — the control's own aria-label/title stays the a11y source. */
export function Tip({
  label,
  hint,
  shortcut,
  side = "top",
  children,
}: {
  label: string;
  hint?: string;
  shortcut?: string;
  side?: "top" | "bottom";
  children: ReactNode;
}) {
  return (
    <span className={`tip-wrap tip-${side}`}>
      {children}
      <span className="tip" role="presentation" aria-hidden="true">
        {label}
        {hint && <span className="tip-hint">· {hint}</span>}
        {shortcut && <kbd>{shortcut}</kbd>}
      </span>
    </span>
  );
}
