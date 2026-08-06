import type { Board, EngineEtas, NodeState } from "../api/types";
import { t } from "../i18n";

/** Render timing, measured — never invented. Nothing observed → nothing
 * shown.
 *
 * Two sources, in this order. The ENGINE's own medians (`/system/etas`,
 * over completed jobs from every project on that machine) are the
 * authority: they are measured where the work actually happens, which is
 * the whole point on a remote engine, and they survive a restart. This
 * window's own observation of a live render is the fallback — it is all
 * `remainingLabel` can use (a job in flight has no median yet), and it
 * covers the beat before /system/etas has answered. */

// Finals render at full quality — slower than a draft. A GUESS, and used
// only when the engine has no final-quality median of its own to offer.
const FINAL_QUALITY_FACTOR = 1.5;
// Timeline assembly + MP4 export tail, added once — the fallback for the
// same pair of kinds when the engine has not measured them either.
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
// excluded: they would be double-counted by FINAL_QUALITY_FACTOR below.
//
// In memory only, and deliberately no longer persisted. It used to be
// cached in `localStorage` under one global key so a new session had an
// estimate before its first render — but that key belongs to no engine in
// particular, and pointing the desktop at a remote engine quoted the
// laptop's timings for work a GPU box was about to do. /system/etas answers
// the same need correctly: it persists on the machine that renders, and it
// cannot disagree with itself about which machine that is.
const clipSeconds: number[] = [];

// The engine's own medians, newest snapshot wins. `null` until /system/etas
// has answered — which is not the same as "answered with nothing", and both
// mean the same thing here: fall through to what this session saw.
let engineEtas: EngineEtas | null = null;

/** Store the engine's calibration. Call with `null` to forget it (a
 * disconnect, or a switch to a different engine — whose timings are its
 * own). */
export function setEngineEtas(etas: EngineEtas | null): void {
  engineEtas = etas;
}

/** Median seconds the engine has measured for one kind at one quality. */
const engineMedian = (kind: string, quality: "draft" | "final"): number | null => {
  const seconds = engineEtas?.[kind]?.[quality]?.seconds;
  return typeof seconds === "number" && seconds > 0 ? seconds : null;
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
  secs >= 90
    ? t("eta.etaMin", { n: Math.ceil(secs / 60) })
    : t("eta.etaSec", { n: Math.max(10, Math.round(secs / 10) * 10) });

/** Seconds one clip costs at FINAL quality, or null if nothing has measured
 * one. The engine's final-quality median is the only source that needs no
 * arithmetic; everything below it is a draft timing with the factor
 * applied. */
function finalClipSeconds(): number | null {
  const measured = engineMedian("clip", "final");
  if (measured !== null) return measured;
  const draft = engineMedian("clip", "draft");
  if (draft !== null) return draft * FINAL_QUALITY_FACTOR;
  if (clipSeconds.length === 0) return null;
  const avg = clipSeconds.reduce((sum, s) => sum + s, 0) / clipSeconds.length;
  return avg * FINAL_QUALITY_FACTOR;
}

/** "~9 min" for the Create-final-video CTA, or null when no clip render has
 * been measured anywhere — by this session or by the engine. */
export function finalizeEta(board: Board): string | null {
  const perClip = finalClipSeconds();
  if (perClip === null) return null;
  const toRender = board.scenes.filter(
    (scene) => scene.clip.status !== "final" && !scene.clip.pinned,
  ).length;
  // Assembly is two more renders the engine also times. Falling back to one
  // flat constant for the pair only when it has measured neither: half a
  // measured tail plus half a guess is a worse number than either.
  const timeline = engineMedian("timeline", "final") ?? engineMedian("timeline", "draft");
  const exportTail = engineMedian("export", "final") ?? engineMedian("export", "draft");
  const tail =
    timeline !== null || exportTail !== null
      ? (timeline ?? 0) + (exportTail ?? 0)
      : ASSEMBLY_TAIL_S;
  return formatEta(toRender * perClip + tail);
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
    ? t("eta.leftMin", { n: Math.round(left / 60) })
    : t("eta.leftSec", { n: Math.max(5, Math.round(left / 5) * 5) });
}
