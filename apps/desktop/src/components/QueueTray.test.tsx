import { render, screen } from "@testing-library/react";

import { describe, expect, it, beforeEach } from "vitest";

import type { Job } from "../api/types";
import { useApp } from "../store";
import { QueueTray } from "./QueueTray";

/**
 * The tray is the app-global "is the engine working?" pill, but it read the
 * per-open-project `jobs` slice — so a render kicked off in one project
 * reported "idle · free" the moment you looked at Home or another project,
 * while the GPU was fully busy. It has to read the engine-wide list, with
 * the fresher project-scoped slice winning for the project that is open.
 */

const job = (over: Partial<Job>): Job =>
  ({
    id: "j1",
    project_id: "p1",
    status: "rendering",
    progress: 0.4,
    spec: { node_id: "s2.clip", kind: "clip" },
    error: null,
    created_at: 0,
    ...over,
  }) as unknown as Job;

beforeEach(() => {
  useApp.setState({
    jobs: [],
    allJobs: [],
    models: [],
    currentProject: null,
    firstRunDone: true,
  } as never);
});

describe("QueueTray", () => {
  it("shows another project's render when no project is open", () => {
    useApp.setState({ allJobs: [job({})] } as never);
    render(<QueueTray />);

    expect(screen.getByRole("status").textContent).toContain("40%");
  });

  it("counts queued work across the whole engine", () => {
    useApp.setState({
      allJobs: [
        job({ id: "j1", status: "queued" }),
        job({ id: "j2", project_id: "p2", status: "queued" }),
      ],
    } as never);
    render(<QueueTray />);

    expect(screen.getByRole("status").textContent).toContain("2");
  });

  it("prefers the open project's fresher slice over the stale engine list", () => {
    // `jobs` refreshes with the board on every lifecycle edge; `allJobs`
    // only on the debounced home refresh. For the open project the stale
    // row must not resurrect a job the fresh slice already saw finish.
    useApp.setState({
      currentProject: { id: "p1", title: "t", approvals: [] },
      jobs: [job({ status: "done", progress: 1 })],
      allJobs: [job({ status: "rendering", progress: 0.4 })],
    } as never);
    const { container } = render(<QueueTray />);

    expect(container.querySelector(".queue-tray")).toBeNull();
  });
});
