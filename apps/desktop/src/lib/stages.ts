import type { ModelRow, SystemInfo } from "../api/types";
import type { StageStatus } from "../components/StageSummaryRow";
import { displayModelName } from "../components/ModelLibrary";
import { m, t } from "../i18n";
import { OLLAMA_TASK } from "../components/ModelLibrary";

export interface StageRow {
  task: string;
  /** Short column label (SCRIPT, not SCRIPT WRITING) — the summary's stage
   * gutter is 110px, not a heading. */
  stage: string;
  name: string;
  id: string;
  status: StageStatus;
}

/**
 * The recommended pipeline as summary rows: one per stage, with live
 * install state. The wizard's last step and Home's download strip show the
 * same list — the thing you watched during setup keeps its shape when setup
 * hands you over (plan doc 11, U2).
 */
export function stageRows(system: SystemInfo | null, models: ModelRow[]): StageRow[] {
  if (!system) return [];
  const byId = new Map(models.map((row) => [row.id, row]));
  const short = m().firstRun.stages as Record<string, string>;
  const taskLabels = m().models.taskLabels as Record<string, string>;
  return system.recommendations
    .filter((rec) => rec.model !== null)
    .map((rec) => {
      const model = rec.model!;
      const row = byId.get(model.id);
      return {
        task: rec.task,
        stage: short[rec.task] ?? taskLabels[rec.task] ?? rec.task,
        name: model.family ? displayModelName(model.family, model.version) : model.id,
        id: model.id,
        status: stageStatus(row, rec.task),
      };
    });
}

export function stageStatus(row: ModelRow | undefined, task: string): StageStatus {
  const external = row ? row.files.length === 0 : true;
  if (external) {
    return {
      kind: "external",
      note:
        task === OLLAMA_TASK
          ? t("firstRun.statusExternalOllama")
          : t("firstRun.statusExternalNone"),
    };
  }
  if (row!.downloaded) return { kind: "installed" };
  if (row!.downloading && row!.progress && row!.progress.total > 0) {
    return {
      kind: "downloading",
      pct: Math.min(100, Math.round((row!.progress.done / row!.progress.total) * 100)),
    };
  }
  // Unpicked stages read queued too — precise enough for a screen the user
  // leaves within seconds, and never a lie: nothing is running.
  return { kind: "queued" };
}

/** A stage counts as ready when nothing has to be downloaded for it. */
export function readyStages(rows: StageRow[]): number {
  return rows.filter((row) => row.status.kind === "external" || row.status.kind === "installed")
    .length;
}
