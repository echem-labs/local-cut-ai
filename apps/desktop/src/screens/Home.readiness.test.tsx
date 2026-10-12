/**
 * The note under Home's prompt is only as true as the last readiness report
 * the store fetched, and that report changes with nothing in the app
 * happening: an LLM server started from a terminal, a model pulled with
 * `ollama pull`, ComfyUI launched by hand. None of those reaches the engine
 * as an event. It finds out when it is asked, so Home has to keep asking,
 * at a pace the engine can carry: every report probes the LLM server and
 * ComfyUI.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Home, READINESS_POLL_MS } from "./Home";

/** The store's own refresh, captured before any test swaps in a spy. */
const storeRefresh = useApp.getState().refreshReadiness;

function seed(over: Record<string, unknown> = {}) {
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    models: [],
    system: null,
    templates: [],
    readiness: null,
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
    },
    defaults: {
      aspect: "9:16",
      duration: 60,
      style: "cinematic",
      mode: "prompt",
      voice: "",
      videoModel: null,
    },
    setHomeDraft: vi.fn(),
    setDefaults: vi.fn(),
    createFromPrompt: vi.fn(async () => {}),
    createTool: vi.fn(async () => {}),
    openProject: vi.fn(async () => {}),
    refreshHome: vi.fn(async () => {}),
    openLibrary: vi.fn(),
    openSettings: vi.fn(),
    actionError: null,
    ...over,
  } as never);
}

/** A store whose readiness refresh is a spy, so the asks can be counted. */
function counted(refresh: () => Promise<void> = async () => {}) {
  const refreshReadiness = vi.fn(refresh);
  seed({ refreshReadiness });
  return refreshReadiness;
}

const focusWindow = () =>
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

let hidden = false;

beforeEach(() => {
  localStorage.clear();
  hidden = false;
  // jsdom's document is always "visible"; an own property shadows the
  // prototype's getter so a test can minimise the window.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe("Home's readiness report", () => {
  it("is asked for when Home mounts", () => {
    // Coming back from a project re-mounts Home, and the report it holds is
    // from whenever the store last happened to fetch one.
    const refresh = counted();
    render(<Home />);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("is asked for again when the window regains focus", async () => {
    // The usual way back from the terminal the LLM server was started in.
    const refresh = counted();
    render(<Home />);
    await wait(0);
    focusWindow();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("is asked for again on a timer while the window can be seen", async () => {
    const refresh = counted();
    render(<Home />);
    await wait(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await wait(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("is not asked for on the timer while the window is hidden", async () => {
    const refresh = counted();
    render(<Home />);
    hidden = true;
    await wait(READINESS_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("is never asked for twice at once", async () => {
    // A slow LLM server makes a slow report. Asking again before it answers
    // would stack probes on the very server that is struggling.
    const refresh = counted(() => new Promise<void>(() => {}));
    render(<Home />);
    focusWindow();
    await wait(READINESS_POLL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops being asked for once Home is gone", async () => {
    const refresh = counted();
    const view = render(<Home />);
    await wait(0);
    view.unmount();
    focusWindow();
    await wait(READINESS_POLL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the note under the prompt", () => {
  const down: ReadinessRow = {
    kind: "script",
    model: "qwen3:14b",
    backend: "mock",
    verdict: "placeholder",
    reason: "llm_server_down",
    data: {},
    fix: null,
  };
  const up: ReadinessRow = { ...down, backend: "llm", verdict: "ready", reason: "ok" };

  it("clears once the engine reports the LLM server up", async () => {
    // The real store action against an engine whose LLM server comes up
    // between two reports. Nothing in the app does anything in between.
    const readiness = vi
      .fn()
      .mockResolvedValueOnce({ rows: [down] })
      .mockResolvedValue({ rows: [up] });
    seed({ client: { readiness }, readiness: [down], refreshReadiness: storeRefresh });
    render(<Home />);
    await wait(0);
    expect(screen.getByRole("button", { name: t("home.getIt") })).toBeTruthy();
    await wait(READINESS_POLL_MS);
    expect(screen.queryByRole("button", { name: t("home.getIt") })).toBeNull();
  });
});
