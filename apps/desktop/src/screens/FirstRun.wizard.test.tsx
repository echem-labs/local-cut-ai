/**
 * The onboarding wizard (U1). What is worth pinning is the state machine
 * and the money paths: every step must be leavable (Skip finishes setup,
 * Back never loses the selection), untick must change what downloads, the
 * library's fit filter must hide only what cannot load, and step 4 must
 * read live install state — installed / downloading·% / external — from
 * the same store rows the engine updates.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HardwareGPU,
  ModelEntry,
  ModelRow,
  ProgramInfo,
  ProgramsReport,
  SystemInfo,
} from "../api/types";
import { plural, t } from "../i18n";
import { useApp } from "../store";
import { FirstRun } from "./FirstRun";

const GPU: HardwareGPU = {
  vendor: "NVIDIA",
  name: "NVIDIA GeForce RTX 3080 Laptop GPU",
  vram_gb: 8,
  backend: "cuda",
};

const GB = 2 ** 30;

function entry(
  id: string,
  task: string,
  options: { external?: boolean; vram?: number; family?: string; version?: string } = {},
): ModelEntry {
  return {
    id,
    task,
    family: options.family ?? id.split("-")[0]!,
    version: options.version ?? "",
    quant: "",
    requirements: { vram_gb: options.vram ?? 8, ram_gb: 8, disk_gb: 20, backends: [] },
    quality_score: 1,
    speed_score: 1,
    license: { id: "apache-2.0", commercial: true, verdict: "commercial", notes: "" },
    files: options.external
      ? []
      : [{ url: "https://example.test/w", dest: "w", sha256: "0", size: 1 * GB }],
    comfy_graph_template: "",
    custom: false,
  } as ModelEntry;
}

function row(
  base: ModelEntry,
  state: Partial<Pick<ModelRow, "size_bytes" | "downloaded" | "downloading" | "progress">> = {},
): ModelRow {
  return {
    ...base,
    size_bytes: state.size_bytes ?? (base.files.length > 0 ? 1 * GB : 0),
    downloaded: state.downloaded ?? false,
    downloading: state.downloading ?? false,
    progress: state.progress ?? null,
    partial_bytes: 0,
  } as ModelRow;
}

const QWEN = entry("qwen3-8b-q4", "text.llm", { external: true, vram: 6, family: "qwen 3", version: "8B" });
const SDXL = entry("sdxl-base-1.0", "image.gen", { family: "sdxl", version: "1.0" });
const LTX = entry("ltx-video-0.9-i2v", "video.i2v", { family: "ltx", version: "0.9" });
const CHATTERBOX = entry("chatterbox-tts", "speech.tts", { external: true, vram: 6 });
const ACE = entry("ace-step-v1-3.5b", "music.gen", { family: "ace-step", version: "3.5B" });
const WHISPER = entry("faster-whisper-large-v3", "transcribe", { external: true, vram: 4 });
const WAN = entry("wan2.2-i2v-14b-fp8", "video.i2v", { vram: 16, family: "wan", version: "2.2" });
const QWEN14 = entry("qwen3-14b-q4", "text.llm", { external: true, vram: 10, family: "qwen 3", version: "14B" });

const SYSTEM: SystemInfo = {
  hardware: {
    os: "linux",
    arch: "x86_64",
    ram_gb: 61.7,
    disk_free_gb: 87.6,
    gpus: [GPU],
    primary_gpu: GPU,
    tier: "A",
  },
  recommendations: [
    { task: "text.llm", model: QWEN, reason: "fits" },
    { task: "image.gen", model: SDXL, reason: "fits" },
    { task: "video.i2v", model: LTX, reason: "fits" },
    { task: "speech.tts", model: CHATTERBOX, reason: "fits" },
    { task: "music.gen", model: ACE, reason: "fits" },
    { task: "transcribe", model: WHISPER, reason: "fits" },
  ],
  backend_mode: "local,mock",
};

let startDownload: ReturnType<typeof vi.fn>;
let finishFirstRun: ReturnType<typeof vi.fn>;

function seedStore(models: ModelRow[], overrides: Record<string, unknown> = {}) {
  startDownload = vi.fn(async () => {});
  finishFirstRun = vi.fn();
  useApp.setState({
    // Only what the programs step asks of a client: whether it can clone.
    client: {
      voices: vi.fn(async () => ({ available: true, voices: [], default: null, cloning: false })),
    },
    system: SYSTEM,
    models,
    downloadErrors: {},
    firstRunReturning: false,
    refreshModels: vi.fn(async () => {}),
    startDownload,
    cancelDownload: vi.fn(async () => {}),
    deleteModel: vi.fn(async () => {}),
    deleteCustomModel: vi.fn(async () => {}),
    finishFirstRun,
    programs: null,
    programsError: null,
    programQueue: [],
    readiness: null,
    remoteEngine: false,
    refreshPrograms: vi.fn(async () => {}),
    refreshReadiness: vi.fn(async () => {}),
    setupPrograms: vi.fn(async () => null),
    ...overrides,
  } as never);
}

/** The default catalog: sdxl installed; ltx and ace still to download. */
const CATALOG = () => [
  row(QWEN),
  row(SDXL, { downloaded: true, size_bytes: 6.5 * GB }),
  row(LTX, { size_bytes: 11 * GB }),
  row(CHATTERBOX),
  row(ACE, { size_bytes: 7.2 * GB }),
  row(WHISPER),
  row(WAN, { size_bytes: 33 * GB }),
  row(QWEN14),
];

const toStep2 = () => fireEvent.click(screen.getByRole("button", { name: t("firstRun.getStarted") }));
const next = () => fireEvent.click(screen.getByRole("button", { name: t("common.continue") }));
/** From the machine step, through the programs step, to the models. */
const toStep3 = () => {
  next();
  next();
};

beforeEach(() => {
  localStorage.clear();
});

describe("the wizard's steps", () => {
  it("opens on the welcome step with the promise and two ways forward", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    expect(screen.getByText(t("firstRun.welcomeTitle"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("firstRun.skip") })).toBeInTheDocument();
    // Skip is the LAST action — the e2e rig's positional contract.
    const actions = document.querySelectorAll(".setup-actions button");
    expect(actions[actions.length - 1]!.textContent).toBe(t("firstRun.skip"));
  });

  it("walks welcome, machine, programs, models, and Back returns without losing ticks", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    expect(screen.getByText(t("firstRun.hardwareEyebrow"))).toBeInTheDocument();
    expect(screen.getByText(t("firstRun.verdictAllLead"))).toBeInTheDocument();
    toStep3();
    // 6 stages = 6 rail checkboxes, all pre-picked.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(6);
    // Untick narration, go back, return: still unticked.
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Narration" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: t("common.back") }));
    expect(screen.getByText(t("programs.wizard.title"))).toBeInTheDocument();
    next();
    expect(
      screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Narration" }) }),
    ).not.toBeChecked();
  });

  it("shows the machine's chips from the system probe", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    expect(
      screen.getByText(t("firstRun.gpuChip", { gpu: GPU.name, vram: 8 })),
    ).toBeInTheDocument();
    expect(screen.getByText(t("firstRun.ramChip", { ram: 61.7 }))).toBeInTheDocument();
    expect(screen.getByText(t("firstRun.diskChip", { disk: 87.6 }))).toBeInTheDocument();
  });

  it("prices the primary button from what is actually pending", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    toStep3();
    // Pending = ltx (11 GB) + ace (7.2 GB); sdxl is installed, rest external.
    expect(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "18 GB" }) }),
    ).toBeInTheDocument();
    // Unticking video drops its 11 GB from the price.
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Video clips" }) }),
    );
    expect(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "7.2 GB" }) }),
    ).toBeInTheDocument();
  });
});

describe("skip and reopen", () => {
  it("finishes setup from the welcome step", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.skip") }));
    expect(finishFirstRun).toHaveBeenCalled();
  });

  it("finishes setup from the machine step", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.skip") }));
    expect(finishFirstRun).toHaveBeenCalled();
  });

  it("reopened from Settings, starts at the machine step with no way back to welcome", () => {
    seedStore(CATALOG(), { firstRunReturning: true });
    render(<FirstRun />);
    expect(screen.getByText(t("firstRun.hardwareEyebrow"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("common.back") })).toBeDisabled();
  });
});

describe("the full library", () => {
  const openLibrary = () => {
    toStep2();
    toStep3();
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.openLibrary") }));
  };

  it("hides won't-fit rows behind the fit filter, and greys them when shown", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    openLibrary();
    // Default filter: wan (needs 16 GB on an 8 GB card) is hidden.
    expect(screen.queryByText("wan2.2-i2v-14b-fp8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.fitFilterAll") }));
    // Now visible, greyed, unpickable, with the reason on the badge.
    expect(screen.getByText("wan2.2-i2v-14b-fp8")).toBeInTheDocument();
    expect(document.querySelector(".model-row.dis")).not.toBeNull();
    expect(screen.getByText(t("models.wontFit", { vram: 16 }))).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: t("models.selectAria", { id: "wan2.2-i2v-14b-fp8" }) }),
    ).toBeDisabled();
  });

  it("names the runtime an external row uses, in the rail's words", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    openLibrary();
    // The rail one click away already names the runtime; the library said
    // "external" — the same word as the badge beside it, which is the one
    // thing the meta does not need to repeat.
    expect(
      screen.getByText((_, node) => node?.textContent === "qwen3-8b-q4 · runs in Ollama · needs 6 GB VRAM", {
        selector: ".model-row .meta",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, node) => node?.textContent === "chatterbox-tts · runs outside the engine · needs 6 GB VRAM",
        { selector: ".model-row .meta" },
      ),
    ).toBeInTheDocument();
  });

  it("keeps the class the fit filter's width rule hangs on", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    openLibrary();
    // jsdom has no layout: the rig measures that the control wraps its
    // labels (e2e-walkthrough). This only keeps the hook alive for it.
    expect(document.querySelector(".seg-toggle.filter-tabs")).not.toBeNull();
  });

  it("marks a tight fit without disabling it, and outlines the recommended pick", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    openLibrary();
    // qwen3-14b needs 10 GB on an 8 GB card — loadable with offload.
    expect(screen.getByText(t("models.tightFit"))).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: t("models.selectAria", { id: "qwen3-14b-q4" }) }),
    ).not.toBeDisabled();
    expect(document.querySelectorAll(".model-row.rec-row").length).toBe(6);
    expect(screen.getAllByText(t("models.recommended")).length).toBe(6);
  });

  it("returns to the rail without losing an extra pick", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    openLibrary();
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.fitFilterAll") }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("models.selectAria", { id: "qwen3-14b-q4" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.backToRecommended") }));
    // The rail is back; the extra external pick adds nothing to the price.
    expect(screen.getByText(t("firstRun.modelsTitle"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "18 GB" }) }),
    ).toBeInTheDocument();
  });
});

describe("download & continue → ready", () => {
  it("starts only the pending downloads and lands on the summary", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    toStep3();
    fireEvent.click(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "18 GB" }) }),
    );
    expect(startDownload.mock.calls.map((call) => call[0]).sort()).toEqual([
      "ace-step-v1-3.5b",
      "ltx-video-0.9-i2v",
    ]);
    expect(screen.getByText(t("firstRun.readyTitle"))).toBeInTheDocument();
  });

  it("reads each stage's live status from the store", () => {
    const models = CATALOG().map((r) =>
      r.id === "ltx-video-0.9-i2v"
        ? {
            ...r,
            downloading: true,
            progress: { done: 0.51 * 11 * GB, total: 11 * GB },
          }
        : r,
    );
    seedStore(models);
    render(<FirstRun />);
    toStep2();
    toStep3();
    fireEvent.click(screen.getByRole("button", { name: /Download & continue/ }));
    const rows = within(document.querySelector(".sumrail") as HTMLElement);
    expect(rows.getByText(t("firstRun.statusExternalOllama"))).toBeInTheDocument();
    expect(rows.getAllByText(t("firstRun.statusExternalNone")).length).toBe(2);
    expect(rows.getByText(t("firstRun.statusInstalled"))).toBeInTheDocument();
    expect(rows.getByText(t("firstRun.statusDownloading", { pct: 51 }))).toBeInTheDocument();
    // ace: pending but no progress yet — queued, not a lie.
    expect(rows.getByText(t("firstRun.statusQueued"))).toBeInTheDocument();
  });

  it("says a stage the user unticked was not downloaded, rather than queued", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    toStep3();
    fireEvent.click(
      screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Music" }) }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "11 GB" }) }),
    );
    expect(startDownload.mock.calls.map((call) => call[0])).toEqual(["ltx-video-0.9-i2v"]);
    const statusOf = (stage: string) =>
      screen.getByText(stage).closest(".srow")!.querySelector(".st")!.textContent;
    // Nothing will ever download ace: the engine was never asked to.
    expect(statusOf("Music")).toBe(t("firstRun.statusNotDownloaded"));
    // ltx was asked for and has no bytes counted yet. That one is queued.
    expect(statusOf("Video clips")).toBe(t("firstRun.statusQueued"));
    expect(screen.getByText(plural("firstRun.readySkipped", 1))).toBeInTheDocument();
  });

  it("says nothing about skipped stages when every stage was kept", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    toStep3();
    fireEvent.click(screen.getByRole("button", { name: /Download & continue/ }));
    expect(screen.queryByText(t("firstRun.statusNotDownloaded"))).toBeNull();
    expect(screen.queryByText(plural("firstRun.readySkipped", 1))).toBeNull();
  });

  it("finishes setup from Start creating", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toStep2();
    toStep3();
    fireEvent.click(screen.getByRole("button", { name: /Download & continue/ }));
    fireEvent.click(screen.getByRole("button", { name: t("firstRun.startCreating") }));
    expect(finishFirstRun).toHaveBeenCalled();
  });
});

/* ---- the programs step ---- */

const MB = 2 ** 20;

function program(
  id: "ffmpeg" | "ollama" | "comfyui",
  over: Partial<ProgramInfo> = {},
): ProgramInfo {
  const settable = id === "ffmpeg";
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
    setting: "LOCALCUT_X",
    version: null,
    checks: id === "ollama" ? { server: null, model: "qwen3:14b", model_present: null } : {},
    managed: null,
    setup: {
      available: settable,
      unavailable_reason: settable ? null : "program_not_supported",
      takes_effect: settable,
      version: settable ? "8.1.3" : null,
      url: null,
      download_bytes: settable ? 131 * MB : null,
      install_bytes: settable ? 271 * MB : null,
      job: null,
      last: null,
    },
    ...over,
  };
}

/** A second program the engine can set up, for the "all" button. */
const settableToo = (id: "ollama" | "comfyui", size: number): ProgramInfo =>
  program(id, {
    setup: {
      ...program("ffmpeg").setup,
      download_bytes: size,
    },
  });

const report = (rows: ProgramInfo[]): ProgramsReport => ({
  platform: "linux-x64",
  programs_dir: "/home/me/.localcut/programs",
  programs_bytes: 0,
  disk_free_bytes: 20_000 * MB,
  bin_dir: "/home/me/.localcut/bin",
  models_dir: "/home/me/.localcut/models",
  programs: rows,
});

const FRESH = () => report([program("ffmpeg"), program("ollama"), program("comfyui")]);

const toPrograms = () => {
  toStep2();
  next();
};

describe("the programs step", () => {
  it("sits between the machine and the models", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    expect(document.querySelectorAll(".stepper .step-label")).toHaveLength(5);
    toPrograms();
    expect(screen.getByText(t("programs.wizard.title"))).toBeInTheDocument();
    expect(document.querySelectorAll(".pstrip .light")).toHaveLength(7);
  });

  it("offers the one program the engine can set up as the step's own button", () => {
    const setupPrograms = vi.fn(async () => null);
    seedStore(CATALOG(), { programs: FRESH(), setupPrograms });
    render(<FirstRun />);
    toPrograms();
    const actions = [...document.querySelectorAll(".setup-actions button")];
    expect(actions[0]).toHaveTextContent("Set up FFmpeg 131 MB");
    fireEvent.click(actions[0]!);
    expect(setupPrograms).toHaveBeenCalledWith(["ffmpeg"]);
  });

  it("says plainly that the rest are done by hand", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toPrograms();
    expect(screen.getByText(t("programs.wizard.subSome"))).toBeInTheDocument();
  });

  it("sets up every program it can with one button, totalled", () => {
    const setupPrograms = vi.fn(async () => null);
    seedStore(CATALOG(), {
      setupPrograms,
      programs: report([
        program("ffmpeg"),
        settableToo("ollama", 1.4 * 1024 * MB),
        settableToo("comfyui", 1.9 * 1024 * MB),
      ]),
    });
    render(<FirstRun />);
    toPrograms();
    const primary = document.querySelector(".setup-actions .btn-primary")!;
    expect(primary).toHaveTextContent(t("programs.wizard.setupAll"));
    expect(primary).toHaveTextContent("3.4 GB");
    expect(screen.getByText(t("programs.wizard.sub"))).toBeInTheDocument();
    fireEvent.click(primary);
    expect(setupPrograms).toHaveBeenCalledWith(["ffmpeg", "ollama", "comfyui"]);
  });

  it("calls two of them both", () => {
    seedStore(CATALOG(), {
      programs: report([program("ffmpeg"), settableToo("ollama", 1024 * MB), program("comfyui")]),
    });
    render(<FirstRun />);
    toPrograms();
    expect(document.querySelector(".setup-actions .btn-primary")).toHaveTextContent(
      t("programs.wizard.setupBoth"),
    );
  });

  it("counts an Ollama that runs without the script model as one to set up", () => {
    // Its fix is a pull, which the same button starts after FFmpeg's setup.
    const setupPrograms = vi.fn(async () => null);
    const theirs = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "qwen3:14b", model_present: false },
    });
    seedStore(CATALOG(), {
      setupPrograms,
      programs: report([program("ffmpeg"), theirs, program("comfyui")]),
    });
    render(<FirstRun />);
    toPrograms();
    const primary = document.querySelector(".setup-actions .btn-primary")!;
    expect(primary).toHaveTextContent(t("programs.wizard.setupBoth"));
    fireEvent.click(primary);
    expect(setupPrograms).toHaveBeenCalledWith(["ffmpeg", "ollama"]);
  });

  it("names the model when getting it is all that is left", () => {
    const ready = program("ffmpeg", {
      state: "ready",
      problem: null,
      source: "managed",
      checks: { draws_text: true },
    });
    const theirs = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "qwen3:14b", model_present: false },
    });
    seedStore(CATALOG(), { programs: report([ready, theirs, program("comfyui")]) });
    render(<FirstRun />);
    toPrograms();
    expect(document.querySelector(".setup-actions .btn-primary")).toHaveTextContent(
      "Get qwen3:14b",
    );
  });

  it("can be skipped, which goes on to the models", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toPrograms();
    fireEvent.click(screen.getByRole("button", { name: t("programs.wizard.skip") }));
    expect(screen.getByText(t("firstRun.modelsTitle"))).toBeInTheDocument();
  });

  it("lets you go on while a setup runs, and says it keeps going", () => {
    const running = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        job: { id: "j", phase: "downloading", done: 40 * MB, total: 131 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), { programs: report([running, program("ollama"), program("comfyui")]) });
    render(<FirstRun />);
    toPrograms();
    expect(screen.queryByRole("button", { name: t("programs.wizard.skip") })).toBeNull();
    expect(screen.getByText(t("programs.wizard.hintRunning"))).toBeInTheDocument();
    next();
    expect(screen.getByText(t("firstRun.modelsTitle"))).toBeInTheDocument();
  });

  it("says how long the whole setup has left, not only the download on screen", () => {
    // FFmpeg's last 91 MB and then all of Ollama, at the 2 MB/s FFmpeg is
    // downloading at: 91 + 1024 MB is about 9 minutes.
    const running = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        job: {
          id: "j",
          phase: "downloading",
          done: 40 * MB,
          total: 131 * MB,
          bytes_per_s: 2 * MB,
        },
      },
    });
    seedStore(CATALOG(), {
      programs: report([running, settableToo("ollama", 1024 * MB), program("comfyui")]),
      programQueue: ["ollama"],
      setupSpeeds: {},
      networkSpeed: null,
    });
    render(<FirstRun />);
    toPrograms();
    expect(
      screen.getByText(t("programs.wizard.leftBoth", { time: "about 9 min" })),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t("programs.queuedFor", { name: "FFmpeg", time: "about 9 min" })),
    ).toBeInTheDocument();
  });

  it("names the one setup left when the others are done", () => {
    const pulling = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "qwen3:14b", model_present: false },
      setup: {
        ...settableToo("ollama", 1024 * MB).setup,
        pull: { model: "qwen3:14b", bytes: 9 * 1024 * MB },
        job: {
          id: "p",
          phase: "pulling",
          done: 1024 * MB,
          total: 9 * 1024 * MB,
          bytes_per_s: 4 * MB,
        },
      },
    });
    seedStore(CATALOG(), {
      programs: report([program("ffmpeg"), pulling, program("comfyui")]),
      setupSpeeds: {},
      networkSpeed: null,
    });
    render(<FirstRun />);
    toPrograms();
    expect(
      screen.getByText(t("programs.wizard.leftOne", { name: "Ollama", time: "about 35 min" })),
    ).toBeInTheDocument();
  });

  it("shows a program waiting its turn behind the running one", () => {
    const running = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        job: { id: "j", phase: "downloading", done: 1, total: 131 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), {
      programs: report([running, settableToo("ollama", 1024 * MB), program("comfyui")]),
      programQueue: ["ollama"],
    });
    render(<FirstRun />);
    toPrograms();
    expect(screen.getByText(t("programs.queued", { name: "FFmpeg" }))).toBeInTheDocument();
  });
});

describe("the models step's script row", () => {
  // The script model is the one stage whose download LocalCut does not run
  // from this step: Ollama fetches it, during Ollama's setup or through a
  // pull. The row says which and how much, rather than that there is
  // nothing to download.
  const toModels = () => {
    toStep2();
    next();
    const skip = screen.queryByRole("button", { name: t("programs.wizard.skip") });
    fireEvent.click(skip ?? screen.getByRole("button", { name: t("common.continue") }));
  };
  const scriptMeta = () =>
    screen.getByText(/^Script writing/).closest(".pipe-row")!.querySelector(".meta")!;
  const PULL = { model: "qwen3:8b", bytes: 5 * GB };

  it("counts it in Ollama's setup when LocalCut is to set Ollama up", () => {
    const ollama = program("ollama", {
      checks: { server: null, model: "qwen3:8b", model_present: null },
      setup: { ...settableToo("ollama", 1370 * MB).setup, pull: PULL },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toModels();
    expect(scriptMeta()).toHaveTextContent(t("firstRun.railScriptSetup", { size: "5.0 GB" }));
    expect(screen.queryByText(/nothing to download/)).toBeNull();
  });

  it("says it is a download into an Ollama of the user's own that lacks it", () => {
    const ollama = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "qwen3:8b", model_present: false },
      setup: { ...program("ollama").setup, pull: PULL },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toModels();
    expect(scriptMeta()).toHaveTextContent(t("firstRun.railScriptPull", { size: "5.0 GB" }));
  });

  it("says there is nothing to download once the user's Ollama has it", () => {
    const ollama = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "qwen3:8b", model_present: true },
      setup: { ...program("ollama").setup, pull: PULL },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toModels();
    expect(scriptMeta()).toHaveTextContent(t("firstRun.railScriptPresent"));
  });

  it("names a download Ollama makes once it runs, where LocalCut cannot set it up", () => {
    // macOS, or an address on another machine: someone else starts Ollama.
    // The model still has to come down into it.
    seedStore(CATALOG(), {
      programs: report([
        program("ffmpeg"),
        program("ollama", { setup: { ...program("ollama").setup, pull: PULL } }),
        program("comfyui"),
      ]),
    });
    render(<FirstRun />);
    toModels();
    expect(scriptMeta()).toHaveTextContent(t("firstRun.railScriptLater", { size: "5.0 GB" }));
  });
});

/**
 * Weights for a program that is not set up. On a machine with no
 * ComfyUI, its stages' weights are 25 GB that nothing there can run. They
 * start unticked, say why and stay choosable for someone who will set
 * ComfyUI up.
 */
describe("the models step, with the programs as they are", () => {
  const ltx = () =>
    screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Video clips" }) });
  const music = () =>
    screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Music" }) });
  const toModels = () => {
    toPrograms();
    fireEvent.click(screen.getByRole("button", { name: t("programs.wizard.skip") }));
  };

  it("leaves ComfyUI's weights unticked while ComfyUI is not set up and says why", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toModels();
    expect(ltx()).not.toBeChecked();
    expect(music()).not.toBeChecked();
    // Installed weights stay ticked: there is nothing to download.
    expect(
      screen.getByRole("checkbox", { name: t("firstRun.railToggleAria", { stage: "Keyframes" }) }),
    ).toBeChecked();
    expect(
      screen.getByText(t("firstRun.railNeedsProgram", { size: "11 GB", program: "ComfyUI" })),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t("firstRun.railHeldBack", { program: "ComfyUI" })),
    ).toBeInTheDocument();
    // Nothing that cannot run is priced into the button.
    expect(screen.getByRole("button", { name: t("common.continue") })).toBeInTheDocument();
  });

  it("leaves the script model alone, which this step never downloads", () => {
    // FRESH has no Ollama either. Ollama fetches the script model itself,
    // so its row keeps its tick and no line says it was held back.
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toModels();
    expect(
      screen.getByRole("checkbox", {
        name: t("firstRun.railToggleAria", { stage: "Script writing" }),
      }),
    ).toBeChecked();
    expect(screen.queryByText(t("firstRun.railHeldBack", { program: "Ollama" }))).toBeNull();
  });

  it("keeps them choosable for someone who will set ComfyUI up", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toModels();
    fireEvent.click(ltx());
    expect(ltx()).toBeChecked();
    expect(
      screen.getByRole("button", { name: t("firstRun.downloadContinue", { size: "11 GB" }) }),
    ).toBeInTheDocument();
  });

  it("ticks them once ComfyUI runs", () => {
    const comfy = program("comfyui", { state: "ready", problem: null });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), program("ollama"), comfy]) });
    render(<FirstRun />);
    toModels();
    expect(ltx()).toBeChecked();
    expect(music()).toBeChecked();
    expect(screen.queryByText(t("firstRun.railHeldBack", { program: "ComfyUI" }))).toBeNull();
  });

  it("ticks them while ComfyUI is being set up, or waits its turn to be", () => {
    const settingUp = program("comfyui", {
      setup: {
        ...settableToo("comfyui", 1.9 * 1024 * MB).setup,
        job: { id: "j", phase: "downloading", done: 1, total: 2 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), {
      programs: report([program("ffmpeg"), program("ollama"), settingUp]),
    });
    const { unmount } = render(<FirstRun />);
    toPrograms();
    next();
    expect(ltx()).toBeChecked();
    unmount();

    seedStore(CATALOG(), {
      programs: report([program("ffmpeg"), program("ollama"), settableToo("comfyui", MB)]),
      programQueue: ["comfyui"],
    });
    render(<FirstRun />);
    toPrograms();
    next();
    expect(ltx()).toBeChecked();
  });

  it("follows ComfyUI being set up after the step was first seen", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toModels();
    expect(ltx()).not.toBeChecked();
    act(() =>
      useApp.setState({
        programs: report([
          program("ffmpeg"),
          program("ollama"),
          program("comfyui", { state: "ready", problem: null }),
        ]),
      }),
    );
    expect(ltx()).toBeChecked();
  });
});

describe("the ready step", () => {
  const toReady = () => {
    toStep2();
    next();
    // Past the programs step whichever way it offers: on, or skip.
    const skip = screen.queryByRole("button", { name: t("programs.wizard.skip") });
    fireEvent.click(skip ?? screen.getByRole("button", { name: t("common.continue") }));
    // Continue, when nothing ticked is left to download: with ComfyUI not
    // set up its weights start unticked.
    fireEvent.click(
      screen.queryByRole("button", { name: /Download & continue/ }) ??
        screen.getByRole("button", { name: t("common.continue") }),
    );
  };

  it("says what runs each model", () => {
    seedStore(CATALOG());
    render(<FirstRun />);
    toReady();
    const rows = within(document.querySelector(".sumrail") as HTMLElement);
    expect(rows.getAllByText(t("firstRun.runners.comfyui")).length).toBeGreaterThan(0);
    expect(rows.getAllByText(t("firstRun.runners.builtIn")).length).toBeGreaterThan(0);
    expect(rows.getByText(t("firstRun.runners.ollama"))).toBeInTheDocument();
  });

  it("ends with the final video, made by FFmpeg", () => {
    const managed = program("ffmpeg", {
      state: "ready",
      problem: null,
      source: "managed",
      version: "8.1.3",
      checks: { draws_text: true },
    });
    seedStore(CATALOG(), { programs: report([managed, program("ollama"), program("comfyui")]) });
    render(<FirstRun />);
    toReady();
    const last = [...document.querySelectorAll(".sumrail .srow")].at(-1)!;
    expect(last).toHaveTextContent("Final video");
    expect(last).toHaveTextContent("FFmpeg 8.1.3");
    expect(last).toHaveTextContent(t("firstRun.runners.setUpByLocalCut"));
    expect(last).toHaveTextContent(t("firstRun.statusInstalled"));
  });

  it("says the final video has no FFmpeg when the step was skipped", () => {
    seedStore(CATALOG(), { programs: FRESH() });
    render(<FirstRun />);
    toReady();
    const last = [...document.querySelectorAll(".sumrail .srow")].at(-1)!;
    expect(last).toHaveTextContent(t("firstRun.statusNotFound"));
  });

  it("names the script model the engine will ask its server for", () => {
    const ollama = program("ollama", {
      state: "ready",
      problem: null,
      checks: { server: "ollama", model: "llama3.2", model_present: false },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toReady();
    const first = document.querySelector(".sumrail .srow")!;
    expect(first).toHaveTextContent("llama3.2");
    expect(first).toHaveTextContent(t("firstRun.statusNotPulled"));
  });

  it("shows Ollama setting up while LocalCut downloads it", () => {
    const ollama = program("ollama", {
      setup: {
        ...program("ollama").setup,
        job: { id: "j", phase: "downloading", done: 411 * MB, total: 1370 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toReady();
    const first = document.querySelector(".sumrail .srow")!;
    expect(first).toHaveTextContent(t("firstRun.statusSettingUp", { pct: 30 }));
    expect(first).not.toHaveTextContent(t("firstRun.statusNeedsOllama"));
  });

  it("shows Ollama setting up while it pulls the script model", () => {
    // The copy answers by now and lacks the model: without the job, that
    // reads as a model nobody is fetching.
    const ollama = program("ollama", {
      state: "ready",
      problem: null,
      source: "managed",
      checks: { server: "ollama", model: "qwen3:8b", model_present: false },
      setup: {
        ...program("ollama").setup,
        job: { id: "j", phase: "pulling", done: 2490 * MB, total: 4983 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), { programs: report([program("ffmpeg"), ollama, program("comfyui")]) });
    render(<FirstRun />);
    toReady();
    const first = document.querySelector(".sumrail .srow")!;
    expect(first).toHaveTextContent("qwen3:8b");
    expect(first).toHaveTextContent(t("firstRun.statusSettingUp", { pct: 50 }));
    expect(first).not.toHaveTextContent(t("firstRun.statusNotPulled"));
  });

  it("shows Ollama waiting while its setup is queued behind FFmpeg's", () => {
    // Set up both runs the smaller download first. Until FFmpeg's is done,
    // nothing is happening to the script yet and nothing is wrong with it.
    const ffmpeg = program("ffmpeg", {
      setup: {
        ...program("ffmpeg").setup,
        job: { id: "j", phase: "downloading", done: 40 * MB, total: 131 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), {
      programs: report([ffmpeg, settableToo("ollama", 1370 * MB), program("comfyui")]),
      programQueue: ["ollama"],
    });
    render(<FirstRun />);
    toReady();
    const rows = [...document.querySelectorAll(".sumrail .srow")];
    const script = rows[0];
    expect(script).toHaveTextContent(t("firstRun.statusWaiting"));
    expect(script).not.toHaveTextContent(t("firstRun.statusNeedsOllama"));
    expect(script.querySelector(".pdot")).toHaveClass("wait");
    expect(rows.at(-1)).toHaveTextContent(t("firstRun.statusSettingUp", { pct: 31 }));
  });

  describe("a stage ComfyUI runs, with its weights already in", () => {
    // CATALOG has SDXL on disk. The weights draw nothing until ComfyUI runs.
    const keyframes = () => screen.getByText("Keyframes").closest(".srow")!;
    const comfyuiJob = {
      id: "c",
      phase: "downloading" as const,
      done: 960 * MB,
      total: 3840 * MB,
      bytes_per_s: null,
    };

    it("is setting up while ComfyUI is", () => {
      const comfyui = program("comfyui", {
        setup: { ...settableToo("comfyui", 3840 * MB).setup, job: comfyuiJob },
      });
      seedStore(CATALOG(), { programs: report([program("ffmpeg"), program("ollama"), comfyui]) });
      render(<FirstRun />);
      toReady();
      expect(keyframes()).toHaveTextContent(t("firstRun.statusSettingUp", { pct: 25 }));
      expect(keyframes()).not.toHaveTextContent(t("firstRun.statusInstalled"));
    });

    it("waits while ComfyUI's setup is queued behind another", () => {
      seedStore(CATALOG(), {
        programs: report([program("ffmpeg"), program("ollama"), settableToo("comfyui", 3840 * MB)]),
        programQueue: ["comfyui"],
      });
      render(<FirstRun />);
      toReady();
      expect(keyframes()).toHaveTextContent(t("firstRun.statusWaiting"));
    });

    it("needs ComfyUI when nothing is setting it up", () => {
      seedStore(CATALOG(), { programs: FRESH() });
      render(<FirstRun />);
      toReady();
      expect(keyframes()).toHaveTextContent(t("firstRun.statusNeedsComfyUI"));
      expect(keyframes().querySelector(".pdot")).toHaveClass("ph");
    });

    it("is ready once ComfyUI runs", () => {
      const comfyui = program("comfyui", { state: "ready", problem: null });
      seedStore(CATALOG(), { programs: report([program("ffmpeg"), program("ollama"), comfyui]) });
      render(<FirstRun />);
      toReady();
      expect(keyframes()).toHaveTextContent(t("firstRun.statusInstalled"));
    });
  });

  it("shows the final video waiting while FFmpeg's setup is queued", () => {
    const ollama = program("ollama", {
      setup: {
        ...program("ollama").setup,
        job: { id: "j", phase: "downloading", done: 411 * MB, total: 1370 * MB, bytes_per_s: null },
      },
    });
    seedStore(CATALOG(), {
      programs: report([program("ffmpeg"), ollama, program("comfyui")]),
      programQueue: ["ffmpeg"],
    });
    render(<FirstRun />);
    toReady();
    const last = [...document.querySelectorAll(".sumrail .srow")].at(-1)!;
    expect(last).toHaveTextContent(t("firstRun.statusWaiting"));
    expect(last).not.toHaveTextContent(t("firstRun.statusNotFound"));
  });
});
