import type { ModelRow, SystemInfo } from "../api/types";

/**
 * Whether a model can run on this machine's GPU. Client-side heuristic for
 * the model library's fit filter ONLY — which models the engine actually
 * picks stays engine-side (system.recommendations). Nothing mirrors this
 * on the Python side, so there is no contract test to keep in sync.
 */
export type Fit = "fits" | "tight" | "wont";

/** Offloading and quantization stretch a card past its nominal VRAM, but
 * not indefinitely: up to ~1.5x loads with reduced batch/offload ("tight"),
 * beyond that the weights simply do not fit. */
const TIGHT_FACTOR = 1.5;

export function fitFor(row: Pick<ModelRow, "requirements">, system: SystemInfo | null): Fit {
  const need = row.requirements.vram_gb;
  if (need <= 0) return "fits"; // CPU models
  const gpu = system?.hardware.primary_gpu ?? system?.hardware.gpus[0] ?? null;
  if (!gpu) return "wont";
  if (need <= gpu.vram_gb) return "fits";
  if (need <= gpu.vram_gb * TIGHT_FACTOR) return "tight";
  return "wont";
}
