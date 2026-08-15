/**
 * What "Auto" says it will do.
 *
 * "Auto" alone reads as "not selected", which is the one thing it must not
 * be mistaken for — a picker that says nothing is indistinguishable from a
 * task nobody has configured. So the option names what it resolves to, and
 * the three cases below are the ones a report of what-renders-today cannot
 * answer:
 *
 *  - a task that already HAS a stored default, where the resolution the
 *    engine performs today is that default, while Auto is what happens once
 *    it is discarded;
 *  - `vision.llm`, which no render queues a job for, so no readiness row is
 *    ever produced for it;
 *  - a fallback that names a model the local server does not serve — the
 *    shipped `qwen3:14b` on a machine that pulled something else.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { useApp } from "../store";

const MODELS = [
  {
    id: "sdxl-base-1.0",
    task: "image.gen",
    family: "sdxl",
    version: "base 1.0",
    quant: "",
    files: ["s.safetensors"],
    size_bytes: 6_000_000_000,
    partial_bytes: 0,
    downloaded: true,
    downloading: false,
    requirements: { vram_gb: 6 },
    license: { id: "openrail", verdict: "ok", notes: "" },
  },
];

async function mount(over: Record<string, unknown> = {}) {
  useApp.setState({
    settingsOpen: true,
    settingsTab: "models",
    client: {
      baseUrl: "http://127.0.0.1:7830",
      listProviders: async () => [],
      llmModels: async () => ({ models: ["llama3.2:latest"] }),
    },
    models: MODELS,
    downloadErrors: {},
    refreshModelDefaults: vi.fn(async () => {}),
    setModelDefault: vi.fn(async () => null),
    refreshModels: vi.fn(async () => {}),
    refreshComfy: vi.fn(async () => null),
    ...over,
  } as never);
  return act(async () => render(<Settings />));
}

/** One task's picker, opened — its menu exists only while it is. */
async function options(stage: string) {
  await userEvent.click(screen.getByRole("button", { name: stage }));
  return screen.getAllByRole("option").map((node) => node.textContent?.trim() ?? "");
}

/** What a row reads as with its menu shut, which for a task with no stored
 *  pick is the Auto label itself. */
const shown = () => document.body.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
});

describe("the Auto option", () => {
  it("names the fallback on a task that already has a pick", async () => {
    // The pick renders today; Auto is what renders once it is gone. A label
    // built from the resolution-of-today can only answer with the pick
    // itself — advertising the very value selecting Auto discards.
    await mount({
      modelDefaults: {
        tasks: ["text.llm"],
        defaults: { "text.llm": "llama3.2:latest" },
        auto: { "text.llm": "llama3.2:latest" },
      },
    });
    expect(shown()).toContain("llama3.2:latest");
    expect(await options("Script writing")).toContain("Auto — llama3.2:latest");
  });

  it("says a fallback the local server does not serve is missing", async () => {
    // The engine ships `qwen3:14b` and this machine pulled llama3.2. Said
    // here, it is one glance; unsaid, it is one failed render.
    await mount({
      modelDefaults: {
        tasks: ["text.llm"],
        defaults: {},
        auto: { "text.llm": "qwen3:14b" },
      },
    });
    expect(shown()).toContain("Auto — qwen3:14b (not on the server)");
  });

  it("tells reading images apart from a stage with nothing to run", async () => {
    // Two different nothings, and the wrong one sends people to re-download
    // what they already have. `vision.llm` wants a CHOICE — every model it
    // could use is on the server already, and the engine will not guess
    // which of them can see. image.gen here has weights that ComfyUI cannot
    // run (no workflow template), so its answer really is a download.
    await mount({
      modelDefaults: {
        tasks: ["vision.llm", "image.gen"],
        defaults: {},
        auto: { "vision.llm": null, "image.gen": null },
      },
    });
    expect(shown()).toContain("Auto — nothing set");
    expect(shown()).toContain("Auto — nothing installed yet");
  });

  it("stays plain against an engine that does not report a fallback", async () => {
    // An older engine sends no `auto` map at all. "Auto" says less than it
    // could; "Auto — nothing installed yet" would say something false.
    await mount({
      modelDefaults: { tasks: ["image.gen"], defaults: {} },
    });
    expect(shown()).toContain("Auto");
    expect(shown()).not.toContain("nothing installed");
  });
});
