import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";

export interface DropdownOption<V extends string | number> {
  value: V;
  label: string;
  icon?: ComponentType<{ size?: number | string; strokeWidth?: number | string }>;
}

/** Chip-styled dropdown that can render icons in its menu items — the one
 * thing a native <select> can't do. Chip look per the design proposal (no
 * chevron); full keyboard support (arrows / Enter / Escape). */
export function Dropdown<V extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: V;
  options: DropdownOption<V>[];
  onChange: (value: V) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
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

  const pick = (option: DropdownOption<V>) => {
    onChange(option.value);
    setOpen(false);
  };

  const SelectedIcon = selected?.icon;

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className="dropdown-trigger"
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
            pick(options[activeIndex]);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {SelectedIcon && <SelectedIcon size={13} strokeWidth={1.8} aria-hidden="true" />}
        {selected?.label}
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => {
            const Icon = option.icon;
            const isSelected = option.value === value;
            return (
              <button
                type="button"
                key={String(option.value)}
                role="option"
                aria-selected={isSelected}
                className={`${isSelected ? "selected" : ""}${index === activeIndex ? " focused" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(option)}
              >
                {Icon && <Icon size={13} strokeWidth={1.8} aria-hidden="true" />}
                <span className="grow">{option.label}</span>
                {isSelected && <Check size={12} strokeWidth={2.2} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
