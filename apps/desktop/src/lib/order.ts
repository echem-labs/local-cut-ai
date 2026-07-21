import type { Board, SceneCardModel } from "../api/types";

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

/** Per-scene seconds — the assembled cut's actuals when a timeline exists
 * (narration timing stretches scenes at assembly), else the planned
 * duration_s param. Shared by the monitor and the timeline strip so their
 * clocks can never disagree. */
export function sceneDurations(board: Board, scenes: SceneCardModel[]): number[] {
  const assembled = board.assembled_durations ?? {};
  return scenes.map((scene) => {
    const actual = assembled[scene.scene_id];
    if (Number.isFinite(actual) && actual > 0) return actual;
    const value = Number(scene.clip.params.duration_s);
    return Number.isFinite(value) && value > 0 ? value : 4;
  });
}

/** Reorder helper: returns the new order array with `id` moved to `to`. */
export function movedOrder(order: string[], from: number, to: number): string[] | null {
  if (to < 0 || to >= order.length || from === to || from < 0) return null;
  const next = [...order];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
