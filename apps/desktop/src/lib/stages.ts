import type { ModelRow, ProgramInfo, ProgramsReport, SystemInfo } from "../api/types";
import type { StageStatus } from "../components/StageSummaryRow";
import { m, t, type MessageKey } from "../i18n";
import { displayModelName, OLLAMA_TASK } from "../components/ModelLibrary";
import { programName, setupFraction } from "./programs";

export interface StageRow {
  task: string;
  /** The stage's short name (Script, not Script writing): the summary's
   * stage column is a gutter, not a heading. */
  stage: string;
  name: string;
  /** What runs the model, or who set the program up; empty when unknown. */
  runner: string;
  id: string;
  status: StageStatus;
}

/** What runs each task's model: a program the user sets up, or the engine
 * itself. It is the line that explains why some stages needed the Programs
 * step and some did not. */
const RUNNERS: Readonly<Record<string, MessageKey>> = {
  "text.llm": "firstRun.runners.ollama",
  "image.gen": "firstRun.runners.comfyui",
  "video.i2v": "firstRun.runners.comfyui",
  "video.t2v": "firstRun.runners.comfyui",
  "music.gen": "firstRun.runners.comfyui",
  "speech.tts": "firstRun.runners.builtIn",
  transcribe: "firstRun.runners.builtIn",
};

/**
 * The recommended pipeline as summary rows: one per stage, with live
 * install state. The wizard's last step and Home's download strip show the
 * same list — the thing you watched during setup keeps its shape when setup
 * hands you over (plan doc 11, U2).
 *
 * The script is the one stage whose model lives in a program rather than
 * on LocalCut's disk, so with GET /programs in hand its row names the model
 * the engine will actually ask for, and says whether the server has it.
 */
export function stageRows(
  system: SystemInfo | null,
  models: ModelRow[],
  programs: ProgramsReport | null = null,
): StageRow[] {
  if (!system) return [];
  const byId = new Map(models.map((row) => [row.id, row]));
  const short = m().firstRun.stages as Record<string, string>;
  const taskLabels = m().models.taskLabels as Record<string, string>;
  const server = programs?.programs.find((row) => row.id === "ollama");
  return system.recommendations
    .filter((rec) => rec.model !== null)
    .map((rec) => {
      const model = rec.model!;
      const row = byId.get(model.id);
      const script = rec.task === OLLAMA_TASK && server ? server : null;
      return {
        task: rec.task,
        stage: short[rec.task] ?? taskLabels[rec.task] ?? rec.task,
        name:
          script?.checks.model ??
          (model.family ? displayModelName(model.family, model.version) : model.id),
        runner: RUNNERS[rec.task] ? t(RUNNERS[rec.task]) : "",
        id: model.id,
        status: script ? scriptStatus(script) : stageStatus(row, rec.task),
      };
    });
}

/** The script stage, read off the LLM server's row. */
function scriptStatus(server: ProgramInfo): StageStatus {
  if (server.state !== "ready") {
    return { kind: "missing", note: t("firstRun.statusNeedsOllama"), light: "ph" };
  }
  if (server.checks.model_present === false) {
    return { kind: "missing", note: t("firstRun.statusNotPulled"), light: "fail" };
  }
  return { kind: "installed" };
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

/** The final video, which FFmpeg makes rather than a model: its row on the
 * Ready step, from GET /programs. Null until that has answered. */
export function finalVideoRow(programs: ProgramsReport | null): StageRow | null {
  const ffmpeg = programs?.programs.find((row) => row.id === "ffmpeg");
  if (!ffmpeg) return null;
  const job = ffmpeg.setup.job;
  const ready = ffmpeg.state === "ready";
  const status: StageStatus = job
    ? { kind: "settingUp", pct: Math.round(setupFraction(job) * 100) }
    : ready
      ? { kind: "installed" }
      : { kind: "missing", note: t("firstRun.statusNotFound"), light: "fail" };
  return {
    task: "final",
    stage: t("programs.strip.stages.final"),
    name: ffmpeg.version && ready ? `${programName("ffmpeg")} ${ffmpeg.version}` : programName("ffmpeg"),
    runner: !ready
      ? ""
      : ffmpeg.source === "managed"
        ? t("firstRun.runners.setUpByLocalCut")
        : t("firstRun.runners.yourOwn"),
    id: "ffmpeg",
    status,
  };
}

/** A stage counts as ready when nothing has to be downloaded for it. */
export function readyStages(rows: StageRow[]): number {
  return rows.filter((row) => row.status.kind === "external" || row.status.kind === "installed")
    .length;
}
