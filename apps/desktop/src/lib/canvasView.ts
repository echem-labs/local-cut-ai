/**
 * The canvas's view transform: zoom, and the scroll that keeps a point still
 * while it changes.
 *
 * Pure on purpose, like graphLayout beside it. Layout answers "where is this
 * node in the graph"; this answers "where is that on screen right now" — and
 * neither needs a DOM to be right. The component owns the elements and the
 * events; everything below is arithmetic it calls.
 *
 * Zoom is session state and never persisted. A saved zoom would be the first
 * per-machine thing in a project directory whose whole point is that it opens
 * identically on someone else's machine (see graphLayout's rule 2).
 */

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2;
/** One press of − or +. Also the grid clampZoom snaps to. */
export const ZOOM_STEP = 0.1;
/** Per wheel notch (~100px of deltaY). Ratio, not addition — see wheelZoom. */
const WHEEL_RATIO = 1.0015;

/** Into range, and onto the 1% grid the toolbar's percentage reads from. */
export const clampZoom = (zoom: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

/** One notch of the −/+ cluster. `direction` is +1 in, −1 out. */
export const stepZoom = (zoom: number, direction: 1 | -1): number =>
  clampZoom(zoom + direction * ZOOM_STEP);

/**
 * A wheel notch, as a RATIO of the current zoom.
 *
 * Adding a fixed step makes the control feel like two different controls: at
 * 40% a +0.1 notch is a quarter bigger, at 200% it is a twentieth. Scaling
 * keeps one notch worth the same fraction wherever you are.
 *
 * `deltaY` follows the DOM's sign — negative is a scroll up, which zooms in.
 */
export const wheelZoom = (zoom: number, deltaY: number): number =>
  clampZoom(zoom * WHEEL_RATIO ** -deltaY);

export interface Size {
  width: number;
  height: number;
}

/**
 * The zoom at which the whole graph fits the viewport.
 *
 * Never above 1: "Fit" on a four-node graph should show four nodes at their
 * designed size, not four nodes blown up to fill a 4K panel. A viewport of
 * zero (the panel measured before layout) falls back to 1 rather than
 * dividing by it.
 */
export function fitZoom(content: Size, viewport: Size): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  if (content.width <= 0 || content.height <= 0) return 1;
  return clampZoom(Math.min(1, viewport.width / content.width, viewport.height / content.height));
}

/**
 * Where to scroll so a graph point stays under the pointer at a new zoom.
 *
 * `graph` is the point in graph coordinates (what layoutGraph produces);
 * `pointer` is where that point currently sits inside the viewport, measured
 * from its top-left corner. Both come off one event, before the zoom moves.
 */
export function anchoredScroll(
  graph: { gx: number; gy: number },
  pointer: { cx: number; cy: number },
  zoom: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, graph.gx * zoom - pointer.cx),
    top: Math.max(0, graph.gy * zoom - pointer.cy),
  };
}
