import { useEffect, useState } from "react";
import { t } from "../i18n";

/**
 * The pieces every "something is running, and it is still running" surface
 * needs: the mark, the clock, and the rule about announcing it.
 *
 * Two screens grew these independently within a day of each other — the
 * publish kit's busy line and the project's script wait — and landed on the
 * same answer by different routes and with different bugs. What they share is
 * not a layout (one is an inline line inside a dialog, the other is the whole
 * screen) but the mark, the counter, and the reasoning under both. That is
 * what lives here; each surface still arranges its own.
 */

/** How long a wait has to last before it is worth putting a number on. Below
 * this, work that arrives quickly would flash a timer and take it away. */
export const ELAPSED_AFTER_S = 4;

/**
 * The app's "something is running" mark: a quarter arc turning on a track, in
 * the queue tray's ring geometry — same radius, same stroke, same two
 * colours, because both marks mean the same thing.
 *
 * Deliberately not an icon-set loader glyph. Those are rings with a small gap
 * in them, and turning one at this size moves only the gap: measured in the
 * running app the rotation was exact and centred, and the mark still read as
 * a circle sitting still. A quarter arc has a lot of travelling edge.
 *
 * `pathLength` normalises the circumference to 100 so the dash pattern is a
 * plain quarter, with no second copy of 2πr to keep in step with the tray's.
 */
export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="wait-ring spin"
      viewBox="0 0 18 18"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <circle className="track" cx="9" cy="9" r="7" />
      <circle className="arc" cx="9" cy="9" r="7" pathLength={100} strokeDasharray="25 75" />
    </svg>
  );
}

/**
 * Seconds since the wait began; 0 whenever it is not running.
 *
 * Timed from a stopwatch taken here, never from a job's `started_at`: that is
 * the ENGINE's clock and this is the desktop's, and on a remote engine the
 * two need not agree. The counter only has to answer "has this stopped",
 * which a local stopwatch answers honestly.
 */
export function useElapsed(running = true): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    // Against a start time rather than by incrementing: a counter that adds 1
    // per tick silently under-reports whenever the timer is throttled, which
    // is exactly what a backgrounded window does to it.
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [running]);
  return elapsed;
}

/**
 * The counter, once the wait has earned one.
 *
 * `aria-hidden` on purpose. These lines live inside a `role="status"`, which
 * is an atomic live region — it re-reads its WHOLE contents on any change, so
 * an exposed counter makes a screen reader repeat the same sentence once a
 * second. The status text carries the meaning; the number is for the eye.
 */
export function Elapsed({ seconds }: { seconds: number }) {
  if (seconds < ELAPSED_AFTER_S) return null;
  return (
    <span className="wait-elapsed" aria-hidden="true">
      {t("common.elapsedSeconds", { seconds })}
    </span>
  );
}
