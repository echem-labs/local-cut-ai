/**
 * Rewriting the screenplay from the one box.
 *
 * The composer could edit everything the script PRODUCED and never the
 * script itself: `EDITABLE_PARAMS` has no entry for the script node, so the
 * LLM edit view never shows it and a compiled plan can only reach the scenes
 * it expanded into. `/script/enhance` is the verb that rewrites the
 * screenplay, and it lived only on the quick-tool page — a project sitting
 * at its own script checkpoint had no way to say "rewrite this, shorter".
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState } from "../api/types";
import { Composer } from "./Composer";
import { useApp } from "../store";

const node = (id: string, status = "draft"): NodeState =>
  ({
    node_id: id,
    status,
    progress: 1,
    error: null,
    artifact_hash: "a".repeat(64),
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const board = (withScript = true): Board =>
  ({
    scenes: [
      { scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null },
    ],
    aux: withScript ? { script: node("script") } : {},
  }) as unknown as Board;

const mount = (over: Record<string, unknown> = {}) => {
  useApp.setState({
    board: board(),
    currentProject: { id: "p1", title: "P", created_at: 0, mode: "prompt", approvals: [] },
    history: { undo_depth: 0, redo_depth: 0, undo_top: null, redo_top: null, savepoints: [] },
    selectedNode: null,
    editBusy: false,
    ...over,
  } as never);
  render(<Composer />);
};

const send = (value: string) => {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: "Enter" });
};

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ board: null, currentProject: null, history: null } as never);
});

describe("the script scope", () => {
  it("is offered once there is a script to amend", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /whole video/i }));
    expect(screen.getByRole("option", { name: /the script/i })).toBeInTheDocument();
  });

  it("is not offered for a project that has no script node", () => {
    // A quick-tool graph, or a project whose script was removed: there is
    // nothing to rewrite, and an option that cannot act is worse than none.
    mount({ board: board(false) });
    fireEvent.click(screen.getByRole("button", { name: /whole video/i }));
    expect(screen.queryByRole("option", { name: /the script/i })).toBeNull();
  });

  it("is what the box is set to at the script checkpoint", () => {
    // Sitting at the gate with nothing else picked, what the box is FOR is
    // the script — the one thing the review is asking about.
    mount({
      currentProject: {
        id: "p1",
        title: "P",
        created_at: 0,
        mode: "beginner",
        approvals: [],
      },
    });
    expect(screen.getByRole("button", { name: /the script/i })).toBeInTheDocument();
  });

  it("still yields to a scene the user actually clicked", () => {
    mount({
      currentProject: {
        id: "p1",
        title: "P",
        created_at: 0,
        mode: "beginner",
        approvals: [],
      },
      selectedNode: "s1.clip",
    });
    expect(screen.getByRole("button", { name: /scene 1/i })).toBeInTheDocument();
  });
});

describe("rewriting from a note", () => {
  const scriptScope = (over: Record<string, unknown> = {}) => {
    mount(over);
    fireEvent.click(screen.getByRole("button", { name: /whole video/i }));
    fireEvent.click(screen.getByRole("option", { name: /the script/i }));
  };

  it("asks before it rewrites, and says what that replaces", async () => {
    // There is no dry run for a screenplay — the engine cannot say what a
    // rewritten one will contain without writing it. What CAN be previewed
    // is the cost, and the plan card beside this one set the expectation
    // that nothing typed here lands unannounced.
    const enhance = vi.fn().mockResolvedValue(null);
    scriptScope({ enhance });
    send("make it shorter and more urgent");

    const card = await screen.findByRole("group", { name: /rewrite the script/i });
    expect(card).toHaveTextContent(/every scene is rebuilt/i);
    expect(enhance).not.toHaveBeenCalled();
  });

  it("sends the note only once confirmed", async () => {
    const enhance = vi.fn().mockResolvedValue(null);
    scriptScope({ enhance });
    send("make it shorter and more urgent");
    fireEvent.click(await screen.findByRole("button", { name: /rewrite script/i }));

    await waitFor(() => expect(enhance).toHaveBeenCalledWith("make it shorter and more urgent"));
  });

  it("drops the ask on discard without touching the engine", async () => {
    const enhance = vi.fn();
    scriptScope({ enhance });
    send("make it shorter");
    fireEvent.click(await screen.findByRole("button", { name: /discard/i }));

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /rewrite the script/i })).toBeNull(),
    );
    expect(enhance).not.toHaveBeenCalled();
  });

  it("reports a refusal instead of reading as done", async () => {
    const enhance = vi.fn().mockResolvedValue("the engine could not be reached");
    scriptScope({ enhance });
    send("make it shorter");
    fireEvent.click(await screen.findByRole("button", { name: /rewrite script/i }));

    expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
  });

  it("never routes a script note through the edit planner", async () => {
    // The plan path compiles against the whitelisted view, which does not
    // contain the script — a note sent there would silently do nothing, or
    // rewrite a scene the user was not talking about.
    const proposeEdit = vi.fn();
    const enhance = vi.fn().mockResolvedValue(null);
    scriptScope({ enhance, proposeEdit });
    send("make it shorter");
    fireEvent.click(await screen.findByRole("button", { name: /rewrite script/i }));

    await waitFor(() => expect(enhance).toHaveBeenCalled());
    expect(proposeEdit).not.toHaveBeenCalled();
  });
});
