import { render, screen } from "@testing-library/react";

import { describe, expect, it, beforeEach } from "vitest";

import type { Job, ModelRow, ProgramInfo } from "../api/types";
import { plural } from "../i18n";
import { formatSize } from "./ModelLibrary";
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
    programs: null,
    programQueue: [],
    setupPlans: {},
    settingsOpen: false,
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

  it("yields while Settings is open instead of covering its controls", () => {
    // The pill floats above the Settings layer (z-tray > z-drawer) and sat
    // exactly on the Models pane's "Add custom model" button, swallowing its
    // clicks. Settings has its own download and queue surfaces — the tray
    // adds nothing there but the overlap.
    useApp.setState({ allJobs: [job({})], settingsOpen: true } as never);
    const { container } = render(<QueueTray />);

    expect(container.querySelector(".queue-tray")).toBeNull();
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

/**
 * The pill's "left" is what is still coming down, and program setups come
 * down the same line as the models. On a fresh install it said "4 models ·
 * 1% · 24 GB left" while ComfyUI and Ollama brought another 10 GB.
 */
describe("the tray's downloads", () => {
  const GiB = 2 ** 30;
  const model = (id: string, size: number, done: number): ModelRow =>
    ({
      id,
      size_bytes: size,
      downloaded: false,
      downloading: true,
      progress: { done, total: size },
      partial_bytes: 0,
    }) as ModelRow;
  const comfyui = {
    id: "comfyui",
    state: "missing",
    setup: {
      download_bytes: 3.6 * GiB,
      pull: null,
      job: { id: "c", phase: "downloading", done: 0.6 * GiB, total: 3.6 * GiB, bytes_per_s: null },
    },
  } as unknown as ProgramInfo;
  const ollama = {
    id: "ollama",
    state: "missing",
    checks: {},
    managed: null,
    setup: {
      available: true,
      takes_effect: true,
      download_bytes: 1.4 * GiB,
      pull: { model: "qwen3:8b", bytes: 5 * GiB },
      job: null,
      last: null,
    },
  } as unknown as ProgramInfo;

  it("counts the setups running and waiting beside the models", () => {
    useApp.setState({
      models: [model("sdxl", 6 * GiB, 2 * GiB), model("ltx", 10 * GiB, 0)],
      programs: {
        platform: null,
        programs_dir: "",
        programs_bytes: 0,
        disk_free_bytes: 0,
        programs: [comfyui, ollama],
      },
      programQueue: ["ollama"],
      setupPlans: { comfyui: 3.6 * GiB, ollama: 6.4 * GiB },
    } as never);
    render(<QueueTray />);
    // 16 GB of models and 10 GB of programs, 2.6 GB of it in: 10%.
    expect(screen.getByRole("status")).toHaveTextContent(
      plural("queue.downloads", 4, { pct: 10, size: formatSize(26 * GiB - 2.6 * GiB) }),
    );
  });
});
