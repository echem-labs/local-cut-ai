/**
 * The four node actions and finalize, held to the store's reporting rule.
 *
 * The rule is that an action which can be refused returns `Promise<string |
 * null>`, where `null` means it applied and every other outcome — including
 * "there is no engine client" — is a message someone can render. These five
 * were typed `Promise<void>` instead, so an engine refusal became an
 * unhandled rejection: the button flicked, settled, and changed nothing.
 *
 * "Create final video" is the one that matters most. It is the screen's
 * primary action and the most expensive thing the app does, and a 403 from
 * the cloud-spend gate reached the user as complete silence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "./i18n";
import { useApp } from "./store";

const PROJECT = { id: "p1", title: "a hummingbird", created_at: 0, updated_at: 0, mode: "prompt" };
const BOARD = { scenes: [], aux: {} };

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({ project: PROJECT, board: BOARD }),
    history: vi.fn().mockResolvedValue({ undo: 0, redo: 0, save_points: [] }),
    patch: vi.fn().mockResolvedValue({ dirty: [] }),
    regenerate: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    uploadAsset: vi.fn().mockResolvedValue({ node_id: "asset-abc123", hash: "h1", name: "n" }),
    createProject: vi.fn().mockResolvedValue(PROJECT),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  useApp.setState({
    client: null,
    currentProject: null,
    board: null,
    projects: [],
    allJobs: [],
    jobs: [],
    openProjects: [],
    actionError: null,
  } as never);
});

/** Every action here, with a call that reaches the engine on the happy path. */
const ACTIONS: Array<[string, () => Promise<string | null>]> = [
  ["finalize", () => useApp.getState().finalize()],
  ["regenerate", () => useApp.getState().regenerate("s1.clip")],
  ["applyNode", () => useApp.getState().applyNode("s1.clip", { seed: 7 })],
  ["togglePin", () => useApp.getState().togglePin("s1.clip", true)],
  [
    "applyClonedVoice",
    () => useApp.getState().applyClonedVoice(new File(["riff"], "me.wav", { type: "audio/wav" })),
  ],
];

describe.each(ACTIONS)("%s", (name, run) => {
  it("returns null when it applied", async () => {
    useApp.setState({ client: fakeClient(), currentProject: PROJECT, board: BOARD } as never);
    expect(await run()).toBeNull();
  });

  it("returns the engine's reason instead of rejecting", async () => {
    // The 403 the cloud-spend gate answers finalize with, and the 422 an
    // edit against a node another window removed answers the rest with.
    const refuse = vi.fn().mockRejectedValue(new Error("that would spend money"));
    useApp.setState({
      client: fakeClient({ patch: refuse, regenerate: refuse, finalize: refuse, uploadAsset: refuse }),
      currentProject: PROJECT,
      board: BOARD,
    } as never);
    expect(await run()).toBe("that would spend money");
  });

  it("says the engine is unavailable rather than returning nothing", async () => {
    // The state after a crash or a restart, where returning undefined read
    // to every caller as "it applied".
    useApp.setState({ client: null, currentProject: PROJECT, board: BOARD } as never);
    expect(await run()).toBe(t("errors.engineUnavailable"));
  });
});

describe("reportActionError", () => {
  it("raises a board alert for a message and stays quiet for null", () => {
    useApp.getState().reportActionError("the engine refused");
    expect(useApp.getState().actionError).toEqual({
      scope: "board",
      message: "the engine refused",
    });

    useApp.setState({ actionError: null } as never);
    useApp.getState().reportActionError(null);
    expect(useApp.getState().actionError).toBeNull();
  });
});

describe("creating with no engine", () => {
  // Home clears its prompt row on the way back from these, guarded on
  // `actionError`. A silent return therefore took the typed prompt and every
  // format choice with it and said nothing — the one place in the app where
  // a refusal destroyed the user's own words.
  it("reports rather than returning silently, so Home keeps the prompt", async () => {
    useApp.setState({ client: null } as never);
    await useApp.getState().createFromPrompt("a hummingbird", 30, "9:16", "prompt", undefined);
    expect(useApp.getState().actionError).toEqual({
      scope: "create",
      message: t("errors.engineUnavailable"),
    });
  });

  it("reports for a quick tool too", async () => {
    useApp.setState({ client: null } as never);
    await useApp.getState().createTool("script", { prompt: "a hummingbird" });
    expect(useApp.getState().actionError).toEqual({
      scope: "tool",
      message: t("errors.engineUnavailable"),
    });
  });
});
