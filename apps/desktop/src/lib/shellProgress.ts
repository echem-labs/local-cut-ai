/**
 * How far along a render is, for the taskbar and the window title.
 *
 * Both surfaces answer the question someone asks with the app minimised, so
 * the thing they report has to be the whole render rather than whichever
 * node happens to be in flight. The board supplies a fixed denominator —
 * every node the project needs — which a job list cannot: `/jobs` is the
 * history of every render this project has ever had, so counting it would
 * make the tenth render read as 9/10 done before it started.
 *
 * Gated on the QUEUE, not on node status. A board whose nodes read `queued`
 * with nothing behind them is the stalled case `isStalled` exists for, and a
 * taskbar bar frozen at 40% across a restart is worse than no bar at all.
 */
import type { Board, Job } from "../api/types";
import { boardNodes } from "./jobs";
import { isDone } from "./status";

export interface ShellProgress {
  /** 0..1 across the whole board. */
  fraction: number;
  done: number;
  total: number;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Null when nothing is running — which is also how the bar gets cleared. */
export function shellProgress(board: Board | null, jobs: Job[]): ShellProgress | null {
  const running = jobs.filter((job) => job.status === "queued" || job.status === "rendering");
  if (!board || running.length === 0) return null;

  const nodes = boardNodes(board);
  if (nodes.length === 0) return null;

  // `isDone`, not `isSettled`: status.ts draws the line at what may be
  // REPORTED as completion, and "Rendering 4/9" is a done count. A blocked
  // node waits on a person and has produced nothing, so it is not one of the
  // 4 — and it cannot strand the bar either, because the moment the queue
  // empties this returns null and the bar goes away entirely.
  const done = nodes.filter((node) => isDone(node.status)).length;

  // Node counts alone move in steps, which for a one-node tool render means
  // sitting at 0% for the whole thing and then vanishing. The in-flight
  // job's own progress fills that gap, and cannot double-count: a node with
  // a running job has not been counted as done.
  const partial = running
    .filter((job) => job.status === "rendering")
    .reduce((sum, job) => sum + clamp01(job.progress), 0);

  return {
    done,
    total: nodes.length,
    fraction: clamp01((done + partial) / nodes.length),
  };
}
