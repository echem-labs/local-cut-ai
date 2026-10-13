/**
 * The pipeline strip: what the next render would come out like, stage by
 * stage, in the order a video gets made.
 *
 * Read from the machine's readiness report, which says what each node kind
 * would get, and from GET /programs, which says which program is being set
 * up. The report alone cannot tell a stand-in that is waiting on a model
 * from one that is waiting on a program: with no weights and no ComfyUI the
 * engine names the missing model as the reason. Where the stage's program
 * is not running, the program is the cause the strip shows, because no
 * download changes that stage until it is.
 */
import type { ProgramId, ProgramsReport, ReadinessRow, ReadinessVerdict } from "../api/types";
import { programCause } from "./programs";

export type StageId =
  | "script"
  | "keyframes"
  | "clips"
  | "narration"
  | "music"
  | "captions"
  | "final";

interface StageDef {
  id: StageId;
  /** The node kinds the stage is made of, judged by the worst of them. */
  kinds: readonly string[];
  /** The program that makes it, or null for one the engine makes itself. */
  program: ProgramId | null;
}

export const PIPELINE: readonly StageDef[] = [
  { id: "script", kinds: ["script"], program: "ollama" },
  { id: "keyframes", kinds: ["keyframe"], program: "comfyui" },
  { id: "clips", kinds: ["clip"], program: "comfyui" },
  { id: "narration", kinds: ["narration"], program: null },
  { id: "music", kinds: ["music"], program: "comfyui" },
  { id: "captions", kinds: ["captions"], program: null },
  { id: "final", kinds: ["timeline", "export"], program: "ffmpeg" },
];

/** A stage's light: ready, being set up, a stand-in, a job that fails, a
 * lower-quality result, waiting on the next step's models, or not known
 * yet. */
export type Light = "ok" | "busy" | "ph" | "fail" | "deg" | "wait" | "unknown";

export interface StageView {
  id: StageId;
  light: Light;
  /** The program that is the cause, when one is. */
  program: ProgramId | null;
  /** The readiness reason behind the light; null for a ready stage. */
  reason: string | null;
}

const RANK: Record<ReadinessVerdict, number> = {
  ready: 0,
  degraded: 1,
  placeholder: 2,
  will_fail: 3,
};

const LIGHT: Record<ReadinessVerdict, Light> = {
  ready: "ok",
  degraded: "deg",
  placeholder: "ph",
  will_fail: "fail",
};

/** The reasons the first run's Models step fixes: what its downloads land. */
const NEXT_STEP = new Set(["no_model_installed", "still_clip_tier"]);

/** The reasons a model is behind: what Settings > Models can do something
 * about. Anything else that is neither a model nor a program (a cloud key,
 * an install path espeak-ng cannot read) is said as what the render would
 * do, not as a missing model. */
const MODEL_REASONS = new Set([...NEXT_STEP, "model_ignored"]);

/** Each stage as the strip shows it.
 *
 * `busy` is the programs being set up, running or waiting their turn. In
 * the wizard, a stage whose only problem is a model the next step
 * downloads waits on that step rather than reading as a failure: nothing
 * has gone wrong yet, and the next screen is where it is fixed. */
export function pipelineStages(
  rows: readonly ReadinessRow[] | null,
  programs: ProgramsReport | null,
  context: "wizard" | "settings",
  busy: ReadonlySet<ProgramId>,
): StageView[] {
  return PIPELINE.map((stage) => {
    const own = (rows ?? []).filter((row) => stage.kinds.includes(row.kind));
    if (own.length === 0) return { id: stage.id, light: "unknown", program: null, reason: null };
    const worst = own.reduce((a, b) => ((RANK[b.verdict] ?? 0) > (RANK[a.verdict] ?? 0) ? b : a));
    if (worst.verdict === "ready") {
      return { id: stage.id, light: "ok", program: null, reason: null };
    }
    const reason = worst.reason;
    const missing =
      stage.program !== null &&
      worst.reason !== "backend_not_configured" &&
      programs?.programs.find((row) => row.id === stage.program)?.state !== "ready";
    // A server without the script model is Ollama's to fix with a pull,
    // which its well spells out; the Models step downloads no LLM.
    const pulled = worst.reason === "llm_model_missing" ? "ollama" : null;
    const program = programCause(worst) ?? pulled ?? (missing ? stage.program : null);
    if (program && busy.has(program)) return { id: stage.id, light: "busy", program, reason };
    if (!program && context === "wizard" && NEXT_STEP.has(reason)) {
      return { id: stage.id, light: "wait", program: null, reason };
    }
    return { id: stage.id, light: LIGHT[worst.verdict] ?? "unknown", program, reason };
  });
}

/** What the line under the strip says. */
export type Narration =
  | { kind: "checking" }
  | { kind: "settingUp"; current: ProgramId; next: ProgramId | null; ready: ProgramId[] }
  | { kind: "render"; standIns: number; fails: StageId[] }
  | { kind: "programsReady"; all: boolean }
  | { kind: "noModel"; stages: StageId[] }
  | { kind: "allReady" };

/** The one sentence that says what the strip means, worst news first. */
export function narrate(
  stages: readonly StageView[],
  programs: ProgramsReport | null,
  context: "wizard" | "settings",
  queue: readonly ProgramId[],
): Narration {
  if (stages.every((stage) => stage.light === "unknown")) return { kind: "checking" };
  const rows = programs?.programs ?? [];
  const running = rows.find((row) => row.setup.job)?.id ?? null;
  if (running || queue.length > 0) {
    const current = running ?? queue[0];
    const next = (running ? queue[0] : queue[1]) ?? null;
    const ready = rows
      .filter((row) => row.state === "ready" && row.id !== current && !queue.includes(row.id))
      .map((row) => row.id);
    return { kind: "settingUp", current, next, ready };
  }
  // What a render would make is the news whenever a program, or anything
  // that is not a model, is behind a stand-in or a failure.
  const bad = stages.filter((stage) => stage.light === "ph" || stage.light === "fail");
  const notModels = bad.some(
    (stage) => stage.program !== null || !MODEL_REASONS.has(stage.reason ?? ""),
  );
  if (notModels) {
    return {
      kind: "render",
      standIns: stages.filter((stage) => stage.light === "ph").length,
      fails: stages.filter((stage) => stage.light === "fail").map((stage) => stage.id),
    };
  }
  if (context === "wizard") {
    const all = rows.length > 0 && rows.every((row) => row.state === "ready");
    return { kind: "programsReady", all };
  }
  const noModel = stages
    .filter((stage) => stage.light === "ph" || stage.light === "fail" || stage.light === "deg")
    .map((stage) => stage.id);
  return noModel.length > 0 ? { kind: "noModel", stages: noModel } : { kind: "allReady" };
}
