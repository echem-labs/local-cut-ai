import type { Board, NodeState } from "../api/types";

/** Session-observed render timing (review 3: the "honest ETA"). Estimates
 * come only from renders actually watched this session — no invented
 * numbers. No observations yet → no estimate shown. */

const DONE = new Set(["draft", "final", "pinned"]);
// Finals render at full quality — slower than the draft renders we observed.
const FINAL_QUALITY_FACTOR = 1.5;
// Timeline assembly + MP4 export tail, added once.
const ASSEMBLY_TAIL_S = 30;

// `${projectId}:${nodeId}` → when we first saw it rendering. Keyed by
// project because node ids (s1.clip) repeat across projects.
const startedAt = new Map<string, number>();
// Completed clip render durations (seconds), newest last.
const clipSeconds: number[] = [];

const isClip = (nodeId: string) => /\.clip\d*$/.test(nodeId);

/** Feed every board snapshot through here (Project does, on board change). */
export function recordBoard(projectId: string, board: Board): void {
  const nodes: NodeState[] = [];
  for (const scene of board.scenes) {
    for (const node of [scene.keyframe, scene.clip, scene.narration]) {
      if (node) nodes.push(node);
    }
  }
  for (const node of Object.values(board.aux)) if (node) nodes.push(node);

  const present = new Set<string>();
  for (const node of nodes) {
    const key = `${projectId}:${node.node_id}`;
    present.add(key);
    if (node.status === "rendering") {
      if (!startedAt.has(key)) startedAt.set(key, Date.now());
    } else if (startedAt.has(key)) {
      const secs = (Date.now() - startedAt.get(key)!) / 1000;
      startedAt.delete(key);
      // Only completed clip renders feed the finalize estimate — they are
      // the dominant cost. (Failures teach nothing about duration.)
      if (DONE.has(node.status) && isClip(node.node_id) && secs > 0.5) {
        clipSeconds.push(secs);
        if (clipSeconds.length > 20) clipSeconds.shift();
      }
    }
  }
  // An edit can remove nodes mid-render — drop their stale starts.
  for (const key of [...startedAt.keys()]) {
    if (key.startsWith(`${projectId}:`) && !present.has(key)) startedAt.delete(key);
  }
}

const formatEta = (secs: number): string =>
  secs >= 90 ? `~${Math.ceil(secs / 60)} min` : `~${Math.max(10, Math.round(secs / 10) * 10)}s`;

/** "~9 min" for the Create-final-video CTA, or null before any clip render
 * has been observed this session. */
export function finalizeEta(board: Board): string | null {
  if (clipSeconds.length === 0) return null;
  const avg = clipSeconds.reduce((sum, s) => sum + s, 0) / clipSeconds.length;
  const toRender = board.scenes.filter(
    (scene) => scene.clip.status !== "final" && !scene.clip.pinned,
  ).length;
  return formatEta(toRender * avg * FINAL_QUALITY_FACTOR + ASSEMBLY_TAIL_S);
}

/** "about 40s left" for a node mid-render, projected from its own progress
 * so far — needs a few seconds of movement before it dares to speak. */
export function remainingLabel(
  projectId: string,
  nodeId: string,
  progress: number,
): string | null {
  const t0 = startedAt.get(`${projectId}:${nodeId}`);
  if (t0 === undefined || progress <= 0.05 || progress >= 1) return null;
  const elapsed = (Date.now() - t0) / 1000;
  if (elapsed < 3) return null;
  const left = (elapsed * (1 - progress)) / progress;
  return left >= 90
    ? `about ${Math.round(left / 60)} min left`
    : `about ${Math.max(5, Math.round(left / 5) * 5)}s left`;
}
