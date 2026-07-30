import { describe, expect, it } from "vitest";
import { displaySeconds } from "./formats";

describe("displaySeconds", () => {
  it("caps take-split planning floats at one decimal", () => {
    // A 20s scene split into 3 takes plans 20/3 per take — the tile said
    // "~6.666666666666667s" without the rounding.
    expect(displaySeconds(20 / 3)).toBe(6.7);
  });

  it("leaves round and half-second values alone", () => {
    expect(displaySeconds(5)).toBe(5);
    expect(displaySeconds(7.5)).toBe(7.5);
  });
});
