/**
 * What U2 changed about Home: it stopped being the browser. One Continue
 * shelf of four, no tool-output shelf, no search box of its own ("/" routes
 * to the Library instead), a style preset on the create surface, and the
 * download bridge collapsed to a line that expands into the wizard's own
 * rows rather than pushing the page down while bytes move.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelRow, Project, SystemInfo } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Home } from "./Home";

const project = (id: string, mode: string, title: string, updated_at: number): Project => ({
  id,
  title,
  created_at: updated_at,
  updated_at,
  mode,
  approvals: [],
});

const VIDEOS = Array.from({ length: 6 }, (_, i) =>
  project(`v${i}`, "prompt", `Video ${i}`, 100 - i),
);
const TOOLS = [project("t1", "tool:image", "a lighthouse at dusk", 30)];

const GPU = { vendor: "NVIDIA", name: "RTX 3080", vram_gb: 8, backend: "cuda" };
const model = (id: string, task: string, over: Partial<ModelRow> = {}): ModelRow =>
  ({
    id,
    task,
    family: id,
    version: "",
    quant: "",
    requirements: { vram_gb: 8, ram_gb: 8, disk_gb: 20, backends: [] },
    quality_score: 1,
    speed_score: 1,
    license: { id: "apache-2.0", commercial: true, verdict: "commercial", notes: "" },
    files: [{ url: "u", dest: "d", sha256: "0", size: 2 ** 30 }],
    comfy_graph_template: "",
    custom: false,
    size_bytes: 2 ** 30,
    downloaded: false,
    downloading: false,
    progress: null,
    partial_bytes: 0,
    ...over,
  }) as ModelRow;

const SYSTEM = (models: ModelRow[]): SystemInfo => ({
  hardware: {
    os: "linux",
    arch: "x86_64",
    ram_gb: 32,
    disk_free_gb: 100,
    gpus: [GPU],
    primary_gpu: GPU,
    tier: "A",
  },
  recommendations: models.map((row) => ({ task: row.task, model: row, reason: "" })),
  backend_mode: "local",
});

const seed = (over: Record<string, unknown> = {}) =>
  useApp.setState({
    client: null,
    projects: [...VIDEOS, ...TOOLS],
    allJobs: [],
    models: [],
    system: null,
    templates: [],
    libraryOpen: false,
    settingsOpen: false,
    homeDraft: { prompt: "", tool: null, toolInput: "", voice: "", motion: "", scriptModel: "" },
    createFromPrompt: vi.fn(async () => {}),
    openProject: vi.fn(async () => {}),
    refreshHome: vi.fn(async () => {}),
    ...over,
  } as never);

const tileTitles = () =>
  Array.from(document.querySelectorAll(".project-tile .title")).map((node) => node.textContent);

beforeEach(() => {
  localStorage.clear();
  seed();
});

describe("the Continue shelf", () => {
  it("shows the four most recent things made, tool outputs included", () => {
    // A tool output is work you may want to get back to; leaving it out
    // meant a session you closed vanished from Home entirely.
    // Distinct stamps: the shelf's whole claim is the ORDER, so a tie would
    // pin the sort's stability rather than its comparator.
    seed({
      projects: [
        project("v0", "prompt", "Video 0", 100),
        project("v1", "prompt", "Video 1", 90),
        project("t9", "tool:music", "a warm loop", 95),
        project("v2", "prompt", "Video 2", 80),
      ],
    });
    render(<Home />);
    expect(tileTitles()).toEqual(["Video 0", "a warm loop", "Video 1", "Video 2"]);
  });

  it("caps at four, most recently touched first", () => {
    render(<Home />);
    expect(tileTitles()).toEqual(["Video 0", "Video 1", "Video 2", "Video 3"]);
  });

  it("hands the rest to the Library", async () => {
    render(<Home />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("home.openLibrary") }));
    });
    expect(useApp.getState().libraryOpen).toBe(true);
  });

  it("keeps the starter templates while no video exists — but shelves the tool output", () => {
    // The empty state answers "where will my videos go", so it is gated on
    // videos; the shelf answers "what did I just make", so it is not.
    seed({ projects: TOOLS });
    render(<Home />);
    expect(screen.getByText(t("home.emptyTitle"))).toBeInTheDocument();
    expect(tileTitles()).toEqual(["a lighthouse at dusk"]);
  });
});

describe("the keyboard", () => {
  it("routes / to the Library's search rather than a box Home no longer has", () => {
    render(<Home />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    const state = useApp.getState();
    expect(state.libraryOpen).toBe(true);
    expect(state.librarySearchFocus).toBe(1);
  });
});

describe("the style preset", () => {
  it("offers the curated list and sends the pick with the prompt", async () => {
    const createFromPrompt = vi.fn(async () => {});
    seed({ createFromPrompt });
    render(<Home />);
    fireEvent.change(screen.getByLabelText(t("home.promptAria")), {
      target: { value: "a bee" },
    });
    // The chip is a Dropdown: open it, pick a different look.
    fireEvent.click(screen.getByLabelText(t("home.styleAria")));
    fireEvent.click(screen.getByRole("option", { name: "Anime" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("common.generate")) }));
    });
    // The mode here is incidental to the style — it is whatever Home starts
    // on, which is "beginner" (store.homeDefaults.test.ts owns that choice).
    // Spelled out rather than loosened to any(String): the argument order is
    // worth catching, and two adjacent strings are exactly where it slips.
    expect(createFromPrompt).toHaveBeenCalledWith(
      "a bee",
      60,
      expect.any(String),
      "beginner",
      "anime",
    );
  });

  // The design draws a mark on every chip in the prompt row; aspect and
  // duration shipped with one and style did not, which reads as a rendering
  // fault rather than a choice. Asserted across all three, so the next chip
  // added to this row cannot quietly arrive bare either.
  it("gives every chip in the prompt row its mark", () => {
    seed();
    render(<Home />);
    const bare = [t("home.aspectAria"), t("home.durationAria"), t("home.styleAria")].filter(
      (label) => !screen.getByLabelText(label).querySelector("svg"),
    );
    expect(bare).toEqual([]);
  });
});

describe("the download bridge", () => {
  const downloading = [
    model("qwen", "text.llm", { files: [], size_bytes: 0 }),
    model("sdxl", "image.gen", { downloaded: true }),
    model("ltx", "video.i2v", {
      downloading: true,
      progress: { done: 2 ** 29, total: 2 ** 30 },
    }),
  ];

  it("stays one line until it is asked to open", () => {
    seed({ models: downloading, system: SYSTEM(downloading) });
    render(<Home />);
    expect(screen.getByText(t("home.dlSummary", { ready: 2, total: 3 }))).toBeInTheDocument();
    expect(document.querySelectorAll(".srow")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText(t("home.dlExpandAria")));
    // The wizard's rows, in the wizard's order.
    expect(document.querySelectorAll(".srow")).toHaveLength(3);
    expect(screen.getByText(t("firstRun.statusDownloading", { pct: 50 }))).toBeInTheDocument();
  });

  it("is absent entirely when nothing is downloading", () => {
    const settled = downloading.map((row) => ({ ...row, downloading: false }));
    seed({ models: settled, system: SYSTEM(settled) });
    render(<Home />);
    expect(screen.queryByText(t("home.dlSummary", { ready: 2, total: 3 }))).toBeNull();
  });
});
