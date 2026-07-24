import { Clock, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { m, t } from "../i18n";
import { DURATION_BOUNDS, DURATIONS } from "../lib/formats";
import { Dropdown } from "./Dropdown";

/** Sentinel option value: never a real duration (bounds start at 5). */
const CUSTOM = -1;

/** Locale-neutral m:ss — unit words live in the catalog, not here. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** "210", "3:30", "3.5min" → whole seconds clamped to the engine bounds;
 * null when the text doesn't parse. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  const colon = /^(\d+):([0-5]?\d)$/.exec(trimmed);
  const minutes = /^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/.exec(trimmed);
  const seconds = /^(\d+)\s*s(?:ec(?:ond)?s?)?$|^(\d+)$/.exec(trimmed);
  let value: number;
  if (colon) value = Number(colon[1]) * 60 + Number(colon[2]);
  else if (minutes) value = Math.round(Number(minutes[1]) * 60);
  else if (seconds) value = Number(seconds[1] ?? seconds[2]);
  else return null;
  return Math.min(DURATION_BOUNDS.max, Math.max(DURATION_BOUNDS.min, value));
}

/** The duration dropdown Home's prompt row and Settings → Defaults share:
 * the preset chips plus a Custom… entry that swaps the chip for a small
 * text input (Enter commits, Esc cancels, invalid input changes nothing).
 * A non-preset value shows as its own selected option so it never
 * silently falls back to a preset label. */
export function DurationPicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  // Closing the editor unmounts the focused input, which would drop a
  // keyboard user at the top of the document. The ref lives on a wrapper
  // that outlives both branches; focus moves back to the chip in an effect,
  // once the commit that re-rendered it has actually landed.
  const rootRef = useRef<HTMLSpanElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    rootRef.current?.querySelector("button")?.focus();
  }, [editing]);
  const close = () => {
    restoreFocus.current = true;
    setEditing(false);
    setInvalid(false);
  };
  const isPreset = DURATIONS.some((entry) => entry.value === value);

  if (editing) {
    const commit = () => {
      const parsed = parseDuration(draft);
      // Unparseable input keeps the editor open and says so, rather than
      // silently reverting to the previous value.
      if (parsed === null) {
        setInvalid(true);
        return;
      }
      onChange(parsed);
      close();
    };
    return (
      <span className="duration-picker" ref={rootRef}>
        <span className="duration-edit">
          <input
            className={`duration-input${invalid ? " invalid" : ""}`}
            autoFocus
            value={draft}
            placeholder={t("durations.customPlaceholder")}
            aria-label={t("durations.customAria")}
            aria-describedby="duration-hint"
            aria-invalid={invalid}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onBlur={() => (parseDuration(draft) === null ? close() : commit())}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") close();
            }}
          />
          {/* The chip is prefilled, so the placeholder never shows — a
              persistent hint above the input carries the accepted formats.
              It is the input's accessible description, not decoration. */}
          <span className="tip duration-tip" id="duration-hint" role="note">
            {t(invalid ? "durations.customInvalid" : "durations.customHint")}
          </span>
        </span>
      </span>
    );
  }

  const options = [
    ...DURATIONS.map((entry) => ({
      value: entry.value as number,
      label: m().durations[entry.key],
      icon: entry.icon,
    })),
    ...(isPreset
      ? []
      : [{ value, label: `${formatDuration(value)} · ${t("durations.customTag")}`, icon: Clock }]),
    { value: CUSTOM, label: t("durations.custom"), icon: Timer },
  ];

  return (
    <span className="duration-picker" ref={rootRef}>
      <Dropdown
        value={value}
        options={options}
        ariaLabel={ariaLabel}
        onChange={(picked) => {
          if (picked === CUSTOM) {
            setDraft(formatDuration(value));
            setEditing(true);
          } else {
            onChange(picked);
          }
        }}
      />
    </span>
  );
}
