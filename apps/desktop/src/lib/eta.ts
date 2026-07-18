import type { Board, NodeState } from "../api/types";

/** Session-observed render timing (review 3: the "honest ETA"). Estimates
 * come only from renders actually watched this session — no invented
 * numbers. No observations yet → no estimate shown. */

// Finals render at full quality — slower than the draft renders we sample.
const FINAL_QUALITY_FACTOR = 1.5;
// Timeline assembly + MP4 export tail, added once.
const ASSEMBLY_TAIL_S = 30;
// A render first observed beyond this progress was joined too late for its
// duration to be a trustworthy sample.
const FRESH_P0 = 0.25;

interface RenderStart {
  t0: number;
  /** Progress when first observed — a render can already be mid-flight
   * when the project opens, and elapsed-since-observation only covers the
   * (p − p0) slice of the work. */
  p0: number;
}

// `${projectId}:${nodeId}` → observation start. Keyed by project because
// node ids (s1.clip) repeat across projects.
const startedAt = new Map<string, RenderStart>();
// Completed DRAFT clip render durations (seconds), newest last. Finals are
// excluded: finalizeEta multiplies by FINAL_QUALITY_FACTOR, so a
// final-speed sample would be double-counted. Persisted per machine so the
// CTA estimate is there from the first board of a new session, not only
// after this session's first render.
const STATS_KEY = "localcut.renderStats.v1";
const clipSeconds: number[] = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => Number.isFinite(n) && n > 0).slice(-20)
      : [];
  } catch {
    return [];
  }
})();
const saveStats = () => {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(clipSeconds));
  } catch {
    /* storage full — the estimate degrades to session-only */
  }
};

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
      if (!startedAt.has(key)) {
        startedAt.set(key, { t0: Date.now(), p0: Math.min(node.progress ?? 0, 0.99) });
      }
    } else if (startedAt.has(key)) {
      const { t0, p0 } = startedAt.get(key)!;
      startedAt.delete(key);
      // Only draft clip completions observed from (near) the start feed the
      // finalize estimate — they are the dominant cost, and the p0 scaling
      // projects the observed slice onto the full render.
      if (node.status === "draft" && isClip(node.node_id) && p0 <= FRESH_P0) {
        const secs = (Date.now() - t0) / 1000 / (1 - p0);
        if (secs > 0.5) {
          clipSeconds.push(secs);
          if (clipSeconds.length > 20) clipSeconds.shift();
          saveStats();
        }
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

/** "about 40s left" for a node mid-render, projected from the progress
 * observed since we started watching (elapsed covers only the p − p0
 * slice) — needs a few seconds of movement before it dares to speak. */
export function remainingLabel(
  projectId: string,
  nodeId: string,
  progress: number,
): string | null {
  const start = startedAt.get(`${projectId}:${nodeId}`);
  if (start === undefined || progress >= 1) return null;
  const observed = progress - start.p0;
  if (observed <= 0.05) return null;
  const elapsed = (Date.now() - start.t0) / 1000;
  if (elapsed < 3) return null;
  const left = (elapsed * (1 - progress)) / observed;
  return left >= 90
    ? `about ${Math.round(left / 60)} min left`
    : `about ${Math.max(5, Math.round(left / 5) * 5)}s left`;
}
