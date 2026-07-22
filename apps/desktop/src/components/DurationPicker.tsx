import { Clock, Timer } from "lucide-react";
import { useState } from "react";
import { m, t } from "../i18n";
import { DURATION_BOUNDS, DURATIONS } from "../lib/formats";
import { Dropdown } from "./Dropdown";

/** Sentinel option value: never a real duration (bounds start at 5). */
const CUSTOM = -1;

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}:${String(rest).padStart(2, "0")}` : `${minutes}min`;
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
  const isPreset = DURATIONS.some((entry) => entry.value === value);

  if (editing) {
    const commit = () => {
      const parsed = parseDuration(draft);
      if (parsed !== null) onChange(parsed);
      setEditing(false);
    };
    return (
      <input
        className="duration-input"
        autoFocus
        value={draft}
        placeholder={t("durations.customPlaceholder")}
        aria-label={t("durations.customAria")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
      />
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
  );
}
