/**
 * When the app is allowed to interrupt.
 *
 * An OS notification is the most intrusive thing this app can do, so the
 * rules worth pinning are all about restraint: once per render rather than
 * once per scene, never for a batch where nothing succeeded, and never at
 * all when the preference is off.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Job, Project } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { useDoneNotice } from "./useDoneNotice";

const notifyDone = vi.fn(async (_notice: { title: string; body: string }) => ({
  ok: true,
  shown: true,
  error: null,
}));

const PROJECT = { id: "p1", title: "A film about bees" } as Project;

const job = (id: string, status: Job["status"], created_at = 1): Job =>
  ({ id, status, created_at, progress: 0, project_id: "p1", spec: { node_id: "n", kind: "clip" } }) as Job;

function Probe() {
  useDoneNotice();
  return null;
}

const pose = async (state: Record<string, unknown>) => {
  await act(async () => {
    useApp.setState(state as never);
  });
};

beforeEach(() => {
  (window as unknown as { localcut: unknown }).localcut = { notifyDone };
  notifyDone.mockClear();
  useApp.setState({ allJobs: [], projects: [PROJECT], notifyOnDone: true } as never);
});

afterEach(cleanup);

describe("the notification a finished render raises", () => {
  it("names the project whose render finished", async () => {
    useApp.setState({ allJobs: [job("j1", "rendering")] } as never);
    render(<Probe />);

    await pose({ allJobs: [job("j1", "done")] });

    expect(notifyDone).toHaveBeenCalledWith({
      title: t("notify.renderDoneTitle"),
      body: t("notify.renderDoneBody", { project: "A film about bees" }),
    });
  });

  it("fires once for the whole render, not once per scene", async () => {
    // A nine-scene video finishing would otherwise raise nine notices, eight
    // of which say the render is still going.
    useApp.setState({
      allJobs: [job("j1", "rendering"), job("j2", "queued"), job("j3", "queued")],
    } as never);
    render(<Probe />);

    await pose({ allJobs: [job("j1", "done"), job("j2", "rendering"), job("j3", "queued")] });
    await pose({ allJobs: [job("j1", "done"), job("j2", "done"), job("j3", "rendering")] });
    expect(notifyDone).not.toHaveBeenCalled();

    await pose({ allJobs: [job("j1", "done"), job("j2", "done"), job("j3", "done")] });
    expect(notifyDone).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on a batch where nothing succeeded", async () => {
    // A failed render is reported where the user can act on it. An OS notice
    // saying a video is ready would be false.
    useApp.setState({ allJobs: [job("j1", "rendering")] } as never);
    render(<Probe />);

    await pose({ allJobs: [job("j1", "failed")] });

    expect(notifyDone).not.toHaveBeenCalled();
  });

  it("says nothing when the preference is off", async () => {
    useApp.setState({ allJobs: [job("j1", "rendering")], notifyOnDone: false } as never);
    render(<Probe />);

    await pose({ allJobs: [job("j1", "done")] });

    expect(notifyDone).not.toHaveBeenCalled();
  });

  it("does not fire on an idle app that has rendered nothing", async () => {
    // The transition is what matters, not the state. Reading "not busy"
    // alone would notify on the first store change after launch, against a
    // job list left over from a previous session.
    useApp.setState({ allJobs: [job("j1", "done")] } as never);
    render(<Probe />);

    await pose({ projects: [PROJECT] });

    expect(notifyDone).not.toHaveBeenCalled();
  });

  it("credits the newest render, not whichever ended up first in the list", async () => {
    // Store merges reorder `/jobs`, so indexing either end can name the
    // oldest render rather than the one that just finished.
    const other = { id: "p2", title: "An older film" } as Project;
    useApp.setState({
      projects: [PROJECT, other],
      allJobs: [job("j1", "rendering", 50)],
    } as never);
    render(<Probe />);

    await pose({
      allJobs: [
        { ...job("j0", "done", 10), project_id: "p2" },
        { ...job("j1", "done", 50), project_id: "p1" },
      ],
    });

    expect(notifyDone).toHaveBeenCalledWith(
      expect.objectContaining({
        body: t("notify.renderDoneBody", { project: "A film about bees" }),
      }),
    );
  });
});
