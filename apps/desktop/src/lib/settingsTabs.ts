/**
 * The Settings panes, in nav order — one list, two consumers.
 *
 * The screen builds its rail from this and the command palette builds a
 * "go to Settings → X" entry per tab from the same array. They were two
 * hand-kept copies, which is a shape that only fails in one direction:
 * add a pane and the palette silently cannot reach it, with nothing on
 * screen to say the command is missing rather than broken.
 *
 * Each id is also a catalog key under `settings.tabs.*`.
 */
export const SETTINGS_TABS = [
  "general",
  "defaults",
  "providers",
  "models",
  "storage",
  "engine",
  "workflows",
  "about",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
