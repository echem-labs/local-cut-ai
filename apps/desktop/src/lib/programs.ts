/**
 * What GET /programs means to the screens that show it: Settings > Programs,
 * the first-run step, and the readiness gate and banner.
 *
 * Pure functions over the report, so each rule is tested without a screen:
 * which program a readiness row blames, what a well offers to do, and the
 * steps for doing it by hand on the engine's own system. That last one is
 * keyed off the report's `platform`, never this window's OS, because on a
 * paired GPU box the program goes on that box.
 */
import type {
  ProgramBuild,
  ProgramBuildChoice,
  ProgramId,
  ProgramInfo,
  ProgramJob,
  ProgramsReport,
  ReadinessRow,
  SetupFailure,
} from "../api/types";
import { m, t, type MessageKey } from "../i18n";
import { distinctGaps, noteworthyGaps } from "./readiness";

/** The programs this build has words for, in the engine's order. A program a
 * newer engine adds is left off the screen rather than shown nameless. */
export const PROGRAM_ORDER: readonly ProgramId[] = ["ffmpeg", "ollama", "comfyui"];

export const isKnownProgram = (id: string): id is ProgramId =>
  (PROGRAM_ORDER as readonly string[]).includes(id);

/** The program's name, from the catalog. */
export const programName = (id: ProgramId): string => t(`programs.names.${id}` as MessageKey);

/** The readiness reasons that blame a program rather than a model, a key or
 * a configuration. `llm_model_missing` is not one: the engine's own fix for
 * it is picking a model, which Settings > Models does. */
const PROGRAM_OF_REASON: Readonly<Record<string, ProgramId>> = {
  no_ffmpeg: "ffmpeg",
  ffmpeg_cannot_draw_text: "ffmpeg",
  llm_server_down: "ollama",
  comfyui_down: "comfyui",
};

/** The program a readiness row needs fixed, or null when its cause is not a
 * program. A `setup_program` fix names it outright, and so does a
 * `pull_model` one: the model goes into that program, from its well. */
export function programCause(row: ReadinessRow): ProgramId | null {
  if (row.fix?.type === "setup_program" || row.fix?.type === "pull_model") {
    return isKnownProgram(row.fix.program) ? row.fix.program : null;
  }
  return PROGRAM_OF_REASON[row.reason] ?? null;
}

/** Where a readiness surface sends someone to fix `rows`: Settings >
 * Programs when a program is any of the causes, Settings > Models when
 * none is. A model gap beside a program gap still goes to Programs, since
 * nothing a model download does helps while the program is missing, and
 * the gate lists the downloads itself. */
export function settingsTabFor(rows: readonly ReadinessRow[]): "programs" | "models" {
  return rows.some((row) => programCause(row) !== null) ? "programs" : "models";
}

/** The distinct programs `rows` offer to set up, with each one's download
 * size, in the engine's order. */
export function programFixes(
  rows: readonly ReadinessRow[],
): { program: ProgramId; size: number }[] {
  const sizes = new Map<ProgramId, number>();
  for (const row of rows) {
    if (row.fix?.type === "setup_program" && isKnownProgram(row.fix.program)) {
      sizes.set(row.fix.program, row.fix.size_bytes);
    }
  }
  return PROGRAM_ORDER.filter((id) => sizes.has(id)).map((id) => ({
    program: id,
    size: sizes.get(id)!,
  }));
}

/** The programs that are a cause in `rows` and that nothing in them offers
 * to set up or pull into: LocalCut has no setup for them on this machine,
 * so their fix is the steps for doing it by hand. In the engine's order. */
export function programStepFixes(rows: readonly ReadinessRow[]): ProgramId[] {
  const offered = new Set(
    rows.flatMap((row) =>
      row.fix?.type === "setup_program" || row.fix?.type === "pull_model" ? [row.fix.program] : [],
    ),
  );
  const causes = new Set(rows.map(programCause).filter((id): id is ProgramId => id !== null));
  return PROGRAM_ORDER.filter((id) => causes.has(id) && !offered.has(id));
}

/** The distinct models `rows` offer to pull, each with the program that
 * pulls it and the catalog's estimate of its size (null when it has none),
 * in the engine's order. */
export function pullFixes(
  rows: readonly ReadinessRow[],
): { program: ProgramId; model: string; size: number | null }[] {
  const seen = new Map<string, { program: ProgramId; model: string; size: number | null }>();
  for (const row of rows) {
    const fix = row.fix;
    if (fix?.type !== "pull_model" || !isKnownProgram(fix.program)) continue;
    seen.set(`${fix.program}\u0000${fix.model}`, {
      program: fix.program,
      model: fix.model,
      size: fix.size_bytes,
    });
  }
  return [...seen.values()].sort(
    (a, b) => PROGRAM_ORDER.indexOf(a.program) - PROGRAM_ORDER.indexOf(b.program),
  );
}

/** The program each task's model runs in, for the tasks whose model needs
 * one that LocalCut does not ship. The ComfyUI ones mirror the engine's
 * `COMFY_TASKS`, which `test_ui_contract.py` holds them to. */
export const PROGRAM_OF_TASK: Readonly<Record<string, ProgramId>> = {
  "text.llm": "ollama",
  "image.gen": "comfyui",
  "video.i2v": "comfyui",
  "video.t2v": "comfyui",
  "music.gen": "comfyui",
};

/** The program a task's model needs and that cannot run it yet: not there,
 * no copy of LocalCut's and no setup of it running or waiting its turn.
 * Null when the task needs none. Null too before the report says, when the
 * first-run step ticks everything. */
export function programNotSetUp(
  task: string,
  report: ProgramsReport | null,
  queue: readonly ProgramId[],
): ProgramId | null {
  const id = PROGRAM_OF_TASK[task];
  const row = id ? report?.programs.find((program) => program.id === id) : undefined;
  if (!id || !row) return null;
  const coming = Boolean(row.setup.job) || queue.includes(id);
  return row.state === "ready" || Boolean(row.managed) || coming ? null : id;
}

/** The node kinds each program makes, for the stage rows under its well.
 * The thumbnail is left out: it belongs to the publish kit, not to a video
 * render, and the strip and the gate leave it out for the same reason. */
const PROGRAM_KINDS: Readonly<Record<ProgramId, readonly string[]>> = {
  ffmpeg: ["timeline", "export"],
  ollama: ["script"],
  comfyui: ["keyframe", "clip", "music"],
};

/** Whether a program needs anything done about it: not there, not working,
 * an FFmpeg that cannot draw text, or an LLM server without the model
 * scripts are written with. */
export function needsAttention(program: ProgramInfo): boolean {
  return (
    program.state !== "ready" ||
    program.checks.draws_text === false ||
    program.checks.model_present === false
  );
}

/** What a program costs the render while it needs attention: the readiness
 * rows it is the cause of, and the rows of the stages it makes. Nothing
 * when it is fine, because the gaps of a working program are about models. */
export function rowsCostBy(
  program: ProgramInfo,
  rows: readonly ReadinessRow[] | null,
): ReadinessRow[] {
  if (!needsAttention(program)) return [];
  const gaps = noteworthyGaps(rows);
  const own = gaps.filter(
    (row) =>
      programCause(row) === program.id ||
      // A chain with nothing that would run the program (an all-mock one)
      // makes that stage the same way with or without it.
      (program.state !== "ready" &&
        PROGRAM_KINDS[program.id].includes(row.kind) &&
        row.reason !== "backend_not_configured") ||
      (program.id === "ollama" &&
        program.checks.model_present === false &&
        row.reason === "llm_model_missing"),
  );
  return distinctGaps(own);
}

/** What the well's button would do, or null for no button. A setup's size
 * is everything it downloads: the program, and for Ollama the model it
 * pulls into LocalCut's copy. A pull's is the catalog's estimate. */
export type SetupOffer =
  | { kind: "setup"; size: number | null }
  | { kind: "retry"; size: number | null }
  | { kind: "update"; size: number | null }
  | { kind: "pull"; model: string; size: number | null }
  | { kind: "start" };

/** What a setup of the program downloads, all told, or null when it is not
 * known. */
export function setupSize(program: ProgramInfo): number | null {
  const download = program.setup.download_bytes;
  if (download === null) return null;
  return download + (program.setup.pull?.bytes ?? 0);
}

export function setupOffer(program: ProgramInfo): SetupOffer | null {
  const { setup, checks } = program;
  if (setup.job) return null;
  // An Ollama that runs, the user's own or LocalCut's, and lacks the model:
  // pulling it is the whole fix, whoever set the server up.
  if (
    program.state === "ready" &&
    checks.server === "ollama" &&
    checks.model_present === false &&
    checks.model
  ) {
    return { kind: "pull", model: checks.model, size: setup.pull?.bytes ?? null };
  }
  // LocalCut's copy is there and nothing answers: it stopped, gave up, or
  // stood aside for a server of the user's own that has since gone. Starting
  // it is the fix; it is already the build a setup fetches.
  const server = program.managed?.server;
  if (
    server &&
    program.state !== "ready" &&
    setup.takes_effect &&
    (server.state === "crashed" || server.state === "stopped")
  ) {
    return { kind: "start" };
  }
  if (!setup.available || !setup.takes_effect) return null;
  const size = setupSize(program);
  if (setup.last?.outcome === "failed" && needsAttention(program)) return { kind: "retry", size };
  if (program.state !== "ready") return { kind: "setup", size };
  // A working FFmpeg of the user's own that cannot draw text: LocalCut's
  // copy can, and outranks a PATH install, which is why the readiness
  // report offers it as the fix.
  if (program.checks.draws_text === false && program.source !== "managed") {
    return { kind: "setup", size };
  }
  if (program.managed?.in_use && !program.managed.current) return { kind: "update", size };
  return null;
}

/** The other build to offer after one whose PyTorch could not use the card:
 * the vendor's build for older drivers, then the processor's where one is
 * pinned (Linux), whichever is not the build that just failed. Never the
 * usual build, which a machine that was given another one has a driver too
 * old for. Null when there is nothing else to try. */
export function otherBuildOffer(
  program: ProgramInfo,
): (ProgramBuildChoice & { build: ProgramBuild }) | null {
  const { setup } = program;
  const last = setup.last;
  if (setup.job || last?.outcome !== "failed" || last.reason !== "gpu_not_usable") return null;
  if (!needsAttention(program) || !setup.available || !setup.takes_effect) return null;
  const other = (setup.builds ?? []).find(
    (choice) => choice.build !== null && choice.build !== (last.build ?? null),
  );
  return other && other.build !== null ? { ...other, build: other.build } : null;
}

/** The failure to show, while it still matters: the last setup failed and
 * the program still needs attention. A failure the user has since fixed by
 * hand is history, not news. */
export function shownFailure(program: ProgramInfo): SetupFailure | null {
  const last = program.setup.last;
  if (program.setup.job || last?.outcome !== "failed" || !needsAttention(program)) return null;
  return last.reason ?? "install_failed";
}

/** The phases whose progress is bytes moving and so have a speed: a
 * download, a pull, whose total grows as Ollama finds its layers and an
 * unpack, which for ComfyUI is tens of thousands of files and takes minutes
 * of its own. */
const TRANSFERS: readonly string[] = ["downloading", "unpacking", "pulling"];

/** How far a running setup has got, 0..1. Checking, installing and starting
 * report 0 of 0 and come after every byte is in, so they read as full. */
export function setupFraction(job: ProgramJob): number {
  if (job.total <= 0) return TRANSFERS.includes(job.phase) ? 0 : 1;
  return Math.min(1, Math.max(0, job.done / job.total));
}

/** The engine's operating system, from its platform key. */
export type EngineOs = "windows" | "linux" | "macos";

export function osOf(platform: string | null): EngineOs | null {
  const os = platform?.split("-")[0];
  return os === "windows" || os === "linux" || os === "macos" ? os : null;
}

/** <data_dir>/bin on the engine's machine. An engine older than the field
 * names only the programs folder, which sits beside it. */
export function binDirOf(report: ProgramsReport): string {
  if (report.bin_dir) return report.bin_dir;
  const dir = report.programs_dir;
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const cut = dir.lastIndexOf(separator);
  return `${cut > 0 ? dir.slice(0, cut) : dir}${separator}bin`;
}

/** Whether a location is a server's address rather than a path. */
const isAddress = (location: string): boolean => /^https?:\/\//.test(location);

/** A server's address without the scheme and the API path, as a person
 * would type it: "127.0.0.1:11434" for "http://127.0.0.1:11434/v1". */
export function addressOf(location: string): string {
  try {
    const url = new URL(location);
    return url.host || location;
  } catch {
    return location;
  }
}

/** The engine's host name from its base URL, for "On gpu-box.local". */
export function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}

/* ---- doing it by hand ---- */

/** A sentence, and the parts of it to set in mono: paths, file names,
 * variables, commands. */
export interface ManualText {
  text: string;
  code?: string[];
}

/** One numbered step. `command` gets a copy button, `block` is a file to
 * save (copyable too), `link` opens a page in the browser, and `check`
 * puts a Check again button under it. */
export interface ManualStep extends ManualText {
  command?: string;
  block?: string;
  link?: { href: string; label: string };
  check?: boolean;
}

export interface ManualSteps {
  steps: ManualStep[];
  /** Lines under the steps: the other way to do it, or where to point
   * LocalCut at a program somewhere else. */
  notes: ManualText[];
}

/** What the steps need to know beyond the program itself. */
export interface ManualContext {
  os: EngineOs | null;
  /** The paired engine's host name, or null for this computer. */
  host: string | null;
  binDir: string;
  modelsDir: string | null;
  /** The engine machine's main GPU vendor, lowercase as /system reports it. */
  gpuVendor: string | null;
}

const LINKS = {
  ffmpeg: "https://ffmpeg.org/download.html",
  ollama: "https://ollama.com/download",
  comfyuiReadme: "https://github.com/Comfy-Org/ComfyUI#manual-install-windows-linux",
  comfyuiMac: "https://github.com/Comfy-Org/ComfyUI#apple-mac-silicon",
  comfyuiPortable: (build: string) =>
    "https://github.com/Comfy-Org/ComfyUI/releases/latest/download/" +
    `ComfyUI_windows_portable_${build}.7z`,
};

/** Each program's site, for its menu. */
export const PROGRAM_SITES: Readonly<Record<ProgramId, string>> = {
  ffmpeg: "https://ffmpeg.org",
  ollama: "https://ollama.com",
  comfyui: "https://github.com/Comfy-Org/ComfyUI",
};

/** ComfyUI's model folders that LocalCut's manifest downloads into. */
const COMFY_MODEL_FOLDERS = [
  "checkpoints",
  "diffusion_models",
  "text_encoders",
  "vae",
  "clip",
  "loras",
];

/** The extra_model_paths.yaml that points ComfyUI at LocalCut's models. */
export function comfyModelPaths(modelsDir: string): string {
  // Forward slashes: ComfyUI reads them on Windows too, and a backslash in a
  // YAML scalar is the one character that can turn into an escape.
  const base = modelsDir.replace(/\\/g, "/");
  const folders = COMFY_MODEL_FOLDERS.map((name) => `  ${name}: ${name}`);
  return ["localcut:", `  base_path: ${base}`, ...folders].join("\n");
}

/** The portable ComfyUI build and the script that starts it, per GPU
 * vendor. The NVIDIA build is also the one that runs on the CPU. */
function comfyPortable(vendor: string | null): {
  build: string;
  start: string;
  vendor: string | null;
} {
  const known = vendor?.toLowerCase();
  if (known === "amd") return { build: "amd", start: "run_amd_gpu.bat", vendor: "amd" };
  if (known === "intel") return { build: "intel", start: "run_intel_gpu.bat", vendor: "intel" };
  if (known === "nvidia") return { build: "nvidia", start: "run_nvidia_gpu.bat", vendor: "nvidia" };
  return { build: "nvidia", start: "run_cpu.bat", vendor: null };
}

const check = (
  key: MessageKey,
  params?: Record<string, string>,
  code?: string[],
): ManualStep => ({
  text: t(key, params),
  check: true,
  ...(code ? { code } : {}),
});

function ffmpegSteps(ctx: ManualContext): ManualSteps {
  const done = check("programs.diy.ffmpeg.check");
  if (ctx.os === "windows") {
    return {
      steps: [
        { text: t("programs.diy.ffmpeg.winget"), command: "winget install Gyan.FFmpeg" },
        {
          text: ctx.host
            ? t("programs.diy.ffmpeg.restartOn", { host: ctx.host })
            : t("programs.diy.ffmpeg.restart"),
        },
        done,
      ],
      notes: [
        {
          text: t("programs.diy.ffmpeg.bin", { bin: ctx.binDir }),
          code: ["ffmpeg.exe", "ffprobe.exe", ctx.binDir],
        },
      ],
    };
  }
  if (ctx.os === "linux") {
    return {
      steps: [{ text: t("programs.diy.ffmpeg.apt"), command: "sudo apt install ffmpeg" }, done],
      notes: [],
    };
  }
  if (ctx.os === "macos") {
    // Homebrew's plain formula has no libass, and ffmpeg-full is keg-only:
    // installed, and on no PATH. A link in <data_dir>/bin is what the engine
    // looks at first, and it takes ffprobe from beside it.
    const prefix = '"$(brew --prefix ffmpeg-full)/bin';
    return {
      steps: [
        { text: t("programs.diy.ffmpeg.brew"), command: "brew install ffmpeg-full" },
        {
          text: t("programs.diy.ffmpeg.link"),
          command:
            `mkdir -p "${ctx.binDir}" && ` +
            `ln -sf ${prefix}/ffmpeg" ${prefix}/ffprobe" "${ctx.binDir}/"`,
        },
        done,
      ],
      notes: [],
    };
  }
  return {
    steps: [
      {
        text: t("programs.diy.ffmpeg.site"),
        link: { href: LINKS.ffmpeg, label: t("programs.diy.ffmpeg.siteLink") },
      },
      done,
    ],
    notes: [],
  };
}

function ollamaSteps(program: ProgramInfo, ctx: ManualContext): ManualSteps {
  const model = program.checks.model ?? "";
  const done = check("programs.diy.ollama.check");
  const notes = [
    {
      text: t("programs.diy.ollama.address", { setting: program.setting }),
      code: [program.setting],
    },
  ];
  // Running, and only the model is missing: the one step that is left.
  if (program.state === "ready") {
    if (program.checks.server === "other") {
      return { steps: [check("programs.diy.ollama.pullOther", { model }, [model])], notes };
    }
    return {
      steps: [{ text: t("programs.diy.ollama.pull"), command: `ollama pull ${model}` }, done],
      notes,
    };
  }
  const install: ManualStep =
    ctx.os === "linux"
      ? {
          text: t("programs.diy.ollama.script"),
          command: "curl -fsSL https://ollama.com/install.sh | sh",
        }
      : {
          text: t("programs.diy.ollama.download"),
          link: { href: LINKS.ollama, label: t("programs.diy.ollama.downloadLink") },
        };
  const steps = [install];
  if (model) steps.push({ text: t("programs.diy.ollama.pull"), command: `ollama pull ${model}` });
  steps.push(done);
  return { steps, notes };
}

function comfyuiSteps(program: ProgramInfo, ctx: ManualContext): ManualSteps {
  const models: ManualStep = ctx.modelsDir
    ? {
        text: t("programs.diy.comfyui.models"),
        code: ["extra_model_paths.yaml"],
        block: comfyModelPaths(ctx.modelsDir),
      }
    : { text: t("programs.diy.comfyui.modelsUnknown"), code: ["extra_model_paths.yaml"] };
  const notes = [
    {
      text: t("programs.diy.comfyui.address", { setting: program.setting }),
      code: [program.setting],
    },
  ];
  if (ctx.os === "windows") {
    const portable = comfyPortable(ctx.gpuVendor);
    const vendors = m().programs.diy.vendors as Record<string, string>;
    return {
      steps: [
        {
          text: t("programs.diy.comfyui.portable", {
            vendor: vendors[portable.vendor ?? "nvidia"] ?? vendors.nvidia,
          }),
          link: {
            href: LINKS.comfyuiPortable(portable.build),
            label: `ComfyUI_windows_portable_${portable.build}.7z`,
          },
        },
        models,
        check("programs.diy.comfyui.start", { command: portable.start }, [portable.start]),
      ],
      notes,
    };
  }
  return {
    steps: [
      {
        text: t("programs.diy.comfyui.manual"),
        link: {
          href: ctx.os === "macos" ? LINKS.comfyuiMac : LINKS.comfyuiReadme,
          label: t("programs.diy.comfyui.readmeLink"),
        },
      },
      models,
      check("programs.diy.comfyui.start", { command: "python main.py" }, ["python main.py"]),
    ],
    notes,
  };
}

/** The steps for setting `program` up by hand on the engine's system. */
export function manualSteps(program: ProgramInfo, ctx: ManualContext): ManualSteps {
  if (program.id === "ffmpeg") return ffmpegSteps(ctx);
  if (program.id === "ollama") return ollamaSteps(program, ctx);
  return comfyuiSteps(program, ctx);
}

/* ---- what a well says ---- */

/** Which build a setup would fetch, in a sentence, for a program pinned per
 * GPU vendor: "LocalCut picks the build for NVIDIA graphics cards.", or that
 * it picks the processor's for a machine with no card it has a build for.
 * Null for a program with one build for every card, or a vendor this build
 * has no name for. */
export function buildPicked(program: ProgramInfo): string | null {
  if (program.setup.build === "cpu") return t("programs.build.picksCpu");
  const vendor = program.setup.gpu;
  if (!vendor) return null;
  const vendors = m().programs.diy.vendors as Record<string, string>;
  const named = vendors[vendor];
  if (!named) return null;
  return program.setup.build === "older_drivers"
    ? t("programs.build.picksOlder", { vendor: named })
    : t("programs.build.picks", { vendor: named });
}

/** The sentences under a program's name, for every state but a running
 * setup and a failed one, which the well words itself (a phase and a bar;
 * the failure and what to do about it). */
export function statusOf(
  program: ProgramInfo,
  ctx: { host: string | null; offer: SetupOffer | null },
): ManualText[] {
  const name = programName(program.id);
  const where = ctx.host ?? t("programs.here");
  const address = addressOf(program.location);
  const lines: ManualText[] = [];
  if (program.state === "ready") {
    if (program.checks.server === "other") {
      lines.push({ text: t("programs.checks.otherServer", { address }), code: [address] });
    } else if (program.source === "configured") {
      lines.push({
        text: t("programs.sources.configured", {
          setting: program.setting,
          location: program.location,
        }),
        code: [program.setting, program.location],
      });
    } else if (program.source === "data_dir") {
      lines.push({
        text: t("programs.sources.data_dir", { location: program.location }),
        code: [program.location],
      });
    } else if (program.source === "default") {
      lines.push({ text: t("programs.sources.default", { name, address }), code: [address] });
    } else {
      lines.push({ text: t(`programs.sources.${program.source}`) });
    }
    if (program.source === "managed" && program.managed?.build === "cpu") {
      // LocalCut's copy is the processor's build: it works, slowly.
      lines.push({ text: t("programs.build.onCpu") });
    }
    if (program.checks.draws_text === true) lines.push({ text: t("programs.checks.drawsText") });
    if (program.checks.draws_text === false) {
      lines.push({ text: t("programs.checks.noText") });
      if (ctx.offer?.kind === "setup") lines.push({ text: t("programs.checks.noTextFix") });
    }
    if (program.checks.model_present === false && program.checks.model) {
      const model = program.checks.model;
      lines.push({ text: t("programs.checks.modelMissing", { model }), code: [model] });
    }
  } else {
    const problem =
      program.problem === "unreachable" && program.source === "default"
        ? "not_found"
        : (program.problem ?? "not_found");
    const location = program.location;
    const server = program.managed?.server;
    if (server?.state === "starting") {
      // LocalCut's own copy is on its way up: that is the news, not that
      // nothing answers yet.
      lines.push({ text: t("programs.server.starting", { name }) });
    } else if (server?.reason) {
      // Stood aside for the user's own server, which is not answering now:
      // what matters is that LocalCut's copy is stopped.
      const reason = server.reason === "own_server" ? "stopped" : server.reason;
      lines.push({
        text: t(`programs.serverReasons.${reason}`, { name, address }),
        code: [address],
      });
    } else {
      lines.push({
        text: t(`programs.problems.${problem}`, { where, name, location, address }),
        code: problem === "does_not_run" ? [location] : problem === "not_found" ? [] : [address],
      });
    }
    if (program.setup.available && !program.setup.takes_effect && isAddress(location)) {
      // A server LocalCut's copy cannot be: one on another machine.
      lines.push({
        text: t("programs.checks.wouldNotBeUsedRemote", { setting: program.setting }),
        code: [program.setting],
      });
    } else if (program.setup.available && !program.setup.takes_effect) {
      lines.push(
        program.source === "configured"
          ? {
              text: t("programs.checks.wouldNotBeUsedConfigured", { setting: program.setting }),
              code: [program.setting],
            }
          : {
              text: t("programs.checks.wouldNotBeUsedDataDir", { location }),
              code: [location],
            },
      );
    } else if (!program.setup.available && program.setup.unavailable_reason) {
      lines.push({ text: t(`programs.unavailable.${program.setup.unavailable_reason}`, { name }) });
    }
    const picked = buildPicked(program);
    if (picked && ctx.offer?.kind === "setup") lines.push({ text: picked });
  }
  const managed = program.managed;
  if (managed?.server && program.state === "ready" && program.source !== "managed") {
    // A server of the user's own answers where LocalCut's copy would.
    lines.push({ text: t("programs.checks.notUsedServer") });
  } else if (
    managed &&
    !managed.in_use &&
    program.state === "ready" &&
    program.source !== "managed"
  ) {
    lines.push(
      program.source === "configured"
        ? {
            text: t("programs.checks.notUsedConfigured", { setting: program.setting }),
            code: [program.setting],
          }
        : {
            text: t("programs.checks.notUsedDataDir", { location: program.location }),
            code: [program.location],
          },
    );
  }
  if (ctx.offer?.kind === "update" && managed?.version && program.setup.version) {
    lines.push({
      text: t("programs.checks.outdated", {
        version: managed.version,
        pinned: program.setup.version,
      }),
      code: [managed.version, program.setup.version],
    });
  }
  return lines;
}
