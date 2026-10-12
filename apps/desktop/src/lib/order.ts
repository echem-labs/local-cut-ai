import type { Board, SceneCardModel } from "../api/types";
import { spokenSeconds } from "./formats";

/** The cut order: the timeline node's `order` param wins; scenes it doesn't
 * know about (or a missing param) fall back to board order. Deduped so a
 * malformed server order can't render a scene twice. Shared by the board
 * grid and the timeline so dragging in one reorders the other. */
export function orderedScenes(board: Board): SceneCardModel[] {
  const byId = new Map(board.scenes.map((scene) => [scene.scene_id, scene]));
  const orderParam = board.aux.timeline?.params.order;
  const known = Array.isArray(orderParam)
    ? [...new Set((orderParam as string[]).filter((id) => byId.has(id)))]
    : [];
  const rest = board.scenes.map((s) => s.scene_id).filter((id) => !known.includes(id));
  return [...known, ...rest].map((id) => byId.get(id)!);
}

export interface SceneLength {
  seconds: number;
  /** True until the assembled cut has measured this scene. */
  estimate: boolean;
}

/** How long one scene runs. The assembled cut's actual once a timeline
 * exists, because narration timing stretches scenes at assembly. Before
 * that, assembly's own rule (backends/ffmpeg.py) gives the best guess: a
 * narrated scene lasts as long as its line takes to speak plus the pad, and
 * a silent one as long as its clip material.
 *
 * Never the clip's `duration_s` alone. That is ONE take's planned length,
 * and a scene whose narration outruns a take is split into several, so on
 * a split scene it was a third of the scene. Null when there is nothing to
 * go on at all. */
export function sceneLength(board: Board, scene: SceneCardModel): SceneLength | null {
  const actual = board.assembled_durations?.[scene.scene_id];
  if (typeof actual === "number" && Number.isFinite(actual) && actual > 0) {
    return { seconds: actual, estimate: false };
  }
  const words = String(scene.narration?.params.text ?? "").trim();
  if (words) return { seconds: spokenSeconds(words), estimate: true };
  let material = 0;
  for (const take of [scene.clip, ...(scene.clip_takes ?? [])]) {
    const value = Number(take?.params.duration_s);
    if (Number.isFinite(value) && value > 0) material += value;
  }
  return material > 0 ? { seconds: material, estimate: true } : null;
}

/** Per-scene seconds, by `sceneLength`. Shared by the monitor and the
 * timeline strip so their clocks can never disagree, and by the same rule
 * as the scene cards so neither can the numbers printed on them. */
export function sceneDurations(board: Board, scenes: SceneCardModel[]): number[] {
  return scenes.map((scene) => sceneLength(board, scene)?.seconds ?? 4);
}

/** Reorder helper: returns the new order array with `id` moved to `to`. */
export function movedOrder(order: string[], from: number, to: number): string[] | null {
  if (to < 0 || to >= order.length || from === to || from < 0) return null;
  const next = [...order];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
