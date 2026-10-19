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

/** The quality ladder, as the engine's ComfyUI backend renders it
 * (`_BASE_STEPS`, `_FINAL_STEPS_SCALE` and `_FINAL_RES_SCALE` in
 * backends/comfyui.py): each kind's sampler steps at draft and at final
 * quality, and how many times wider and taller its final frame is. Only a
 * clip changes size; its draft renders small for reviewing the pacing.
 * test_ui_contract holds this table to the engine. */
const LADDER = {
  keyframe: { draftSteps: 20, finalSteps: 30, scale: 1 },
  clip: { draftSteps: 25, finalSteps: 38, scale: 1.5 },
  music: { draftSteps: 27, finalSteps: 40, scale: 1 },
} as const;

type LadderKind = keyof typeof LADDER;

/** How a render's time grows with its frame's area: as area^1.25. Measured
 * on an 8 GB RTX 3080 Laptop GPU (hardware tier A) on 2026-10-19, where
 * LTX-Video's 7 s drafts at 768x448 and 25 steps took a median 105 s and
 * its finals at 1152x672 and 38 steps took 440 s. That is 4.19 times the
 * draft: 1.52 for the extra steps, and 2.76 for a frame with 2.25 times the
 * pixels. The cost outruns the pixels because attention over the video's
 * latent grows with the square of its token count. */
const AREA_COST_EXPONENT = 1.25;

// Timeline, captions and MP4 export, added once — the fallback for those
// kinds when the engine has measured none of them.
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
// excluded: they would be double-counted by `finalCostFactor` below.
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

/** How many times a draft's render time a final render of `kind` takes:
 * its extra sampler steps, times its larger frame at the measured cost of
 * area. */
export function finalCostFactor(kind: LadderKind): number {
  const { draftSteps, finalSteps, scale } = LADDER[kind];
  return (finalSteps / draftSteps) * (scale * scale) ** AREA_COST_EXPONENT;
}

/** Seconds one node of `kind` costs at FINAL quality, or null if nothing has
 * measured one. The engine's final-quality median is the only source that
 * needs no arithmetic; everything below it is a draft timing scaled by the
 * ladder. This window's own draft timings exist for clips alone. */
function finalSeconds(kind: LadderKind): number | null {
  const measured = engineMedian(kind, "final");
  if (measured !== null) return measured;
  const draft = engineMedian(kind, "draft");
  if (draft !== null) return draft * finalCostFactor(kind);
  if (kind !== "clip" || clipSeconds.length === 0) return null;
  const avg = clipSeconds.reduce((sum, s) => sum + s, 0) / clipSeconds.length;
  return avg * finalCostFactor(kind);
}

/** Whether Create final video renders this node again: everything the
 * ladder covers that is not final yet, pinned, or skipped for the user's own
 * picture. */
const rendersAgain = (node: NodeState | null | undefined): boolean =>
  !!node && node.status !== "final" && node.status !== "skipped" && !node.pinned;

/** "~9 min" for the Create-final-video CTA, or null when no clip render has
 * been measured anywhere — by this session or by the engine.
 *
 * The final pass renders each scene's keyframe and clip again, and the
 * music, then assembles. Clips are nearly all of it; a keyframe or music
 * nothing has timed adds nothing rather than a guess. */
export function finalizeEta(board: Board): string | null {
  const perClip = finalSeconds("clip");
  if (perClip === null) return null;
  const clips = board.scenes.filter((scene) => rendersAgain(scene.clip)).length;
  const keyframes = board.scenes.filter((scene) => rendersAgain(scene.keyframe)).length;
  const music = rendersAgain(board.aux.music) ? 1 : 0;
  const renders =
    clips * perClip +
    keyframes * (finalSeconds("keyframe") ?? 0) +
    music * (finalSeconds("music") ?? 0);
  // Assembly is three more renders the engine also times. Falling back to
  // one flat constant for them only when it has measured none: part a
  // measured tail and part a guess is a worse number than either.
  const timeline = engineMedian("timeline", "final") ?? engineMedian("timeline", "draft");
  const captions = board.aux.captions
    ? (engineMedian("captions", "final") ?? engineMedian("captions", "draft"))
    : null;
  const exportTail = engineMedian("export", "final") ?? engineMedian("export", "draft");
  const tail =
    timeline !== null || captions !== null || exportTail !== null
      ? (timeline ?? 0) + (captions ?? 0) + (exportTail ?? 0)
      : ASSEMBLY_TAIL_S;
  return formatEta(renders + tail);
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
