/**
 * The missing-model preflight: the facts strip, and the gate that holds an
 * explicit render click.
 *
 * Two rules carry the design and so are pinned hardest here. First, a
 * warning is not a block: "Render anyway" always exists and always
 * proceeds. Second, suppression silences the DIALOG, never the banner —
 * and it covers exactly the gap set it was dismissed for, so fixing one
 * model while losing another warns again rather than staying quiet.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { ReadinessBanner, useReadinessGuard } from "./Readiness";
import { useApp } from "../store";

const musicGap: ReadinessRow = {
  kind: "music",
  model: null,
  backend: "mock",
  verdict: "placeholder",
  reason: "no_model_installed",
  data: { task: "music.gen" },
  fix: { type: "download", model_id: "ace-step-v1-3.5b", size_bytes: 7_700_000_000 },
};

const clipDegraded: ReadinessRow = {
  kind: "clip",
  model: null,
  backend: "ffmpeg",
  verdict: "degraded",
  reason: "still_clip_tier",
  data: { task: "video.i2v" },
  fix: null,
};

const exportFails: ReadinessRow = {
  kind: "export",
  model: null,
  backend: null,
  verdict: "will_fail",
  reason: "no_ffmpeg",
  data: {},
  fix: { type: "install_ffmpeg" },
};

/** A store with a readiness report and a client whose readiness calls
 * answer `rows`. The gate fetches fresh at the click, so the client is
 * what it actually reads — the slices only feed the banner. */
function seed(rows: ReadinessRow[], overrides: Record<string, unknown> = {}) {
  useApp.setState({
    client: {
      readiness: vi.fn().mockResolvedValue({ rows }),
      projectReadiness: vi.fn().mockResolvedValue({ rows }),
    },
    currentProject: { id: "p1", title: "t", mode: "advanced", approvals: [] },
    projectReadiness: rows,
    readiness: rows,
    models: [],
    warnMissingModels: true,
    ...overrides,
  } as never);
}

function Harness({ onRun, scopeKey = "p1" }: { onRun: () => void; scopeKey?: string }) {
  const { guard, dialog } = useReadinessGuard(scopeKey);
  return (
    <>
      <button onClick={() => void guard(onRun)}>Render</button>
      {dialog}
    </>
  );
}

const renderAnyway = () => screen.queryByRole("button", { name: /render anyway/i });

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    client: null,
    currentProject: null,
    projectReadiness: null,
    readiness: null,
    warnMissingModels: true,
  } as never);
});

afterEach(() => {
  localStorage.clear();
});

describe("the readiness banner", () => {
  it("names the consequence of a missing music model, not just the model", () => {
    seed([musicGap]);
    render(<ReadinessBanner />);
    // The point of the whole feature: silence in the finished video is the
    // fact worth saying, and it is the one nothing said before.
    expect(screen.getByRole("status").textContent).toMatch(/no music/i);
  });

  it("stays quiet about the still-clip tier", () => {
    // A supported mode on a low-VRAM machine (doc 04 tier S/A) — warning
    // about it would train people to ignore the banner.
    seed([clipDegraded]);
    const { container } = render(<ReadinessBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the download when exactly one gap has one", async () => {
    const startDownload = vi.fn();
    seed([musicGap], { startDownload });
    render(<ReadinessBanner />);
    await userEvent.click(screen.getByRole("button", { name: /get ace-step/i }));
    expect(startDownload).toHaveBeenCalledWith("ace-step-v1-3.5b");
  });
});

describe("the render gate", () => {
  it("runs straight through when nothing is missing", async () => {
    const run = vi.fn();
    seed([]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("holds the click behind the dialog, then proceeds on Render anyway", async () => {
    const run = vi.fn();
    seed([musicGap]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(renderAnyway()!);
    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("never warns about a degraded row alone", async () => {
    const run = vi.fn();
    seed([clipDegraded]);
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("does not warn while the master switch is off", async () => {
    const run = vi.fn();
    seed([musicGap], { warnMissingModels: false });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("proceeds when the engine cannot report — a warning must not become a block", async () => {
    const run = vi.fn();
    seed([musicGap], {
      client: {
        readiness: vi.fn().mockRejectedValue(new Error("no engine")),
        projectReadiness: vi.fn().mockRejectedValue(new Error("no engine")),
      },
    });
    render(<Harness onRun={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
  });
});

describe("suppression", () => {
  // Session dismissals live for the window, so each test gets its own
  // scope key rather than leaking into the next one.
  let keys = 0;
  const nextKey = () => `scope-${++keys}`;

  /** Mount a fresh guard on `key`, click Render, dismiss with the given
   * scope (plain "Render anyway" = the session default), and hand back the
   * run spy and the second Render button for a follow-up click. */
  async function dismissOnce(key: string, scope?: "project" | "always") {
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    if (scope) {
      await userEvent.click(screen.getByRole("checkbox"));
      if (scope === "always") {
        // The scope control is a Dropdown; its trigger is named by the
        // aria-label, not by the option showing inside it.
        await userEvent.click(screen.getByRole("button", { name: /don't warn me again/i }));
        await userEvent.click(screen.getByRole("option", { name: /^always$/i }));
      }
    }
    await userEvent.click(renderAnyway()!);
    await waitFor(() => expect(run).toHaveBeenCalled());
    view.unmount();
    return run;
  }

  it("stops warning for the same gaps after Render anyway", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key);
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(renderAnyway()).toBeNull();
  });

  it("warns again when the gap set changes", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key);
    // Music fixed, ffmpeg since lost: a different problem, so the
    // dismissal of the old one must not cover it.
    seed([exportFails]);
    const run = vi.fn();
    const view = render(<Harness onRun={run} scopeKey={key} />);
    await userEvent.click(view.getByRole("button", { name: "Render" }));
    await waitFor(() => expect(renderAnyway()).not.toBeNull());
    expect(run).not.toHaveBeenCalled();
  });

  it("persists a per-project dismissal", async () => {
    const key = nextKey();
    seed([musicGap]);
    await dismissOnce(key, "project");
    expect(localStorage.getItem("localcut.readinessSkip.v1")).toContain(key);
  });

  it("flips the master switch for Always, and Settings can turn it back on", async () => {
    seed([musicGap]);
    await dismissOnce(nextKey(), "always");
    expect(useApp.getState().warnMissingModels).toBe(false);
    useApp.getState().setWarnMissingModels(true);
    expect(useApp.getState().warnMissingModels).toBe(true);
  });

  it("never silences the banner", async () => {
    seed([musicGap]);
    await dismissOnce(nextKey(), "project");
    render(<ReadinessBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/no music/i);
  });
});
