/**
 * What the scene card exposes to a screen reader.
 *
 * The card root was a `role="button"` wrapping every action the board has:
 * play, regenerate, pin, edit, the two choices on the failure ladder and the
 * inline narration editor. ARIA specifies the children of a `button` as
 * presentational, so all of them were hidden from assistive technology — the
 * whole card announced as one unlabelled control with nothing inside it,
 * however reachable each button stayed by Tab.
 *
 * NodeCanvas has the same shape (a clickable box whose ports are real
 * buttons) and resolves it the same way, with a test alongside this one.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NodeState, NodeStatus, SceneCardModel } from "../api/types";
import { SceneCard } from "./SceneCard";
import { useApp } from "../store";

const node = (id: string, nodeStatus: NodeStatus): NodeState => ({
  node_id: id,
  status: nodeStatus,
  progress: 1,
  error: nodeStatus === "failed" ? "the model ran out of memory" : null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const scene = (clip: NodeStatus): SceneCardModel => ({
  scene_id: "s1",
  keyframe: node("s1.keyframe", "draft"),
  clip: node("s1.clip", clip),
  narration: node("s1.narration", "draft"),
});

function mount(clip: NodeStatus = "draft") {
  const select = vi.fn();
  useApp.setState({
    board: { scenes: [scene(clip)], aux: {}, assembled_durations: { s1: 4 } },
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
    selectedNode: null,
    select,
    regenerate: vi.fn(),
    togglePin: vi.fn(),
    applyNode: vi.fn(),
    playScene: vi.fn(),
  } as never);
  render(<SceneCard scene={scene(clip)} />);
  return { select };
}

describe("the scene card's controls", () => {
  it("keeps every action outside a role=button ancestor", () => {
    mount();

    for (const control of screen.getAllByRole("button")) {
      // Its nearest button IS itself — nothing wraps it in another one.
      expect(control.closest("button")).toBe(control);
      expect(control.parentElement?.closest('[role="button"]')).toBeNull();
    }
  });

  it("keeps the failure ladder's choices reachable too", () => {
    mount("failed");

    const retry = screen.getByRole("button", { name: /try again/i });
    expect(retry.parentElement?.closest('[role="button"]')).toBeNull();
  });

  it("offers selecting the scene as a real control, not just a clickable box", async () => {
    const { select } = mount();

    const byName = screen.getByRole("button", { name: /^scene 1$/i });
    // A real <button>, not the card root wearing role="button" — which is
    // what this whole file exists to get rid of.
    expect(byName.tagName).toBe("BUTTON");
    byName.click();
    expect(select).toHaveBeenCalled();
  });
});
