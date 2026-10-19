/**
 * What a scene card's "new take" re-rolls. At the storyboard checkpoint the
 * keyframe is what is under review and the clip is held behind the approval,
 * with no job until the storyboard is approved. A new take of the clip there
 * changes a seed nothing has rendered, and nothing on screen moves.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { NodeState, NodeStatus, SceneCardModel } from "../api/types";
import { useApp } from "../store";
import { SceneCard } from "./SceneCard";

const node = (id: string, status: NodeStatus): NodeState => ({
  node_id: id,
  status,
  progress: 1,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

function cardFor(scene: SceneCardModel) {
  const regenerate = vi.fn().mockResolvedValue(null);
  useApp.setState({
    board: { scenes: [scene], aux: {}, assembled_durations: { s1: 4 } },
    currentProject: { id: "p1", title: "t", approvals: ["script"] },
    client: { artifactUrl: () => "" },
    selectedNode: null,
    select: vi.fn(),
    regenerate,
    togglePin: vi.fn().mockResolvedValue(null),
    applyNode: vi.fn().mockResolvedValue(null),
    playScene: vi.fn(),
  } as never);
  const view = render(<SceneCard scene={scene} />);
  return { regenerate, card: view.container.querySelector(".scene-card") as HTMLElement };
}

describe("a scene card's new take", () => {
  it("re-rolls the keyframe while the storyboard waits for approval", async () => {
    const { regenerate, card } = cardFor({
      scene_id: "s1",
      keyframe: node("s1.keyframe", "draft"),
      clip: node("s1.clip", "held"),
      narration: node("s1.narration", "draft"),
    });
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(regenerate).toHaveBeenLastCalledWith("s1.keyframe");

    card.focus();
    await userEvent.keyboard("r");
    expect(regenerate).toHaveBeenLastCalledWith("s1.keyframe");
  });

  it("re-rolls the clip once the clip can render", async () => {
    const { regenerate } = cardFor({
      scene_id: "s1",
      keyframe: node("s1.keyframe", "draft"),
      clip: node("s1.clip", "draft"),
      narration: node("s1.narration", "draft"),
    });
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(regenerate).toHaveBeenLastCalledWith("s1.clip");
  });

  it("leaves the keyframe alone when the scene is built from the user's own picture", async () => {
    const { regenerate } = cardFor({
      scene_id: "s1",
      keyframe: node("s1.keyframe", "skipped"),
      still: node("asset_1", "draft"),
      clip: node("s1.clip", "held"),
      narration: node("s1.narration", "draft"),
    });
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(regenerate).toHaveBeenLastCalledWith("s1.clip");
  });
});
