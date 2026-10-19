/**
 * The "Before you render" gate on Home's Generate.
 *
 * The gate warns before work that would come out as a stand-in or fail. In
 * Review steps the engine runs the script and holds everything after it
 * until the script is approved, so a gap in the keyframes or the music is
 * not in the work Generate starts. Warning about it there asks the person to
 * decide about work that is not about to run; the approval that releases it
 * is where that question belongs (CheckpointBanner's own tests).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Home } from "./Home";

const gap = (kind: string, reason: string, task?: string): ReadinessRow => ({
  kind,
  model: null,
  backend: "mock",
  verdict: "placeholder",
  reason: reason as ReadinessRow["reason"],
  data: task ? { task } : {},
  fix: null,
});

/** ComfyUI still downloading: keyframes and music are its stand-ins. */
const COMFYUI_DOWN = [
  gap("keyframe", "comfyui_down", "image.gen"),
  gap("music", "comfyui_down", "music.gen"),
];
const LLM_DOWN = [gap("script", "llm_server_down", "text.llm")];

let createFromPrompt: ReturnType<typeof vi.fn>;

/** An engine whose readiness report is `rows`, narrowed to the kinds asked
 * for, as GET /readiness?kinds= narrows it. */
function seed(rows: ReadinessRow[], mode: "prompt" | "beginner") {
  createFromPrompt = vi.fn(async () => {});
  useApp.setState({
    client: {
      readiness: vi.fn(async (kinds?: string[]) => ({
        rows: rows.filter((row) => !kinds || kinds.includes(row.kind)),
      })),
    },
    projects: [],
    allJobs: [],
    models: [],
    system: null,
    templates: [],
    readiness: rows,
    warnMissingModels: true,
    libraryOpen: false,
    settingsOpen: false,
    createFromPrompt,
    openProject: vi.fn(async () => {}),
    refreshHome: vi.fn(async () => {}),
    refreshReadiness: vi.fn(async () => {}),
    homeDraft: {
      prompt: "",
      tool: null,
      toolInput: "",
      voice: "",
      motion: "",
      scriptModel: "",
      toolAspect: "16:9",
      toolDuration: 60,
      clipSeconds: 5,
      mode,
    },
  } as never);
}

async function generate() {
  fireEvent.change(screen.getByLabelText(t("home.promptAria")), {
    target: { value: "one raindrop's journey" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("common.generate")) }));
  });
}

const gate = () => screen.queryByRole("alertdialog", { name: t("readiness.dialog.title") });

beforeEach(() => {
  localStorage.clear();
});

describe("Generate in Review steps", () => {
  it("starts the script without a warning about stages held behind its approval", async () => {
    seed(COMFYUI_DOWN, "beginner");
    render(<Home />);
    await generate();
    expect(gate()).toBeNull();
    expect(createFromPrompt).toHaveBeenCalledTimes(1);
  });

  it("still warns when the script itself would be a stand-in", async () => {
    seed([...LLM_DOWN, ...COMFYUI_DOWN], "beginner");
    render(<Home />);
    await generate();
    const dialog = gate();
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveTextContent("Script writing");
    // Only what Generate is about to run is listed.
    expect(dialog).not.toHaveTextContent("Keyframes");
    expect(createFromPrompt).not.toHaveBeenCalled();
  });
});

describe("Generate in Auto", () => {
  it("warns about every stage the video will run straight through", async () => {
    seed(COMFYUI_DOWN, "prompt");
    render(<Home />);
    await generate();
    const dialog = gate();
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveTextContent("Keyframes");
    expect(dialog).toHaveTextContent("Music");
    expect(createFromPrompt).not.toHaveBeenCalled();
  });
});
