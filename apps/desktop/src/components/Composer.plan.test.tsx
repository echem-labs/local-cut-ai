/**
 * Propose, then apply.
 *
 * A sentence typed into the composer used to rewrite the project on Enter.
 * The only way to learn what it had done was to read the reply afterwards
 * and reach for Undo — and Undo is not offered when the plan compiled ops
 * that left the graph byte-identical, so "what just happened" could be
 * genuinely unanswerable.
 *
 * The engine has always been able to compile a plan and report it without
 * committing: `dry_run` saves nothing, enqueues nothing, records no history
 * entry and fires no event. So the plan is shown first.
 *
 * The stale case is the one worth pinning. A preview describes a specific
 * graph revision; the CLI, the MCP server or a second window can move the
 * project while the card is on screen. Applying then would land ops
 * compiled against a graph that no longer exists, which is exactly what the
 * revision round trip refuses with a 409.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EngineError } from "../api/client";
import type { Board, EditProposal, NodeState } from "../api/types";
import { Composer } from "./Composer";
import { useApp } from "../store";

const node = (id: string): NodeState =>
  ({
    node_id: id,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: "a".repeat(64),
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const BOARD = {
  scenes: [
    { scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null },
  ],
  aux: {},
} as unknown as Board;

const proposal = (overrides: Partial<EditProposal> = {}): EditProposal => ({
  summary: "make scene 1 night",
  plan: { summary: "make scene 1 night", edits: [] },
  revision: "rev-1",
  ops: 2,
  planned: [],
  dirty: ["s1.clip", "s1.keyframe"],
  warnings: [],
  ...overrides,
});

const mount = (overrides: Record<string, unknown>) => {
  useApp.setState({
    board: BOARD,
    currentProject: { id: "p1", title: "P", created_at: 0, mode: "prompt", approvals: [] },
    history: { undo_depth: 0, redo_depth: 0, undo_top: null, redo_top: null, savepoints: [] },
    selectedNode: null,
    editBusy: false,
    ...overrides,
  } as never);
  render(<Composer />);
};

const send = (text: string) => {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ board: null, currentProject: null, history: null } as never);
});

describe("sending an instruction", () => {
  it("proposes without applying", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi.fn();
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    await screen.findByRole("group", { name: /proposed edit/i });
    expect(applyEditPlan).not.toHaveBeenCalled();
  });

  it("says how much it would change, and to what", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    mount({ proposeEdit, applyEditPlan: vi.fn() });

    send("make scene 1 night");
    const card = await screen.findByRole("group", { name: /proposed edit/i });
    expect(card).toHaveTextContent(/2 changes/i);
    expect(card).toHaveTextContent(/re-renders 2 things/i);
  });

  it("shows the ops the compiler refused", async () => {
    // Warnings are ops that will NOT land, so they are part of what Apply
    // means rather than an aside to read afterwards.
    const proposeEdit = vi
      .fn()
      .mockResolvedValue(proposal({ warnings: ["unknown node s9.clip"] }));
    mount({ proposeEdit, applyEditPlan: vi.fn() });

    send("make scene 9 night");
    expect(await screen.findByText(/unknown node s9\.clip/)).toBeInTheDocument();
  });

  it("answers directly when the plan would do nothing", async () => {
    // Nothing to apply, so no card: an Apply button that changes nothing is
    // worse than a sentence saying so.
    const proposeEdit = vi.fn().mockResolvedValue(proposal({ ops: 0, dirty: [], warnings: [] }));
    mount({ proposeEdit, applyEditPlan: vi.fn() });

    send("do something impossible");
    await screen.findByText(/no changes made/i);
    expect(screen.queryByRole("group", { name: /proposed edit/i })).toBeNull();
  });
});

describe("acting on the proposal", () => {
  it("sends the plan and the revision it was built against", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi
      .fn()
      .mockResolvedValue({ summary: "made it night", ops: 2, dirty: ["s1.clip"], warnings: [] });
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(applyEditPlan).toHaveBeenCalled());
    expect(applyEditPlan.mock.calls[0][0]).toMatchObject({ revision: "rev-1" });
  });

  it("puts the card away once it has landed", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi
      .fn()
      .mockResolvedValue({ summary: "made it night", ops: 2, dirty: ["s1.clip"], warnings: [] });
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /proposed edit/i })).toBeNull(),
    );
  });

  it("discards without touching the engine", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi.fn();
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    fireEvent.click(await screen.findByRole("button", { name: /discard/i }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /proposed edit/i })).toBeNull(),
    );
    expect(applyEditPlan).not.toHaveBeenCalled();
  });
});

describe("a plan the project has moved past", () => {
  it("drops it and says why, rather than reporting a bare 409", async () => {
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi
      .fn()
      .mockRejectedValue(
        new EngineError(409, "engine 409: the project changed while the edit was being generated"),
      );
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));

    expect(await screen.findByText(/send the instruction again/i)).toBeInTheDocument();
    // The card is gone: it describes a graph that no longer exists, so
    // leaving Apply on screen would invite the same refusal forever.
    expect(screen.queryByRole("group", { name: /proposed edit/i })).toBeNull();
  });

  it("keeps the card up for a failure that is not staleness", async () => {
    // A 502 from the engine's own upstream is worth retrying as-is — the
    // plan is still valid, so throwing it away would cost an LLM round trip
    // for nothing.
    const proposeEdit = vi.fn().mockResolvedValue(proposal());
    const applyEditPlan = vi
      .fn()
      .mockRejectedValue(new EngineError(502, "engine 502: upstream said no"));
    mount({ proposeEdit, applyEditPlan });

    send("make scene 1 night");
    fireEvent.click(await screen.findByRole("button", { name: /^apply$/i }));

    expect(await screen.findByText(/upstream said no/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /proposed edit/i })).toBeInTheDocument();
  });
});
