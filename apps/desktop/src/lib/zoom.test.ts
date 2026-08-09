/**
 * The title bar has to stay the size the OS chrome was sized against.
 *
 * The window is frameless: the renderer draws the bar, and the shell paints
 * the real min/max/close buttons on top of its right end via
 * `titleBarOverlay`. That overlay's height is in DEVICE pixels and is fixed
 * at creation — it does not move when the renderer zooms. `--titlebar-h` is
 * CSS, so it does.
 *
 * At 80% that put a ~30-pixel bar under a 37-pixel overlay: the buttons hung
 * below the bar's bottom border, and the divider line stopped short of them.
 * So the CSS height is divided by the applied zoom, which holds the bar at a
 * constant device height while everything inside it still scales.
 *
 * Divided by the APPLIED factor, not the requested one — the preload clamps
 * to [0.5, 3], and a bar sized against an unclamped number would be wrong in
 * exactly the case the clamp exists for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const setUiZoom = vi.fn();

const barHeight = () => document.documentElement.style.getPropertyValue("--titlebar-h");

/** Fresh module per test: the zoom it applies is module state. */
async function load(stored?: string) {
  vi.resetModules();
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem("localcut.uiZoom", stored);
  document.documentElement.style.removeProperty("--titlebar-h");
  setUiZoom.mockClear();
  return import("./zoom");
}

beforeEach(() => {
  (window as unknown as { localcut: unknown }).localcut = {
    setUiZoom,
    getSystemTextScale: vi.fn().mockResolvedValue(1),
  };
});

describe("the bar's height against the OS overlay", () => {
  it("leaves it at the declared height when nothing is zoomed", async () => {
    const { setUserZoom } = await load();
    setUserZoom(1);
    expect(setUiZoom).toHaveBeenLastCalledWith(1);
    expect(barHeight()).toBe("38px");
  });

  it("grows the CSS height as the app zooms out", async () => {
    // 38 / 0.8 CSS px, rendered at 0.8, is 38 device px — what the overlay is.
    const { setUserZoom } = await load();
    setUserZoom(0.8);
    expect(barHeight()).toBe("47.5px");
  });

  it("shrinks it as the app zooms in", async () => {
    const { setUserZoom } = await load();
    setUserZoom(1.25);
    expect(barHeight()).toBe("30.4px");
  });

  it("sizes against the factor the preload will actually apply", async () => {
    // The bridge clamps to [0.5, 3]. Dividing by an unclamped 4 would give a
    // bar a quarter of the size of the overlay it has to line up with.
    const { setUserZoom } = await load();
    setUserZoom(4);
    expect(barHeight()).toBe(`${38 / 3}px`);
  });

  it("leaves the height alone with no shell to zoom", async () => {
    // A plain browser (vite dev) owns its own zoom; the app must not pretend
    // to have applied one.
    delete (window as unknown as { localcut?: unknown }).localcut;
    const { setUserZoom } = await load();
    setUserZoom(0.8);
    expect(setUiZoom).not.toHaveBeenCalled();
    expect(barHeight()).toBe("");
  });
});
