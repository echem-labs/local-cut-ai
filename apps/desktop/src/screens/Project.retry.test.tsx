import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { describe, expect, it, vi } from "vitest";

import type { Board, NodeState } from "../api/types";
import { useApp } from "../store";
import { Project } from "./Project";

/**
 * A script that fails to generate (small local models regularly emit a
 * screenplay that won't validate) left the project dead-ended: the banner
 * named the error but offered nothing, and with no scenes there is no board,
 * no composer and no inspector to regenerate from. The banner must carry the
 * retry itself.
 */

const failedScript: NodeState = {
  node_id: "script",
  status: "failed",
  progress: 0,
  error: "LLM returned an invalid screenplay",
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
};

const board: Board = { scenes: [], aux: { script: failedScript }, assembled_durations: {} };

describe("a project whose script failed", () => {
  it("offers a retry on the failure banner", async () => {
    const regenerate = vi.fn().mockResolvedValue(undefined);
    useApp.setState({
      client: null,
      currentProject: { id: "p1", title: "t", mode: "auto", approvals: [] },
      board,
      jobs: [],
      allJobs: [],
      regenerate,
    } as never);
    render(<Project />);

    expect(screen.getByText(/Script generation failed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(regenerate).toHaveBeenCalledWith("script");
  });
});
