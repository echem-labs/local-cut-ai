/**
 * Every action in Settings explains itself, in the app's own bubble.
 *
 * The dialog is a wall of one-word verbs — "Save", "Clear", "Disconnect",
 * "Reset" — and a verb names what a control does without saying what it will
 * do to your machine. "Clear" beside a provider key and "Clear cache" under
 * Storage read the same and mean nothing alike. Home already answers this
 * for its prompt row; this file holds Settings to the same answer.
 *
 * Asked of the DIALOG, not of a list of labels. A hardcoded list says
 * nothing about the next button added to a pane, which is exactly the one
 * this is here to catch — the same reason Home's chip test enumerates the
 * row rather than three known chips.
 *
 * One exclusion: the nav tablist. A tab carries its own visible label and
 * SELECTS rather than acts; a bubble on every one of eight would fire on the
 * way to any of them.
 *
 * `ModelLibrary` and `WorkflowsPane` were excluded too, on the grounds that
 * Settings renders them without owning them. That reasoning holds for where
 * their TESTS live and not at all for whether their buttons explain
 * themselves — a user meeting a bare "Enable" beside third-party Python is
 * not helped by which component wrote it. Worse, both exclusions were dead:
 * neither class is in the DOM, so `closest()` matched nothing and the two
 * panes were only ever skipped because no tab in the list rendered them.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { t } from "../i18n";
import { useApp } from "../store";

const STORAGE = {
  projects: [{ id: "t1", title: "a lighthouse at dusk", bytes: 1_000_000 }],
  models_bytes: 0,
  cache_bytes: 4_000_000,
  disk_free_bytes: 1_000_000_000,
  disk_total_bytes: 2_000_000_000,
};

const PROJECTS = [
  { id: "t1", title: "a lighthouse at dusk", created_at: 0, mode: "tool:image", approvals: [] },
];

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", capabilities: ["text.llm"], configured: true },
];

/** Enough of a client for the panes that ask one for their rows. */
const client = {
  baseUrl: "http://127.0.0.1:7830",
  listProviders: async () => PROVIDERS,
  llmModels: async () => ({ models: ["llama3"] }),
};

/** Every pane the dialog can show. */
const OWN_TABS = [
  "general",
  "defaults",
  "providers",
  "storage",
  "engine",
  "about",
  "models",
  "workflows",
] as const;

/** A model in each state that draws a different set of buttons: installed
 *  (delete), part-downloaded (resume + discard), external (no action at all),
 *  and a custom entry (remove from the register). */
const MODELS = [
  {
    id: "wan/2.2-i2v-q5",
    task: "video.i2v",
    family: "wan",
    version: "2.2",
    quant: "Q5",
    files: ["a.safetensors"],
    size_bytes: 6_000_000_000,
    partial_bytes: 0,
    downloaded: true,
    downloading: false,
    requirements: { vram_gb: 12 },
    license: { id: "apache-2.0", verdict: "commercial", notes: "" },
  },
  {
    id: "ltx/0.9-t2v",
    task: "video.t2v",
    family: "ltx",
    version: "0.9",
    quant: "",
    files: ["b.safetensors"],
    size_bytes: 4_000_000_000,
    partial_bytes: 1_000_000_000,
    downloaded: false,
    downloading: false,
    requirements: { vram_gb: 8 },
    license: { id: "custom", verdict: "conditions", notes: "non-commercial without a grant" },
  },
  {
    id: "ollama/llama3",
    task: "text.llm",
    family: "llama",
    version: "3",
    quant: "",
    files: [],
    size_bytes: 0,
    partial_bytes: 0,
    downloaded: false,
    downloading: false,
    requirements: { vram_gb: 6 },
    license: { id: "llama3", verdict: "personal-only", notes: "personal use only" },
  },
  {
    id: "mine/custom-1",
    task: "image.gen",
    family: "custom",
    version: "",
    quant: "",
    files: ["c.safetensors"],
    size_bytes: 2_000_000_000,
    partial_bytes: 0,
    downloaded: false,
    downloading: false,
    custom: true,
    requirements: { vram_gb: 4 },
    license: { id: "unknown", verdict: "conditions", notes: "you vouched for this one" },
  },
];

/** One granted pack and one not, so both the enable and the disable button
 *  are on the pane at once. */
const NODE_PACKS = {
  warning: "Node packs run third-party Python inside ComfyUI.",
  packs: [
    {
      id: "comfyui-manager",
      name: "ComfyUI Manager",
      repo: "https://github.com/x/comfyui-manager",
      summary: "installs other packs",
      nodes: ["A", "B"],
      enabled: false,
      version: null,
    },
    {
      id: "videohelper",
      name: "Video Helper Suite",
      repo: "https://github.com/x/videohelper",
      summary: "",
      nodes: ["C"],
      enabled: true,
      version: "1.2.0",
    },
  ],
};

const WORKFLOWS = [
  { name: "my-upscale", nodes: 12, placeholders: ["prompt"], readable: true },
  { name: "broken-one", nodes: 0, placeholders: [], readable: false },
];

/** The default-model pickers. Without this `ModelDefaultsPanel` returns null
 *  and the pane renders without its own controls — which is how its dropdown
 *  went untipped under a guard that was already asserting this tab. */
const MODEL_DEFAULTS = {
  tasks: ["image.gen", "video.i2v"],
  defaults: { "image.gen": null, "video.i2v": "wan/2.2-i2v-q5" },
};

async function mount(tab: string, over: Record<string, unknown> = {}) {
  useApp.setState({
    settingsOpen: true,
    settingsTab: tab,
    storage: STORAGE,
    storageStale: false,
    projects: PROJECTS,
    client,
    remotePaired: false,
    remote: false,
    models: MODELS,
    modelDefaults: MODEL_DEFAULTS,
    refreshModelDefaults: vi.fn(async () => {}),
    setModelDefault: vi.fn(async () => null),
    downloadErrors: {},
    nodePacks: NODE_PACKS,
    workflows: WORKFLOWS,
    refreshStorage: vi.fn(async () => {}),
    refreshModels: vi.fn(async () => {}),
    refreshComfy: vi.fn(async () => null),
    ...over,
  } as never);
  const view = await act(async () => render(<Settings />));
  return view;
}

/** Buttons this dialog owns, in whatever state it is currently in.
 *
 * Scanned from the document rather than from the render container, because
 * `Modal` portals to `<body>`: a dialog Settings opens is not inside the
 * tree Settings rendered. Scoped to the container, the grant-dialog audits
 * below would have found no buttons at all — and an empty list satisfies
 * every assertion under it. */
const ownButtons = (root: HTMLElement = document.body) =>
  [...root.querySelectorAll("button")].filter((button) => !button.closest('[role="tablist"]'));

const describeButton = (button: HTMLButtonElement) =>
  button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "(unlabelled)";

beforeEach(() => {
  localStorage.clear();
});

describe("every action in Settings carries a tooltip", () => {
  for (const tab of OWN_TABS) {
    it(`explains every button on the ${tab} pane`, async () => {
      await mount(tab);
      const buttons = ownButtons();
      // A query that finds nothing passes every assertion under it. The
      // close button alone is on every pane, so one is the floor.
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      const bare = buttons
        .filter((button) => !button.closest(".tip-wrap"))
        .map((button) => describeButton(button as HTMLButtonElement));
      expect(bare).toEqual([]);
    });
  }

  // The two states the Engine pane only reaches by being used: a host under
  // review (Cancel / Confirm) and one already paired (Disconnect).
  it("explains the pairing review's two answers", async () => {
    const inspectPairing = vi.fn(async () => ({
      ok: true,
      error: null,
      host: "boxa.local",
      url: "https://boxa.local",
      fingerprint: "ab:cd",
      keys: { anthropic: true, openai: false, gemini: false, fal: false, encrypted: true },
    }));
    await mount("engine", { inspectPairing });
    fireEvent.change(screen.getByLabelText(t("settings.remote.pairAria")), {
      target: { value: "code" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("settings.remote.pair") }));
    });
    const buttons = ownButtons();
    expect(buttons.some((button) => button.textContent === t("common.cancel"))).toBe(true);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });

  it("explains disconnecting an engine that is already paired", async () => {
    await mount("engine", { remotePaired: true, remote: true });
    const buttons = ownButtons();
    expect(
      buttons.some((button) => button.textContent === t("settings.remote.disconnect")),
    ).toBe(true);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });

  // A row mid-download draws a Cancel the resting pane never shows, and the
  // word is the ambiguous one on the whole pane: it pauses, it does not throw
  // the partial file away.
  it("explains cancelling a download in flight", async () => {
    const downloading = MODELS.map((row) =>
      row.id === "ltx/0.9-t2v"
        ? { ...row, downloading: true, progress: { done: 1_000_000_000, total: 4_000_000_000 } }
        : row,
    );
    await mount("models", { models: downloading });
    const buttons = ownButtons();
    expect(buttons.some((button) => button.textContent === t("common.cancel"))).toBe(true);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });

  it("explains every control in the custom model form", async () => {
    const { container } = await mount("models");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("models.custom.addEntry") }));
    });
    const buttons = ownButtons();
    expect(buttons.some((button) => button.textContent === t("models.custom.add"))).toBe(true);
    // The imported-workflow chips are part of this form; the fixture has two,
    // so a form rendered without them would not be the form under test.
    expect(container.querySelectorAll(".chip-row .chip").length).toBe(WORKFLOWS.length);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });

  // The grant dialog is the most consequential surface in Settings: it is
  // where third-party Python is allowed to run unsandboxed.
  it("explains the node pack grant dialog", async () => {
    await mount("workflows");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("settings.workflows.enable") }));
    });
    const buttons = ownButtons();
    expect(
      buttons.some((button) => button.textContent === t("settings.workflows.enableConfirm")),
    ).toBe(true);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });
});

/**
 * The app's bubble, not the browser's.
 *
 * `title` is the thing `Tip` replaced: it waits a second, it cannot be
 * reached by keyboard, and it draws in the OS's style rather than the app's.
 * Home says so where it uses `Tip` beside three chips; a dialog where some
 * controls speak one way and some the other is worse than either.
 */
describe("no control in Settings falls back to the browser tooltip", () => {
  for (const tab of OWN_TABS) {
    it(`leaves no title attribute on the ${tab} pane`, async () => {
      const { container } = await mount(tab);
      const titled = [...container.querySelectorAll("[title]")].map(
        (node) => `${node.nodeName.toLowerCase()}[title=${node.getAttribute("title")}]`,
      );
      expect(titled).toEqual([]);
    });
  }
});
