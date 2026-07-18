import { Clock, Monitor, Smartphone, Square } from "lucide-react";

/** The format options Home's prompt row and Settings → Defaults share —
 * one source so the two surfaces can never drift (review 4 §S5). Values
 * are the wire strings; labels resolve from the catalog at render. */
export const ASPECTS = [
  { key: "shorts", value: "9:16", icon: Smartphone },
  { key: "youtube", value: "16:9", icon: Monitor },
  { key: "square", value: "1:1", icon: Square },
] as const;

export const DURATIONS = [
  { key: "d30", value: 30, icon: Clock },
  { key: "d60", value: 60, icon: Clock },
  { key: "d120", value: 120, icon: Clock },
] as const;
