/**
 * The wiring between a running render and the taskbar.
 *
 * `shellProgress` decides what is true and main decides where it lands; this
 * is the piece between them, and its failure mode is volume. `job.progress`
 * arrives several times a second, so a hook that pushes on every store change
 * would make a few hundred IPC calls per render to redraw a bar that cannot
 * show more than whole percent.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, Job, NodeStatus, Project } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { useShellProgress } from "./useShellProgress";

const setShellProgress = vi.fn(async (_progress: { fraction: number; title: string }) => ({
  ok: true,
  error: null,
}));

const boardOf = (statuses: NodeStatus[]): Board =>
  ({ scenes: statuses.map((status) => ({ clip: { status } })), aux: {} }) as unknown as Board;

const job = (status: Job["status"], progress = 0): Job =>
  ({ status, progress, spec: { node_id: "n", kind: "clip" } }) as Job;

const PROJECT = { id: "p1", title: "A film about bees" } as Project;

function Probe() {
  useShellProgress();
  return null;
}

/** Put the store in a state and let the hook's effect run. */
const pose = async (state: Record<string, unknown>) => {
  await act(async () => {
    useApp.setState(state as never);
  });
};

beforeEach(() => {
  (window as unknown as { localcut: unknown }).localcut = { setShellProgress };
  setShellProgress.mockClear();
  useApp.setState({ board: null, jobs: [], currentProject: null } as never);
});

afterEach(cleanup);

describe("what reaches the taskbar while a render runs", () => {
  it("names the project and how far along it is", async () => {
    useApp.setState({
      board: boardOf(["final", "final", "final", "final", "rendering"]),
      jobs: [job("rendering", 0)],
      currentProject: PROJECT,
    } as never);
    render(<Probe />);

    expect(setShellProgress).toHaveBeenLastCalledWith({
      fraction: 0.8,
      title: t("titlebar.windowRendering", { done: 4, total: 5, project: "A film about bees" }),
    });
  });

  it("clears the bar when the render finishes", async () => {
    useApp.setState({
      board: boardOf(["rendering"]),
      jobs: [job("rendering", 0.5)],
      currentProject: PROJECT,
    } as never);
    render(<Probe />);
    setShellProgress.mockClear();

    await pose({ board: boardOf(["final"]), jobs: [job("done")] });

    // Sent, not merely skipped: whatever this reported last is what the
    // taskbar goes on showing.
    expect(setShellProgress).toHaveBeenLastCalledWith({ fraction: -1, title: "" });
  });

  it("does not re-send a bar that has not visibly moved", async () => {
    // The volume case. Two ticks inside the same whole percent are the same
    // bar and the same title.
    useApp.setState({
      board: boardOf(["rendering", "final"]),
      jobs: [job("rendering", 0.5)],
      currentProject: PROJECT,
    } as never);
    render(<Probe />);
    setShellProgress.mockClear();

    await pose({ jobs: [job("rendering", 0.5004)] });

    expect(setShellProgress).not.toHaveBeenCalled();
  });

  it("sends again once the bar has moved a whole percent", async () => {
    useApp.setState({
      board: boardOf(["rendering", "final"]),
      jobs: [job("rendering", 0.5)],
      currentProject: PROJECT,
    } as never);
    render(<Probe />);
    setShellProgress.mockClear();

    await pose({ jobs: [job("rendering", 0.6)] });

    expect(setShellProgress).toHaveBeenCalledTimes(1);
  });

  it("says nothing at all in a browser with no shell to tell", async () => {
    delete (window as unknown as { localcut?: unknown }).localcut;
    useApp.setState({
      board: boardOf(["rendering"]),
      jobs: [job("rendering", 0.5)],
      currentProject: PROJECT,
    } as never);

    expect(() => render(<Probe />)).not.toThrow();
    expect(setShellProgress).not.toHaveBeenCalled();
  });
});
