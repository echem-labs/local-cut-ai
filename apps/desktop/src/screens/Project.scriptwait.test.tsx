import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { describe, expect, it, vi } from "vitest";

import type { Board, NodeState, NodeStatus } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Project } from "./Project";

/**
 * A new project's first minutes: the script is being written, the board is
 * empty by definition, and this banner is the whole screen. It used to be one
 * static sentence — with a local model taking minutes over a screenplay, that
 * is indistinguishable from an app that has stopped.
 *
 * The two halves the tests below pin: the wait says it is live and still
 * moving, and a script that is NOT running does not pretend otherwise.
 */

const scriptNode = (status: NodeStatus): NodeState => ({
  node_id: "script",
  status,
  progress: 0,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const mount = (script: NodeState | undefined, regenerate = vi.fn().mockResolvedValue(undefined)) => {
  const board: Board = { scenes: [], aux: script ? { script } : {}, assembled_durations: {} };
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", mode: "auto", approvals: [] },
    board,
    jobs: [],
    allJobs: [],
    regenerate,
  } as never);
  return { ...render(<Project />), regenerate };
};

describe("the empty board while the script is written", () => {
  it("spins, names the stage, and counts the wait out", async () => {
    const { container } = mount(scriptNode("rendering"));

    expect(container.querySelector(".wait-ring.spin")).not.toBeNull();
    expect(screen.getByText(t("project.scriptWriting"))).toBeInTheDocument();
    // Nothing yet: a wait that ends quickly must not flash a timer and take
    // it away again (ELAPSED_AFTER_S).
    expect(screen.queryByText(/^\d+s$/)).toBeNull();

    // The counter is the half a spinner cannot supply: a spinner alone spins
    // exactly the same way over a request that will never answer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4200));
    });
    expect(screen.getByText(t("common.elapsedSeconds", { seconds: 4 }))).toBeInTheDocument();
  });

  it("waits before the queue has picked the script up", () => {
    // The graph is written before the queue has anything to say about it, so
    // the first moment of a new project has no script node at all. That is
    // work in flight too, and naming it "writing" would be a guess.
    const { container } = mount(undefined);

    expect(container.querySelector(".wait-ring.spin")).not.toBeNull();
    expect(screen.getByText(t("project.scriptQueued"))).toBeInTheDocument();
  });

  it("does not spin over a script nobody is running", async () => {
    // Cancelled leaves an empty board exactly like a script in flight does.
    // Spinning over it is the same lie as a green tick, animated — and with
    // no scenes there is no board, composer or inspector to restart from, so
    // the banner has to carry the retry itself.
    const { container, regenerate } = mount(scriptNode("cancelled"));

    expect(container.querySelector(".wait-ring.spin")).toBeNull();
    expect(screen.getByText(t("project.scriptStopped"))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t("project.retryScript") }));
    expect(regenerate).toHaveBeenCalledWith("script");
  });
});
