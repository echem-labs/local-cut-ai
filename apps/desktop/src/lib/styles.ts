import { Clapperboard, Newspaper, Paintbrush, Shapes, Sparkles, Tv } from "lucide-react";

/**
 * The look the engine writes shot prompts for. `style_preset` on
 * `POST /projects` takes any string and defaults to "cinematic" — the
 * engine deliberately does not enumerate them, so this curated list is the
 * UI's own and needs no contract test. Ids travel to the engine; the labels
 * beside them are i18n (home.styles.*).
 *
 * Each carries a mark, as the aspect and duration options beside it do:
 * the design draws all three prompt chips with an icon, and the style chip
 * was the one shipping bare.
 */
export const STYLE_PRESETS = [
  { id: "cinematic", icon: Clapperboard },
  { id: "documentary", icon: Newspaper },
  { id: "animated", icon: Shapes },
  { id: "anime", icon: Sparkles },
  { id: "watercolor", icon: Paintbrush },
  { id: "retro", icon: Tv },
] as const;

export type StylePreset = (typeof STYLE_PRESETS)[number]["id"];
