import type { SystemInfo } from "../api/types";
import { t } from "../i18n";

/**
 * The machine's hardware as a row of quiet pill chips: GPU (with VRAM),
 * RAM, free disk. Shared by wizard step 2 now and About "This machine"
 * later (plan doc 11 inventory) — one rendering of the facts, so the two
 * screens can never disagree about what was detected.
 */
export function SpecChips({ system }: { system: SystemInfo }) {
  const gpu = system.hardware.primary_gpu ?? system.hardware.gpus[0] ?? null;
  return (
    <div className="spec-chips">
      <span className="spec-chip">
        {gpu
          ? t("firstRun.gpuChip", { gpu: gpu.name, vram: gpu.vram_gb })
          : t("firstRun.noGpuChip")}
      </span>
      <span className="spec-chip">{t("firstRun.ramChip", { ram: system.hardware.ram_gb })}</span>
      <span className="spec-chip">
        {t("firstRun.diskChip", { disk: system.hardware.disk_free_gb })}
      </span>
    </div>
  );
}
