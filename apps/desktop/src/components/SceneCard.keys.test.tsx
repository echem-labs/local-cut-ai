import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("the card's shortcut keys", () => {
  it("do not fire from a control inside the card", async () => {
    const regenerate = vi.fn().mockResolvedValue(null);
    const togglePin = vi.fn().mockResolvedValue(null);
    const select = vi.fn();
    useApp.setState({
      board: { scenes: [scene], aux: {}, assembled_durations: { s1: 4 } },
      currentProject: { id: "p1", title: "t", approvals: [] },
      client: { artifactUrl: () => "" }, selectedNode: null,
      select, regenerate, togglePin, applyNode: vi.fn().mockResolvedValue(null), playScene: vi.fn(),
    } as never);
    render(<SceneCard scene={scene} />);

    screen.getByRole("button", { name: /^scene 1$/i }).focus();
    await userEvent.keyboard("r");
    await userEvent.keyboard("p");
    expect(regenerate).not.toHaveBeenCalled();
    expect(togglePin).not.toHaveBeenCalled();

    select.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("the card's own shortcut keys", () => {
  it("still fire when the card itself has focus", async () => {
    const regenerate = vi.fn().mockResolvedValue(null);
    const togglePin = vi.fn().mockResolvedValue(null);
    const select = vi.fn();
    useApp.setState({
      board: { scenes: [scene], aux: {}, assembled_durations: { s1: 4 } },
      currentProject: { id: "p1", title: "t", approvals: [] },
      client: { artifactUrl: () => "" }, selectedNode: null,
      select, regenerate, togglePin, applyNode: vi.fn().mockResolvedValue(null), playScene: vi.fn(),
    } as never);
    const { container } = render(<SceneCard scene={scene} />);

    (container.querySelector(".scene-card") as HTMLElement).focus();
    await userEvent.keyboard("r");
    await userEvent.keyboard("p");
    expect(regenerate).toHaveBeenCalledWith("s1.clip");
    expect(togglePin).toHaveBeenCalledWith("s1.clip", true);
  });
});
