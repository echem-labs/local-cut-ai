/** The Undo offered beside a composer reply.
 *
 * An NL edit that compiles to no ops records no history entry, so the
 * newest recorded mutation stays whatever came before it. Offering Undo on
 * that reply reverted the EARLIER edit while the text on screen said "No
 * changes made" — the button has to belong to the reply it sits under.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, EditResult, NodeState } from "../api/types";
import { Composer } from "./Composer";
import { useApp } from "../store";

const node = (id: string): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const BOARD: Board = {
  scenes: [{ scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null }],
  aux: {},
};

/** An edit already recorded in history — the state after any applying edit. */
const AFTER_AN_EDIT = {
  undo_depth: 1,
  redo_depth: 0,
  undo_top: { kind: "edit", summary: "earlier edit", node_id: null },
  redo_top: null,
  savepoints: [],
};

let edit: ReturnType<typeof vi.fn>;
let undoEdit: ReturnType<typeof vi.fn>;

function mount(result: EditResult) {
  edit = vi.fn().mockResolvedValue(result);
  undoEdit = vi.fn().mockResolvedValue(null);
  useApp.setState({
    board: BOARD,
    currentProject: { id: "p1", title: "P", created_at: 0, mode: "prompt", approvals: [] },
    history: AFTER_AN_EDIT,
    selectedNode: null,
    editBusy: false,
    edit,
    undoEdit,
  } as never);
  render(<Composer />);
}

async function submit(text: string) {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(edit).toHaveBeenCalled());
}

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ board: null, currentProject: null, history: null } as never);
});

describe("composer reply Undo", () => {
  it("offers Undo when the edit actually changed something", async () => {
    mount({ summary: "made it night", ops: 1, dirty: ["s1.clip"], warnings: [] });
    await submit("make it night");

    const undo = await screen.findByRole("button", { name: /undo/i });
    fireEvent.click(undo);
    expect(undoEdit).toHaveBeenCalled();
  });

  it("does not offer Undo for a reply that changed nothing", async () => {
    // The regression: history still reports an edit-shaped undo_top from
    // the EARLIER edit, so a check on history alone showed the button.
    mount({ summary: "nothing applied", ops: 0, dirty: [], warnings: [] });
    await submit("do something impossible");

    await screen.findByText(/no changes made/i);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    expect(undoEdit).not.toHaveBeenCalled();
  });
});
