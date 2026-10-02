/**
 * The rules behind the programs screens, without a screen: which program a
 * readiness row blames, what a well offers, what a program costs the render,
 * and the steps for setting one up by hand on the ENGINE's system.
 */
import { describe, expect, it } from "vitest";

import type { ProgramInfo, ProgramsReport, ReadinessRow } from "../api/types";
import {
  binDirOf,
  comfyModelPaths,
  manualSteps,
  osOf,
  programCause,
  rowsCostBy,
  settingsTabFor,
  setupOffer,
  type ManualContext,
} from "./programs";

const MB = 2 ** 20;

function program(id: ProgramInfo["id"], over: Partial<ProgramInfo> = {}): ProgramInfo {
  return {
    id,
    state: "missing",
    problem: id === "ffmpeg" ? "not_found" : "unreachable",
    source: id === "ffmpeg" ? "path" : "default",
    location: {
      ffmpeg: "ffmpeg",
      ollama: "http://127.0.0.1:11434/v1",
      comfyui: "http://127.0.0.1:8188",
    }[id],
    setting: {
      ffmpeg: "LOCALCUT_FFMPEG_BIN",
      ollama: "LOCALCUT_LLM_URL",
      comfyui: "LOCALCUT_COMFYUI_URL",
    }[id],
    version: null,
    checks: id === "ollama" ? { server: null, model: "qwen3:14b", model_present: null } : {},
    managed: null,
    setup:
      id === "ffmpeg"
        ? {
            available: true,
            unavailable_reason: null,
            takes_effect: true,
            version: "8.1.3",
            url: "https://example.test/ffmpeg.tar.xz",
            download_bytes: 130 * MB,
            install_bytes: 270 * MB,
            job: null,
            last: null,
          }
        : {
            available: false,
            unavailable_reason: "program_not_supported",
            takes_effect: false,
            version: null,
            url: null,
            download_bytes: null,
            install_bytes: null,
            job: null,
            last: null,
          },
    ...over,
  };
}

const gap = (over: Partial<ReadinessRow>): ReadinessRow => ({
  kind: "export",
  model: null,
  backend: null,
  verdict: "will_fail",
  reason: "no_ffmpeg",
  data: {},
  fix: null,
  ...over,
});

const ctx = (over: Partial<ManualContext> = {}): ManualContext => ({
  os: "linux",
  host: null,
  binDir: "/home/me/.localcut/bin",
  modelsDir: "/home/me/.localcut/models",
  gpuVendor: "nvidia",
  ...over,
});

describe("which program a readiness row blames", () => {
  it("names the program a setup fix sets up, and the one a server reason is about", () => {
    expect(
      programCause(gap({ fix: { type: "setup_program", program: "ffmpeg", size_bytes: 1 } })),
    ).toBe("ffmpeg");
    expect(programCause(gap({ reason: "comfyui_down", kind: "keyframe" }))).toBe("comfyui");
    expect(programCause(gap({ reason: "llm_server_down", kind: "script" }))).toBe("ollama");
    expect(programCause(gap({ reason: "ffmpeg_cannot_draw_text" }))).toBe("ffmpeg");
  });

  it("leaves model gaps to the models", () => {
    // A missing script model is fixed by picking one, which is what the
    // engine's own fix for it says.
    expect(programCause(gap({ reason: "llm_model_missing", kind: "script" }))).toBeNull();
    expect(programCause(gap({ reason: "no_model_installed", kind: "music" }))).toBeNull();
  });

  it("sends a gap list to Programs when any of it is a program", () => {
    const music = gap({ kind: "music", reason: "no_model_installed", verdict: "placeholder" });
    expect(settingsTabFor([music])).toBe("models");
    expect(settingsTabFor([music, gap({})])).toBe("programs");
  });
});

describe("what a well offers to do", () => {
  it("sets up a missing program, with the download's size", () => {
    expect(setupOffer(program("ffmpeg"))).toEqual({ kind: "setup", size: 130 * MB });
  });

  it("offers nothing where setting it up would change nothing", () => {
    // LOCALCUT_FFMPEG_BIN outranks LocalCut's copy: a download that is
    // never run is not a fix.
    const outranked = program("ffmpeg", {
      source: "configured",
      setup: { ...program("ffmpeg").setup, takes_effect: false },
    });
    expect(setupOffer(outranked)).toBeNull();
    expect(setupOffer(program("ollama"))).toBeNull();
  });

  it("offers LocalCut's copy in place of an FFmpeg that cannot draw text", () => {
    const blind = program("ffmpeg", {
      state: "ready",
      problem: null,
      checks: { draws_text: false },
    });
    expect(setupOffer(blind)?.kind).toBe("setup");
  });

  it("retries after a failure, and offers nothing while a setup runs", () => {
    const failed = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        last: { job: "j", outcome: "failed", reason: "download_failed", error: "x" },
      },
    });
    expect(setupOffer(failed)?.kind).toBe("retry");
    const running = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        job: { id: "j", phase: "downloading", done: 1, total: 2, bytes_per_s: null },
      },
    });
    expect(setupOffer(running)).toBeNull();
  });

  it("updates a copy that is no longer the pinned build", () => {
    const old = program("ffmpeg", {
      state: "ready",
      problem: null,
      source: "managed",
      checks: { draws_text: true },
      managed: { location: "/x", bytes: 1, version: "8.0.1", current: false, in_use: true },
    });
    expect(setupOffer(old)?.kind).toBe("update");
  });
});

describe("what a program costs the render", () => {
  const rows = [
    gap({ kind: "timeline" }),
    gap({ kind: "export" }),
    gap({ kind: "captions", verdict: "placeholder", data: { task: "transcribe" } }),
    gap({
      kind: "music",
      reason: "no_model_installed",
      verdict: "placeholder",
      data: { task: "music.gen" },
    }),
  ];

  it("lists the stages a missing FFmpeg takes down, the final video once", () => {
    const costs = rowsCostBy(program("ffmpeg"), rows);
    expect(costs.map((row) => row.kind)).toEqual(["export", "captions"]);
  });

  it("lists nothing for a program that works, whatever the models lack", () => {
    const ready = program("comfyui", { state: "ready", problem: null });
    const keyframe = gap({
      kind: "keyframe",
      reason: "no_model_installed",
      verdict: "placeholder",
    });
    expect(rowsCostBy(ready, [keyframe])).toEqual([]);
  });

  it("leaves out a stage this engine is not configured to make with the program", () => {
    // An all-mock chain makes stand-ins whatever is installed: setting up
    // FFmpeg there changes nothing about the final video.
    const mocked = gap({ verdict: "placeholder", reason: "backend_not_configured" });
    expect(rowsCostBy(program("ffmpeg"), [mocked])).toEqual([]);
  });

  it("blames a stopped ComfyUI for its stages even before any model is there", () => {
    // With no weights the engine names the model as the reason; with no
    // ComfyUI either, the program is the thing to fix first.
    const keyframe = gap({
      kind: "keyframe",
      reason: "no_model_installed",
      verdict: "placeholder",
      data: { task: "image.gen" },
    });
    expect(rowsCostBy(program("comfyui"), [keyframe])).toEqual([keyframe]);
  });
});

describe("the engine's system", () => {
  it("reads the OS off the platform key", () => {
    expect(osOf("windows-x64")).toBe("windows");
    expect(osOf("linux-arm64")).toBe("linux");
    expect(osOf("macos-arm64")).toBe("macos");
    expect(osOf(null)).toBeNull();
  });

  it("names <data_dir>/bin from an engine too old to report it", () => {
    const report = {
      programs_dir: "C:\\Users\\you\\.localcut\\programs",
    } as ProgramsReport;
    expect(binDirOf(report)).toBe("C:\\Users\\you\\.localcut\\bin");
    expect(binDirOf({ ...report, bin_dir: "D:\\lc\\bin" })).toBe("D:\\lc\\bin");
  });
});

describe("doing it by hand", () => {
  it("installs FFmpeg from the package manager on Linux", () => {
    const { steps } = manualSteps(program("ffmpeg"), ctx());
    expect(steps.map((step) => step.command).filter(Boolean)).toEqual(["sudo apt install ffmpeg"]);
    expect(steps.at(-1)?.check).toBe(true);
  });

  it("uses winget on Windows, and says where a copy of your own can go instead", () => {
    const { steps, notes } = manualSteps(
      program("ffmpeg"),
      ctx({ os: "windows", binDir: "C:\\Users\\you\\.localcut\\bin" }),
    );
    expect(steps[0]?.command).toBe("winget install Gyan.FFmpeg");
    // winget changes PATH, which the engine reads once at start.
    expect(steps[1]?.text).toMatch(/reopen LocalCut/);
    expect(notes[0]?.text).toContain("C:\\Users\\you\\.localcut\\bin");
  });

  it("says to restart the engine there when it runs on another machine", () => {
    const { steps } = manualSteps(program("ffmpeg"), ctx({ os: "windows", host: "gpu-box.local" }));
    expect(steps[1]?.text).toContain("gpu-box.local");
  });

  it("takes Homebrew's full build on macOS, and links it where the engine looks first", () => {
    // The plain formula has no libass, and ffmpeg-full is keg-only, so it
    // is on no PATH until something points at it.
    const { steps } = manualSteps(program("ffmpeg"), ctx({ os: "macos" }));
    expect(steps[0]?.command).toBe("brew install ffmpeg-full");
    expect(steps[1]?.command).toContain('"/home/me/.localcut/bin/"');
    expect(steps[1]?.command).toContain("ffprobe");
  });

  it("pulls the script model the engine names", () => {
    const { steps } = manualSteps(program("ollama"), ctx());
    expect(steps.map((step) => step.command)).toContain("ollama pull qwen3:14b");
    expect(steps[0]?.command).toBe("curl -fsSL https://ollama.com/install.sh | sh");
  });

  it("asks only for the model when Ollama runs without it", () => {
    const running = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "llama3.2", model_present: false },
    });
    const { steps } = manualSteps(running, ctx({ os: "windows" }));
    expect(steps.map((step) => step.command).filter(Boolean)).toEqual(["ollama pull llama3.2"]);
  });

  it("picks the portable ComfyUI for the engine's graphics card", () => {
    const { steps } = manualSteps(program("comfyui"), ctx({ os: "windows", gpuVendor: "amd" }));
    expect(steps[0]?.link?.href).toMatch(/ComfyUI_windows_portable_amd\.7z$/);
    expect(steps.at(-1)?.text).toContain("run_amd_gpu.bat");
  });

  it("points ComfyUI at LocalCut's models, in forward slashes", () => {
    const yaml = comfyModelPaths("C:\\Users\\you\\.localcut\\models");
    expect(yaml).toContain("base_path: C:/Users/you/.localcut/models");
    expect(yaml).toContain("  checkpoints: checkpoints");
    const { steps } = manualSteps(program("comfyui"), ctx());
    expect(steps.some((step) => step.block?.includes("/home/me/.localcut/models"))).toBe(true);
  });
});
