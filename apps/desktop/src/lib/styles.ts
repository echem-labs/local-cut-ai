/**
 * The look the engine writes shot prompts for. `style_preset` on
 * `POST /projects` takes any string and defaults to "cinematic" — the
 * engine deliberately does not enumerate them, so this curated list is the
 * UI's own and needs no contract test. Ids travel to the engine; the labels
 * beside them are i18n (home.styles.*).
 */
export const STYLE_PRESETS = [
  "cinematic",
  "documentary",
  "animated",
  "anime",
  "watercolor",
  "retro",
] as const;

export type StylePreset = (typeof STYLE_PRESETS)[number];
