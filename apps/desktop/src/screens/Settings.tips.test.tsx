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
 * Two exclusions, both deliberate:
 * - The nav tablist. A tab carries its own visible label and SELECTS rather
 *   than acts; a bubble on every one of eight would fire on the way to any
 *   of them.
 * - `ModelLibrary` and `WorkflowsPane`. They are rendered by Settings, not
 *   owned by it — `ModelLibrary` is also the first-run wizard's download
 *   list, so its buttons answer to that surface too.
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
const client = { baseUrl: "http://127.0.0.1:7830", listProviders: async () => PROVIDERS };

/** Panes whose buttons Settings itself writes. `models` and `workflows` are
 *  delegated to their own components and excluded above. */
const OWN_TABS = ["general", "defaults", "providers", "storage", "engine", "about"] as const;

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
    refreshStorage: vi.fn(async () => {}),
    refreshModels: vi.fn(async () => {}),
    ...over,
  } as never);
  const view = await act(async () => render(<Settings />));
  return view;
}

/** Buttons this dialog owns, in whatever state it is currently in. */
const ownButtons = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].filter(
    (button) =>
      !button.closest('[role="tablist"]') &&
      !button.closest(".model-library") &&
      !button.closest(".workflows-pane"),
  );

const describeButton = (button: HTMLButtonElement) =>
  button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "(unlabelled)";

beforeEach(() => {
  localStorage.clear();
});

describe("every action in Settings carries a tooltip", () => {
  for (const tab of OWN_TABS) {
    it(`explains every button on the ${tab} pane`, async () => {
      const { container } = await mount(tab);
      const buttons = ownButtons(container as HTMLElement);
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
    const { container } = await mount("engine", { inspectPairing });
    fireEvent.change(screen.getByLabelText(t("settings.remote.pairAria")), {
      target: { value: "code" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("settings.remote.pair") }));
    });
    const buttons = ownButtons(container as HTMLElement);
    expect(buttons.some((button) => button.textContent === t("common.cancel"))).toBe(true);
    const bare = buttons
      .filter((button) => !button.closest(".tip-wrap"))
      .map((button) => describeButton(button as HTMLButtonElement));
    expect(bare).toEqual([]);
  });

  it("explains disconnecting an engine that is already paired", async () => {
    const { container } = await mount("engine", { remotePaired: true, remote: true });
    const buttons = ownButtons(container as HTMLElement);
    expect(
      buttons.some((button) => button.textContent === t("settings.remote.disconnect")),
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
