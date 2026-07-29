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

/** The engine's target_duration_s bounds (api/app.py) — custom entries
 * clamp to these so the UI can never submit a value the API rejects.
 *
 * These mirror engine constants and are asserted against them by
 * engine/tests/test_ui_contract.py, which parses this file. Change one side
 * and that test fails; there is no other check, because there is no desktop
 * test infrastructure. */
export const DURATION_BOUNDS = { min: 5, max: 1200 } as const;

/** Per-clip duration bounds — graph/editor.py `_CLIP_MIN_S`/`_CLIP_MAX_S`.
 * The Inspector clamps to these before sending: a number input does not stop
 * a typed or pasted value from leaving its min/max. */
export const CLIP_MIN_S = 1.0;
export const CLIP_MAX_S = 15.0;

/** Narration speed bounds — graph/editor.py `_SPEED_MIN`/`_SPEED_MAX`. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;

/** The engine's narration timing model — backends/llm.py
 * `SPEECH_WORDS_PER_S` and backends/ffmpeg.py `NARRATION_PAD_S`. A scene
 * lasts as long as its narration takes to speak (plus breathing room), NOT
 * the `duration_s` the script model wrote — nothing downstream reads that
 * claim, so neither may the UI. */
export const SPEECH_WORDS_PER_S = 3.5;
export const NARRATION_PAD_S = 0.35;

/** Seconds a scene's narration actually takes to speak, engine-rule. */
export const spokenSeconds = (narration: string): number => {
  const words = narration.split(/\s+/).filter(Boolean).length;
  return words / SPEECH_WORDS_PER_S + NARRATION_PAD_S;
};
