import type { Board, Job, NodeState } from "../api/types";

/**
 * The trailing job of a set, by stamp.
 *
 * Deliberately not `jobs[0]` or `jobs.at(-1)`: `/jobs` arrives newest-first,
 * but store merges reorder it, so indexing either end can grab the oldest job.
 * That is how a long-since-recovered project stayed pinned at "failed" on
 * Home — and the same read decides which render the tool session credits for
 * its model and duration, where an off-by-one silently attributes the
 * previous take.
 */
export function newestJob(jobs: Job[]): Job | null {
  return jobs.reduce<Job | null>(
    (best, job) => (best && best.created_at >= job.created_at ? best : job),
    null,
  );
}

/** Every node on a board, wherever it lives on it. */
export function boardNodes(board: Board): NodeState[] {
  const nodes: NodeState[] = [];
  for (const scene of board.scenes) {
    for (const node of [scene.keyframe, scene.clip, scene.narration]) if (node) nodes.push(node);
  }
  for (const node of Object.values(board.aux)) if (node) nodes.push(node);
  return nodes;
}

/**
 * The board promises work that the queue is not going to deliver.
 *
 * `queued`/`rendering` on a node is a statement that something is coming.
 * When nothing in the queue backs it, that statement is stale — the engine
 * was killed mid-render, or the desktop reconnected to one that had
 * restarted — and the project sits there looking busy forever, because
 * nothing polls it back to life. An empty `/patch` will not restart it
 * either: the engine re-plans only when an op dirtied something, so with no
 * edit to make there is no way back into flight at all.
 *
 * Deliberately NOT counting `failed` or `cancelled`: nothing is coming for
 * those either, but that is the truth rather than a stale promise, and
 * offering to resume on every failed node would make the offer meaningless
 * where it is real.
 */
export function isStalled(board: Board | null, jobs: Job[]): boolean {
  if (!board) return false;
  const awaited = boardNodes(board).some(
    (node) => node.status === "queued" || node.status === "rendering",
  );
  if (!awaited) return false;
  return !jobs.some((job) => job.status === "queued" || job.status === "rendering");
}
