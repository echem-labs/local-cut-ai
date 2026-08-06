/**
 * The offer to resume a project whose queue is gone.
 *
 * This is the one state the app could not talk itself out of. A killed
 * engine leaves nodes reading `rendering` with nothing behind them, and
 * there is no route back into flight from the UI: `/patch` re-plans only
 * when an op dirtied something, so with no edit to make, an idle project
 * that believes it is busy stays that way forever.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, Job, NodeState } from "../api/types";
import { useApp } from "../store";
import { Project } from "./Project";

const node = (id: string, status: string): NodeState =>
  ({
    node_id: id,
    status,
    progress: 0,
    error: null,
    artifact_hash: null,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const board = (clipStatus: string): Board =>
  ({
    scenes: [
      {
        scene_id: "s1",
        keyframe: node("s1.keyframe", "draft"),
        clip: node("s1.clip", clipStatus),
        narration: node("s1.narration", "draft"),
      },
    ],
    aux: { script: node("script", "draft") },
    assembled_durations: {},
  }) as unknown as Board;

const mount = (clipStatus: string, jobs: Job[] = [], extra: Record<string, unknown> = {}) => {
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", mode: "auto", approvals: [] },
    board: board(clipStatus),
    jobs,
    allJobs: [],
    ...extra,
  } as never);
  render(<Project />);
};

beforeEach(() => useApp.setState({ nodeFailures: {}, nodeRetries: {} } as never));

describe("a project waiting on a queue that is gone", () => {
  it("offers to resume, and says why", async () => {
    mount("rendering", []);
    const notice = screen.getByRole("note", { name: /rendering stopped/i });
    expect(notice).toHaveTextContent(/no longer queued/i);
    expect(screen.getByRole("button", { name: /resume rendering/i })).toBeEnabled();
  });

  it("stays quiet while the queue still holds the work", () => {
    mount("rendering", [
      { id: "j1", project_id: "p1", status: "rendering", created_at: 1 } as unknown as Job,
    ]);
    expect(screen.queryByRole("button", { name: /resume rendering/i })).toBeNull();
  });

  it("stays quiet when nothing is outstanding", () => {
    mount("draft", []);
    expect(screen.queryByRole("button", { name: /resume rendering/i })).toBeNull();
  });

  it("asks the engine to enqueue what the graph still owes", async () => {
    const resumeRender = vi.fn().mockResolvedValue(null);
    mount("queued", [], { resumeRender });

    await userEvent.click(screen.getByRole("button", { name: /resume rendering/i }));
    expect(resumeRender).toHaveBeenCalledOnce();
  });

  it("reports a refusal instead of swallowing it", async () => {
    const resumeRender = vi.fn().mockResolvedValue("the engine could not be reached");
    mount("queued", [], { resumeRender });

    await userEvent.click(screen.getByRole("button", { name: /resume rendering/i }));
    const notice = screen.getByRole("note", { name: /rendering stopped/i });
    expect(await within(notice).findByRole("alert")).toHaveTextContent(/could not be reached/i);
  });
});
