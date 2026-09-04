/**
 * A file dropped on a scene card is not a request to reorder the board.
 *
 * The card is draggable so scenes can be rearranged, and its `onDrop` acted
 * on every drop it received. A drag carrying FILES is the other kind
 * entirely — it comes from outside the window and means "use this image
 * here" — but it arrived at the same handler and was read as a reorder, so
 * dropping a photo on scene 3 silently moved a scene instead.
 *
 * React's handler runs before the window-level listener that owns file
 * drops, so the card is the surface that has to tell them apart. It does so
 * by the drag's own types, not by what it later turns out to carry:
 * `dataTransfer.files` is empty until the drop, so `dragover` has nothing
 * else to go on and the drop must agree with what dragover decided.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NodeState, NodeStatus, SceneCardModel } from "../api/types";
import { SceneCard } from "./SceneCard";
import { useApp } from "../store";

const node = (id: string, s: NodeStatus): NodeState => ({
  node_id: id, status: s, progress: 1, error: null, artifact_hash: null,
  params: {}, seed: 0, model: null, pinned: false,
});

const scene: SceneCardModel = {
  scene_id: "s1",
  keyframe: node("s1.keyframe", "draft"),
  clip: node("s1.clip", "draft"),
  narration: node("s1.narration", "draft"),
};

/** A DataTransfer as each kind of drag presents it. Files are unreadable
 *  until the drop, which is exactly why `types` is the thing to test. */
const fileDrag = { types: ["Files"], files: [], items: [{ type: "image/png" }] };
const cardDrag = { types: ["text/plain"], files: [], items: [] };

function mount() {
  useApp.setState({
    board: { scenes: [scene], aux: {}, assembled_durations: { s1: 4 } },
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
    selectedNode: null,
    select: vi.fn(), regenerate: vi.fn().mockResolvedValue(null), togglePin: vi.fn().mockResolvedValue(null),
    applyNode: vi.fn().mockResolvedValue(null), playScene: vi.fn(),
  } as never);
}

describe("a file dropped on a scene card", () => {
  it("does not reorder the board", () => {
    const onDropSide = vi.fn();
    mount();
    render(<SceneCard scene={scene} onDropSide={onDropSide} onDragStart={vi.fn()} />);
    const card = screen.getByRole("group");

    fireEvent.dragOver(card, { dataTransfer: fileDrag });
    fireEvent.drop(card, { dataTransfer: fileDrag });

    expect(onDropSide).not.toHaveBeenCalled();
  });

  it("leaves the drop for the window listener that owns files", () => {
    // The card must not consume it either: preventing the default here is
    // what tells the browser the card handled it, and the file surface
    // would then never hear the drop it exists for.
    const onDropSide = vi.fn();
    mount();
    render(<SceneCard scene={scene} onDropSide={onDropSide} onDragStart={vi.fn()} />);
    const card = screen.getByRole("group");

    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: fileDrag });
    card.dispatchEvent(over);

    expect(over.defaultPrevented).toBe(false);
  });

  it("still reorders when the drag is another card", () => {
    // The guard must not cost the board its own drag-to-reorder.
    const onDropSide = vi.fn();
    mount();
    render(<SceneCard scene={scene} onDropSide={onDropSide} onDragStart={vi.fn()} />);
    const card = screen.getByRole("group");

    fireEvent.dragOver(card, { dataTransfer: cardDrag });
    fireEvent.drop(card, { dataTransfer: cardDrag });

    expect(onDropSide).toHaveBeenCalledTimes(1);
  });
});
