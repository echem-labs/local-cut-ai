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

/** `recorded` mirrors what the engine does: the real `edit` action awaits a
 * board refresh (which re-reads /history) before it resolves, so by the time
 * the reply is on screen the store already knows whether a snapshot was
 * pushed. Only a mutation that actually changed the graph pushes one. */
function mount(result: EditResult, recorded = false) {
  edit = vi.fn().mockImplementation(() => {
    if (recorded) {
      useApp.setState({
        history: {
          ...AFTER_AN_EDIT,
          undo_depth: 2,
          undo_top: { kind: "edit", summary: result.summary, node_id: null },
        },
      } as never);
    }
    return Promise.resolve(result);
  });
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
    mount({ summary: "made it night", ops: 1, dirty: ["s1.clip"], warnings: [] }, true);
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

  it("does not offer Undo when ops were compiled but nothing was recorded", async () => {
    // A plan can emit ops that leave the graph byte-identical — an LLM
    // echoing a prompt back unchanged is the ordinary case — and the engine
    // then pushes no snapshot at all. The reply still reads as a success,
    // so `ops > 0` offered Undo for an edit the history does not contain,
    // and clicking it reverted the previous, unrelated one.
    mount({ summary: "made it night", ops: 1, dirty: ["s1.clip"], warnings: [] }, false);
    await submit("make it night");

    await screen.findByText(/made it night/i);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    expect(undoEdit).not.toHaveBeenCalled();
  });
});
