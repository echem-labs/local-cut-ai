import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import { useMenuFit } from "../lib/useMenuFit";
import { Tip } from "./Tooltip";

export interface DropdownOption<V extends string | number> {
  value: V;
  label: string;
  icon?: ComponentType<{ size?: number | string; strokeWidth?: number | string }>;
  /** What this option means, in the menu. Optional: without one the bubble
   * still carries the label, which is the answer for the menus whose
   * options are names — a model id ellipsed to fit is unreadable in the row
   * and complete in the bubble. */
  hint?: string;
}

/** Chip-styled dropdown that can render icons in its menu items — the one
 * thing a native <select> can't do. Chip look per the design proposal (no
 * chevron); full keyboard support (arrows / Enter / Escape). */
export function Dropdown<V extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  tip,
  tipHint,
  tipSide = "top",
  variant = "chip",
}: {
  value: V;
  options: DropdownOption<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
  /** What this control decides, in the app's own bubble. A chip reading
   * "Cinematic" says what it is set to and nothing about what it is FOR,
   * and an aria-label answers that for a screen reader only — the pointer
   * got nothing at all. Optional: a dropdown whose surrounding copy already
   * names it does not need one. */
  tip?: string;
  tipHint?: string;
  /** "top" suits a control on a bottom-anchored row; a chip near the top of
   * the window wants "bottom", or the bubble is drawn off it. */
  tipSide?: "top" | "bottom" | "right";
  /**
   * How much the control has to say for itself.
   *
   * "chip" is the design proposal's look and the default: a chip sits in a
   * ROW of chips, and the row is what reads as pickable — the mocks draw no
   * chevron on any of them, and the home and session parity frames hold that.
   *
   * "field" is a settings row's control, which has none of that context. It
   * stands alone against a label with the width of the pane between them, so
   * a bare word like "Auto" reads as a value someone typed rather than one of
   * several you can choose. The caret is the affordance the row cannot give
   * it, and it gets a minimum width so a column of them lines up.
   */
  variant?: "chip" | "field";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const fit = useMenuFit();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  // The option list can shrink while the menu is open — a download finishing
  // or a model being deleted rewrites it underneath. The retained index then
  // points past the end, and Enter dereferenced undefined and raised a
  // TypeError out of the keydown handler. Clamp on every render instead of
  // trusting the index to still be valid.
  const safeIndex = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);

  const pick = (option: DropdownOption<V> | undefined) => {
    if (!option) return; // nothing under the cursor — an empty or shrunk list
    onChange(option.value);
    setOpen(false);
  };

  const SelectedIcon = selected?.icon;

  // The bubble wraps only the TRIGGER, never the menu: a tooltip anchored to
  // the whole control would keep pointing at it while the list is open, over
  // the options it is describing.
  const withTip = (trigger: ReactNode) =>
    tip ? (
      <Tip label={tip} hint={tipHint} side={tipSide}>
        {trigger}
      </Tip>
    ) : (
      trigger
    );

  return (
    <div className="dropdown" ref={rootRef}>
      {withTip(
      <button
        type="button"
        className={variant === "field" ? "dropdown-trigger field" : "dropdown-trigger"}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openMenu();
            else {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((index) => (index + delta + options.length) % options.length);
            }
          }
          if (event.key === "Enter" && open) {
            event.preventDefault();
            pick(options[safeIndex]);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {SelectedIcon && <SelectedIcon size={13} strokeWidth={1.8} aria-hidden="true" />}
        {selected?.label}
        {variant === "field" && (
          <ChevronDown className="dropdown-caret" size={13} strokeWidth={2} aria-hidden="true" />
        )}
      </button>,
      )}
      {open && (
        <div className="dropdown-menu" role="listbox" aria-label={ariaLabel} ref={fit}>
          {options.map((option, index) => {
            const Icon = option.icon;
            const isSelected = option.value === value;
            return (
              /* The trigger's bubble explains the CONTROL; this one explains
                 the option under the cursor, which is the question an open
                 menu actually raises. `side="right"` so it sits beside the
                 list rather than over the rows above and below the one it
                 describes. The trigger's own bubble is already gone by then:
                 it hides on mousedown, which is the click that opened this. */
              <Tip
                key={String(option.value)}
                label={option.label}
                hint={option.hint}
                side="right"
                presentational
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${isSelected ? "selected" : ""}${index === safeIndex ? " focused" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(option)}
                >
                  {Icon && <Icon size={13} strokeWidth={1.8} aria-hidden="true" />}
                  <span className="grow">{option.label}</span>
                  {isSelected && <Check size={12} strokeWidth={2.2} aria-hidden="true" />}
                </button>
              </Tip>
            );
          })}
        </div>
      )}
    </div>
  );
}
