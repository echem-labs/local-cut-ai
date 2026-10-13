/**
 * `held`: a beginner project's work behind a checkpoint nobody has approved
 * yet.
 *
 * The engine will not enqueue it until the user approves, so there is no
 * job to report. The board used to fall through to `queued` for it, and
 * every scene card said "Queued" under a banner asking the user to review
 * the keyframes and approve. The engine now says `held`, and the card has
 * to know the word.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { NodeState, NodeStatus, SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { isDone, isSettled } from "../lib/status";
import { useApp } from "../store";
import { SceneCard } from "./SceneCard";

const node = (id: string, status: NodeStatus, params: Record<string, unknown> = {}): NodeState => ({
  node_id: id,
  status,
  progress: 0,
  error: null,
  artifact_hash: null,
  params,
  seed: 0,
  model: null,
  pinned: false,
});

/** The storyboard checkpoint: keyframe and narration rendered, clip held. */
const scene: SceneCardModel = {
  scene_id: "s1",
  keyframe: node("s1.keyframe", "draft"),
  clip: node("s1.clip", "held", { duration_s: 4 }),
  narration: node("s1.narration", "draft"),
};

function mount() {
  useApp.setState({
    board: { scenes: [scene], aux: {}, assembled_durations: {} },
    currentProject: { id: "p1", title: "t", mode: "beginner", approvals: ["script"] },
    client: null,
    selectedNode: null,
  } as never);
  render(<SceneCard scene={scene} />);
}

describe("a clip held by an unapproved checkpoint", () => {
  it("says it is waiting for approval, in the status colours", () => {
    mount();
    const pill = screen.getByRole("img", { name: t("status.held") });
    // A status the card does not know renders with no colour at all.
    expect(pill.style.color).not.toBe("");
  });

  it("shows its duration as planned, the way a queued clip does", () => {
    mount();
    expect(screen.getByText(t("scene.durQueued", { d: 4 }))).toBeInTheDocument();
  });

  it("is settled but not done", () => {
    // Settled: nothing is coming from the queue until the user acts, so a
    // gate that waits for it would wait forever. Not done: nothing was made.
    expect(isSettled("held")).toBe(true);
    expect(isDone("held")).toBe(false);
  });
});
