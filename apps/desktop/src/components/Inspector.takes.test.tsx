/** The Inspector's takes row: alternate versions a regenerate displaced.
 * Chips appear only when there is more than one identity to choose from,
 * the current one is marked and inert, and clicking another sends the
 * select_take patch through the store. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, TakeInfo } from "../api/types";
import { Inspector } from "./Inspector";
import { useApp } from "../store";

const take = (hash: string, current: boolean, available = true): TakeInfo => ({
  output_hash: hash,
  seed: 1,
  at: current ? null : 1,
  available,
  current,
});

const node = (id: string, takes?: TakeInfo[]): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  takes,
});

const boardWith = (takes?: TakeInfo[]): Board => ({
  scenes: [
    { scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip", takes), narration: null },
  ],
  aux: {},
});

let selectTake: ReturnType<typeof vi.fn>;

function mount(takes?: TakeInfo[]) {
  selectTake = vi.fn().mockResolvedValue(null);
  useApp.setState({
    board: boardWith(takes),
    selectedNode: "s1.clip",
    selectTake,
  } as never);
  render(<Inspector />);
}

beforeEach(() => {
  useApp.setState({ board: null, selectedNode: null } as never);
});

describe("Inspector takes", () => {
  it("renders one chip per take with the current one pressed", () => {
    mount([take("a".repeat(64), false), take("b".repeat(64), true)]);
    const group = screen.getByRole("group", { name: /takes/i });
    const chips = group.querySelectorAll("button");
    expect(chips).toHaveLength(2);
    expect(chips[1]).toHaveAttribute("aria-pressed", "true");
    expect(chips[1]).toBeDisabled(); // the current take is not a destination
  });

  it("clicking another take sends its recorded hash", () => {
    mount([take("a".repeat(64), false), take("b".repeat(64), true)]);
    const group = screen.getByRole("group", { name: /takes/i });
    fireEvent.click(group.querySelectorAll("button")[0]!);
    expect(selectTake).toHaveBeenCalledWith("s1.clip", "a".repeat(64));
  });

  it("shows nothing until a node has an alternate to offer", () => {
    mount(undefined);
    expect(screen.queryByRole("group", { name: /takes/i })).toBeNull();
  });
});
