/**
 * The banner over the board is only as true as the last project readiness
 * report the store fetched, and that report changes while the project stays
 * open with nothing in the app happening: an LLM server started from a
 * terminal, a model pulled with `ollama pull`, ComfyUI launched by hand. The
 * banner keeps asking at Home's pace, and no faster: opening the project
 * already asked once, so mounting does not ask again.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { READINESS_POLL_MS } from "../lib/useReadinessRefresh";
import { useApp } from "../store";
import { ReadinessBanner } from "./Readiness";

/** The store's own refresh, captured before any test swaps in a spy. */
const storeRefresh = useApp.getState().refreshReadiness;

const scriptDown: ReadinessRow = {
  kind: "script",
  model: "qwen3:8b",
  backend: "mock",
  verdict: "placeholder",
  reason: "llm_server_down",
  data: { task: "text.llm" },
  fix: null,
};

const scriptUp: ReadinessRow = { ...scriptDown, backend: "llm", verdict: "ready", reason: "ok" };

function seed(over: Record<string, unknown> = {}) {
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", mode: "advanced", approvals: [] },
    projectReadiness: [scriptDown],
    readiness: [scriptDown],
    models: [],
    programs: null,
    warnMissingModels: true,
    ...over,
  } as never);
}

/** A store whose readiness refresh is a spy, so the asks can be counted. */
function counted(refresh: () => Promise<void> = async () => {}) {
  const refreshReadiness = vi.fn(refresh);
  seed({ refreshReadiness });
  return refreshReadiness;
}

const banner = () => screen.queryByText(t("readiness.banner.title"));

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
  localStorage.clear();
});

describe("the readiness banner over an open project", () => {
  it("clears once the engine reports the LLM server up", async () => {
    // The real store action against an engine whose LLM server comes up
    // while the project is open. Nothing in the app does anything between
    // the two reports.
    const projectReadiness = vi.fn().mockResolvedValue({ rows: [scriptUp] });
    const readiness = vi.fn().mockResolvedValue({ rows: [scriptUp] });
    seed({ client: { readiness, projectReadiness }, refreshReadiness: storeRefresh });
    render(<ReadinessBanner />);
    await wait(0);
    expect(banner()).not.toBeNull();
    await wait(READINESS_POLL_MS);
    expect(projectReadiness).toHaveBeenCalledWith("p1");
    expect(banner()).toBeNull();
  });

  it("clears when the window regains focus, without waiting for the timer", async () => {
    // The usual way back from the terminal the LLM server was started in.
    const projectReadiness = vi.fn().mockResolvedValue({ rows: [scriptUp] });
    const readiness = vi.fn().mockResolvedValue({ rows: [scriptUp] });
    seed({ client: { readiness, projectReadiness }, refreshReadiness: storeRefresh });
    render(<ReadinessBanner />);
    await wait(0);
    expect(banner()).not.toBeNull();
    focusWindow();
    await wait(0);
    expect(banner()).toBeNull();
  });
});

describe("the banner's readiness asks", () => {
  it("are not made on mount, because opening the project already asked", () => {
    const refresh = counted();
    render(<ReadinessBanner />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("are made again on Home's timer while the window can be seen", async () => {
    const refresh = counted();
    render(<ReadinessBanner />);
    await wait(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await wait(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("are not made on the timer while the window is hidden", async () => {
    const refresh = counted();
    render(<ReadinessBanner />);
    hidden = true;
    await wait(READINESS_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("are never made twice at once", async () => {
    // A slow LLM server makes a slow report. Asking again before it answers
    // would stack probes on the very server that is struggling.
    const refresh = counted(() => new Promise<void>(() => {}));
    render(<ReadinessBanner />);
    focusWindow();
    await wait(READINESS_POLL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("are made whether or not anything is wrong yet", async () => {
    // A report with no gaps renders no banner, and the next report can
    // still bring one: ComfyUI stopped from its own window, say.
    const refresh = counted();
    useApp.setState({ projectReadiness: [scriptUp] } as never);
    render(<ReadinessBanner />);
    expect(banner()).toBeNull();
    await wait(READINESS_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stop once the banner is gone", async () => {
    const refresh = counted();
    const view = render(<ReadinessBanner />);
    view.unmount();
    focusWindow();
    await wait(READINESS_POLL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
  });
});
