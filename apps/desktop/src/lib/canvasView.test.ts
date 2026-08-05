/**
 * The canvas's view transform, as arithmetic.
 *
 * Zoom is the one piece of canvas state that is NOT derived from the graph,
 * so it is the one piece that can be wrong on its own. Keeping the math out
 * of the component is what lets these cases exist at all: a DOM test can
 * assert that a wheel event changed a number, but not that the point under
 * the cursor stayed under the cursor.
 */
import { describe, expect, it } from "vitest";

import {
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredScroll,
  clampZoom,
  fitZoom,
  stepZoom,
  wheelZoom,
} from "./canvasView";

describe("clampZoom", () => {
  it("holds the range and snaps off floating-point dust", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    // 0.1 + 0.2 arithmetic reaches the toolbar as a percentage: 70.00000001%
    // renders as "70%" but never equals a step, so the − button would walk
    // off the grid it is supposed to move on.
    expect(clampZoom(0.7000000000000001)).toBe(0.7);
  });
});

describe("stepZoom", () => {
  it("moves one notch per press and stops at the ends", () => {
    expect(stepZoom(1, +1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(ZOOM_MAX, +1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
});

describe("wheelZoom", () => {
  it("scales by ratio, so a notch feels the same at every magnification", () => {
    // Additive steps make zooming out crawl and zooming in leap: +0.1 from
    // 0.4 is +25%, from 2.0 it is +5%. Tolerance is one decimal, not two:
    // the 1% snap in clampZoom is worth ±1.25% of a ratio down at 0.4. An
    // additive implementation misses by 0.18 — far outside this — so the
    // case still tells the two apart.
    const inAt40 = wheelZoom(0.4, -100) / 0.4;
    const inAt150 = wheelZoom(1.5, -100) / 1.5;
    expect(inAt40).toBeCloseTo(inAt150, 1);
    expect(wheelZoom(1, -100)).toBeGreaterThan(1); // wheel up = closer
    expect(wheelZoom(1, +100)).toBeLessThan(1);
    expect(wheelZoom(ZOOM_MAX, -1000)).toBe(ZOOM_MAX);
  });
});

describe("fitZoom", () => {
  it("takes the tighter axis and never enlarges past 1", () => {
    // Wide content, short viewport: height decides.
    expect(fitZoom({ width: 1000, height: 1000 }, { width: 900, height: 500 })).toBe(0.5);
    expect(fitZoom({ width: 1000, height: 100 }, { width: 500, height: 900 })).toBe(0.5);
    // A graph smaller than the viewport sits at 100%: blowing four nodes up
    // to fill a 4K panel is not "fit", it is a magnifying glass.
    expect(fitZoom({ width: 100, height: 100 }, { width: 900, height: 900 })).toBe(1);
    // Degenerate viewport (panel not laid out yet) must not divide by zero.
    expect(fitZoom({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("anchoredScroll", () => {
  it("keeps the graph point under the pointer while the zoom changes", () => {
    // Graph point (400,300) sits 120px right / 80px down inside the viewport.
    const scroll = anchoredScroll({ gx: 400, gy: 300 }, { cx: 120, cy: 80 }, 1.5);
    expect(scroll.left).toBe(400 * 1.5 - 120);
    expect(scroll.top).toBe(300 * 1.5 - 80);
  });

  it("never scrolls to a negative offset", () => {
    // Zooming out near the origin: the anchor would pull the stage past its
    // own edge, which the DOM clamps to 0 anyway — do it here so the number
    // the component sets is the number the surface reports back.
    const scroll = anchoredScroll({ gx: 10, gy: 10 }, { cx: 300, cy: 300 }, 0.5);
    expect(scroll).toEqual({ left: 0, top: 0 });
  });
});
