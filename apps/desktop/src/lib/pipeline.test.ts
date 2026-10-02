/**
 * The strip's lights and its sentence, from the readiness report and the
 * programs report, in the states the setup screens are drawn for: a fresh
 * machine, a setup under way, every program up with no models yet, and a
 * machine that is ready but for one model.
 */
import { describe, expect, it } from "vitest";

import type { ProgramInfo, ProgramsReport, ReadinessRow } from "../api/types";
import { narrate, pipelineStages, type Light } from "./pipeline";

const row = (kind: string, verdict: ReadinessRow["verdict"], reason: string): ReadinessRow => ({
  kind,
  model: null,
  backend: null,
  verdict,
  reason: reason as ReadinessRow["reason"],
  data: {},
  fix: null,
});

function program(id: ProgramInfo["id"], state: ProgramInfo["state"], job = false): ProgramInfo {
  return {
    id,
    state,
    problem: state === "ready" ? null : "not_found",
    source: "default",
    location: "",
    setting: "",
    version: null,
    checks: {},
    managed: null,
    setup: {
      available: id === "ffmpeg",
      unavailable_reason: null,
      takes_effect: true,
      version: null,
      url: null,
      download_bytes: 1,
      install_bytes: 1,
      job: job ? { id: "j", phase: "downloading", done: 0, total: 1, bytes_per_s: null } : null,
      last: null,
    },
  };
}

const report = (rows: ProgramInfo[]): ProgramsReport => ({
  platform: "linux-x64",
  programs_dir: "/p",
  programs_bytes: 0,
  disk_free_bytes: 1,
  programs: rows,
});

/** A machine with nothing on it: no programs, no models. */
const FRESH_ROWS = [
  row("script", "placeholder", "llm_server_down"),
  row("keyframe", "placeholder", "no_model_installed"),
  row("clip", "placeholder", "no_model_installed"),
  row("narration", "placeholder", "no_model_installed"),
  row("captions", "placeholder", "no_model_installed"),
  row("music", "placeholder", "no_model_installed"),
  row("timeline", "will_fail", "no_ffmpeg"),
  row("export", "will_fail", "no_ffmpeg"),
];

const lights = (views: { light: Light }[]) => views.map((view) => view.light);

describe("the strip on a first run", () => {
  it("shows a fresh machine: stand-ins, two stages waiting on models, and a failing video", () => {
    const programs = report([
      program("ffmpeg", "missing"),
      program("ollama", "missing"),
      program("comfyui", "missing"),
    ]);
    const stages = pipelineStages(FRESH_ROWS, programs, "wizard", new Set());
    // ComfyUI is not running, so keyframes, clips and music are its stand-ins
    // even though the engine names the missing model as the reason.
    expect(lights(stages)).toEqual(["ph", "ph", "ph", "wait", "ph", "wait", "fail"]);
    expect(narrate(stages, programs, "wizard", [])).toEqual({
      kind: "render",
      standIns: 4,
      fails: ["final"],
    });
  });

  it("lights the stages a setup is fixing while it runs", () => {
    const programs = report([
      program("ffmpeg", "missing", true),
      program("ollama", "ready"),
      program("comfyui", "missing"),
    ]);
    const stages = pipelineStages(FRESH_ROWS, programs, "wizard", new Set(["ffmpeg"]));
    expect(stages.find((stage) => stage.id === "final")?.light).toBe("busy");
    expect(narrate(stages, programs, "wizard", [])).toEqual({
      kind: "settingUp",
      current: "ffmpeg",
      next: null,
      ready: ["ollama"],
    });
  });

  it("names the program queued after the running one", () => {
    const programs = report([
      program("ffmpeg", "missing", true),
      program("ollama", "missing"),
      program("comfyui", "missing"),
    ]);
    const stages = pipelineStages(FRESH_ROWS, programs, "wizard", new Set(["ffmpeg", "comfyui"]));
    expect(narrate(stages, programs, "wizard", ["comfyui"])).toMatchObject({
      current: "ffmpeg",
      next: "comfyui",
    });
  });

  it("waits on the next step once every program is up", () => {
    const programs = report([
      program("ffmpeg", "ready"),
      program("ollama", "ready"),
      program("comfyui", "ready"),
    ]);
    const rows = [
      ...FRESH_ROWS.filter((row) => row.kind !== "timeline" && row.kind !== "export"),
      row("timeline", "ready", "ok"),
      row("export", "ready", "ok"),
    ].map((r) => (r.kind === "script" ? row("script", "placeholder", "no_model_installed") : r));
    const stages = pipelineStages(rows, programs, "wizard", new Set());
    expect(lights(stages)).toEqual(["wait", "wait", "wait", "wait", "wait", "wait", "ok"]);
    expect(narrate(stages, programs, "wizard", [])).toEqual({ kind: "programsReady", all: true });
  });

  it("blames a server without the script model on that server", () => {
    // Pulling it is Ollama's to do, and nothing in the Models step does it.
    const programs = report([program("ollama", "ready")]);
    const stages = pipelineStages(
      [row("script", "will_fail", "llm_model_missing")],
      programs,
      "wizard",
      new Set(),
    );
    expect(stages[0]).toMatchObject({ light: "fail", program: "ollama" });
    expect(narrate(stages, programs, "wizard", [])).toMatchObject({
      kind: "render",
      fails: ["script"],
    });
  });

  it("knows nothing until the engine has answered", () => {
    const stages = pipelineStages(null, null, "wizard", new Set());
    expect(lights(stages).every((light) => light === "unknown")).toBe(true);
    expect(narrate(stages, null, "wizard", [])).toEqual({ kind: "checking" });
  });
});

describe("the strip in Settings", () => {
  const programs = report([
    program("ffmpeg", "ready"),
    program("ollama", "ready"),
    program("comfyui", "ready"),
  ]);
  const ready = (kind: string) => row(kind, "ready", "ok");

  it("sends a stage that only lacks a model to Models", () => {
    const rows = [
      ready("script"),
      ready("keyframe"),
      ready("clip"),
      ready("narration"),
      ready("captions"),
      row("music", "placeholder", "no_model_installed"),
      ready("timeline"),
      ready("export"),
    ];
    const stages = pipelineStages(rows, programs, "settings", new Set());
    // Not "next step": there is no next step in Settings, only the gap.
    expect(stages.find((stage) => stage.id === "music")?.light).toBe("ph");
    expect(narrate(stages, programs, "settings", [])).toEqual({
      kind: "noModel",
      stages: ["music"],
    });
  });

  it("says so when every stage is ready", () => {
    const kinds = ["script", "keyframe", "clip", "narration", "captions", "music"];
    const rows = [...kinds, "timeline", "export"].map(ready);
    const stages = pipelineStages(rows, programs, "settings", new Set());
    expect(narrate(stages, programs, "settings", [])).toEqual({ kind: "allReady" });
  });

  it("leaves a stage an all-mock engine makes out of the program's account", () => {
    const mocked = [row("export", "placeholder", "backend_not_configured")];
    const programs = report([program("ffmpeg", "missing")]);
    const stages = pipelineStages(mocked, programs, "settings", new Set());
    const final = stages.find((stage) => stage.id === "final");
    expect(final).toMatchObject({ light: "ph", program: null });
  });
});

describe("a gap that is neither a program nor a model", () => {
  it("is said as what the render would do, not as a missing model", () => {
    // An install path espeak-ng cannot read fails every narration, and no
    // model download fixes it.
    const programs = report([
      program("ffmpeg", "ready"),
      program("ollama", "ready"),
      program("comfyui", "ready"),
    ]);
    const kinds = ["script", "keyframe", "clip", "captions", "music", "timeline", "export"];
    const rows = [
      ...kinds.map((kind) => row(kind, "ready", "ok")),
      row("narration", "will_fail", "install_path_too_long"),
    ];
    for (const context of ["wizard", "settings"] as const) {
      const stages = pipelineStages(rows, programs, context, new Set());
      expect(stages.find((stage) => stage.id === "narration")?.light).toBe("fail");
      expect(narrate(stages, programs, context, [])).toEqual({
        kind: "render",
        standIns: 0,
        fails: ["narration"],
      });
    }
  });
});
