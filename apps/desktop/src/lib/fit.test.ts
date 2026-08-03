/**
 * The fit heuristic behind the library's "Fits this machine" filter. The
 * boundaries are the contract: at the card's VRAM it fits, up to 1.5x it
 * is tight (offload territory), past that it cannot load — and a machine
 * with no GPU can still run CPU models but nothing else.
 */
import { describe, expect, it } from "vitest";
import type { SystemInfo } from "../api/types";
import { fitFor } from "./fit";

const system = (vram: number | null): SystemInfo | null =>
  vram === null
    ? ({
        hardware: { gpus: [], primary_gpu: null },
      } as unknown as SystemInfo)
    : ({
        hardware: {
          gpus: [],
          primary_gpu: { vendor: "NVIDIA", name: "RTX", vram_gb: vram, backend: "cuda" },
        },
      } as unknown as SystemInfo);

const needs = (vram_gb: number) => ({ requirements: { vram_gb, ram_gb: 0, disk_gb: 0, backends: [] } });

describe("fitFor", () => {
  it.each([
    ["at the card's VRAM", 8, 8, "fits"],
    ["under it", 6, 8, "fits"],
    ["just over — offloadable", 10, 8, "tight"],
    ["at exactly 1.5x", 12, 8, "tight"],
    ["past 1.5x — cannot load", 13, 8, "wont"],
    ["far past", 16, 8, "wont"],
  ])("%s: needs %d on %d GB → %s", (_label, need, vram, expected) => {
    expect(fitFor(needs(need), system(vram))).toBe(expected);
  });

  it("CPU models fit any machine, GPU models fit none without a GPU", () => {
    expect(fitFor(needs(0), system(null))).toBe("fits");
    expect(fitFor(needs(4), system(null))).toBe("wont");
  });

  it("no system info at all reads as no GPU", () => {
    expect(fitFor(needs(0), null)).toBe("fits");
    expect(fitFor(needs(8), null)).toBe("wont");
  });
});
