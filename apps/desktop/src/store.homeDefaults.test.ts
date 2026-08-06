/**
 * What Home starts on before anyone has chosen.
 *
 * `mode` decides whether a first video runs end-to-end or pauses at the
 * script and the storyboard. The checkpoints are where changing your mind is
 * cheap — the script is text, the storyboard a handful of stills, and both
 * come before the clips that cost the GPU hours — so an unreviewed run is
 * the expensive default, not the convenient one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useApp } from "./store";

beforeEach(() => localStorage.clear());

describe("the shipped Home defaults", () => {
  it("reviews the steps until someone says otherwise", () => {
    expect(useApp.getState().defaults.mode).toBe("beginner");
  });

  it("still lets a stored preference win", () => {
    // The fallback is a starting point, not a policy: someone who picked
    // Auto once must not be put back on Review every launch.
    useApp.getState().setDefaults({ mode: "prompt" });
    expect(useApp.getState().defaults.mode).toBe("prompt");
  });
});
