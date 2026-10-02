/**
 * What the readiness report means to the UI.
 *
 * The two predicates below are the whole product decision, and they are
 * deliberately different:
 *
 * - `noteworthyGaps` — what the workspace banner states. Includes
 *   `degraded`, because "no video model, so your scenes will be still
 *   images" is exactly the fact a user needs, and it is the one the still
 *   tier makes easiest to miss.
 * - `blockingGaps` — what an explicit render click is warned about. Excludes
 *   `degraded`: the still-clip tier is a supported mode on a low-VRAM
 *   machine (plan doc 04, tiers S/A), and a dialog in front of the normal
 *   way that machine works would teach people to click through warnings.
 *
 * One home for both because the store gates on one and the components
 * render the other; two copies would let the gate warn about something the
 * banner never mentions, or the reverse, with the whole suite green.
 */
import type { ReadinessRow } from "../api/types";

/** Verdicts an explicit render click is held for. */
const BLOCKING: ReadonlySet<string> = new Set(["placeholder", "will_fail"]);

/** Verdicts the standing banner states. A superset of BLOCKING. */
const NOTEWORTHY: ReadonlySet<string> = new Set(["placeholder", "will_fail", "degraded"]);

export function blockingGaps(rows: readonly ReadinessRow[] | null): ReadinessRow[] {
  return (rows ?? []).filter((row) => BLOCKING.has(row.verdict));
}

export function noteworthyGaps(rows: readonly ReadinessRow[] | null): ReadinessRow[] {
  return (rows ?? []).filter((row) => NOTEWORTHY.has(row.verdict));
}

/** One line per distinct problem. Keyframes and thumbnails both render
 * from `image.gen`, so an engine with no image model reports the same
 * sentence twice — true, and worth saying once.
 *
 * Where timeline and export share a problem, the export row is the one
 * kept, in the timeline's place: the stage both of them make is the final
 * video, and that is the name a person reading the list knows it by. */
export function distinctGaps(rows: readonly ReadinessRow[]): ReadinessRow[] {
  const kept = new Map<string, number>();
  const out: ReadinessRow[] = [];
  for (const row of rows) {
    // Keyed on the task, NOT the kind — timeline and export share one
    // missing ffmpeg and one sentence, exactly as keyframe and thumbnail
    // share one missing image model. Neither has a task, hence the "".
    const key = `${row.data.task ?? ""}:${row.reason}:${row.model ?? ""}`;
    const at = kept.get(key);
    if (at === undefined) {
      kept.set(key, out.length);
      out.push(row);
    } else if (row.kind === "export" && out[at].kind === "timeline") {
      out[at] = row;
    }
  }
  return out;
}

/** A dismissal covers exactly this set of problems: fix one model but lose
 * another and the fingerprint changes, so the dialog comes back. The model
 * is in the key because swapping a node to a DIFFERENT missing model is a
 * different problem with the same reason code. */
export function readinessFingerprint(rows: readonly ReadinessRow[]): string {
  return [...new Set(rows.map((row) => `${row.kind}:${row.reason}:${row.model ?? ""}`))]
    .sort()
    .join(";");
}
