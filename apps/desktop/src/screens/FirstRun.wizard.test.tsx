/**
 * The onboarding wizard (U1). What is worth pinning is the state machine
 * and the money paths: every step must be leavable (Skip finishes setup,
 * Back never loses the selection), untick must change what downloads, the
 * library's fit filter must hide only what cannot load, and step 4 must
 * read live install state — installed / downloading·% / external — from
 * the same store rows the engine updates.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HardwareGPU, ModelEntry, ModelRow, SystemInfo } from "../api/types";
import { t } from "../i18n";
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
    client: {} as never,
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
const toStep3 = () => fireEvent.click(screen.getByRole("button", { name: t("common.continue") }));

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

  it("walks welcome → machine → models, and Back returns without losing ticks", () => {
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
    toStep3();
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
    expect(screen.getByText(t("firstRun.statusExternalOllama"))).toBeInTheDocument();
    expect(screen.getAllByText(t("firstRun.statusExternalNone")).length).toBe(2);
    expect(screen.getByText(t("firstRun.statusInstalled"))).toBeInTheDocument();
    expect(screen.getByText(t("firstRun.statusDownloading", { pct: 51 }))).toBeInTheDocument();
    // ace: pending but no progress yet — queued, not a lie.
    expect(screen.getByText(t("firstRun.statusQueued"))).toBeInTheDocument();
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
