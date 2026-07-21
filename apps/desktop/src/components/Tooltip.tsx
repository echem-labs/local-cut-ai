import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Tooltip: label · optional qualifier · optional shortcut chip. Shows on
 * hover and keyboard focus of the wrapped control (doc 09: every icon-only
 * control explains itself, with its shortcut). The bubble portals to <body>
 * as position:fixed — inside dockview, sibling panel groups are their own
 * stacking contexts, so an in-place absolute bubble gets covered by whatever
 * panel sits beside it. The bubble is aria-hidden — the control's own
 * aria-label/title stays the a11y source. */
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
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({ x: rect.left + rect.width / 2, y: side === "top" ? rect.top : rect.bottom });
    }
  };
  const hide = () => setPos(null);

  return (
    <span
      className="tip-wrap"
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      // Activating the control dismisses the tip — it must not sit on top
      // of whatever popover the click just opened.
      onMouseDown={hide}
      onFocus={(event) => {
        // :focus-visible (not plain focus) — a mouse click must not leave
        // the tooltip stuck open on the focused control.
        if (event.target.matches(":focus-visible")) show();
      }}
      onBlur={hide}
    >
      {children}
      {pos &&
        createPortal(
          <span
            className={`tip tip-${side}`}
            role="presentation"
            aria-hidden="true"
            style={{ left: pos.x, top: pos.y }}
          >
            {label}
            {hint && <span className="tip-hint">· {hint}</span>}
            {shortcut && <kbd>{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
