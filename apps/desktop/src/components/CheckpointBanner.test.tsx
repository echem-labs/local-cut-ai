/**
 * The beginner-mode checkpoint gate.
 *
 * This banner is the only way to approve a checkpoint, and it renders nothing
 * until every keyframe has settled. So any node status it does not recognise
 * as settled does not merely look wrong — it removes the approve button, and
 * beginner mode has no other way forward.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Board, NodeState, NodeStatus } from "../api/types";
import { CheckpointBanner } from "./CheckpointBanner";
import { useApp } from "../store";

const node = (id: string, status: NodeStatus): NodeState => ({
  node_id: id,
  status,
  progress: status === "rendering" ? 0.5 : 1,
  error: null,
  artifact_hash: status === "draft" || status === "final" ? "a".repeat(64) : null,
  params: {},
  seed: 0,
  model: null,
  pinned: status === "pinned",
});

const board = (keyframe: NodeStatus | null): Board => ({
  scenes: [
    {
      scene_id: "s1",
      keyframe: keyframe ? node("s1.keyframe", keyframe) : null,
      clip: node("s1.clip", "queued"),
      narration: null,
    },
  ],
  aux: { script: node("script", "draft") },
});

/** Script already approved, so the storyboard checkpoint is the one in play. */
function mount(keyframe: NodeStatus | null) {
  useApp.setState({
    board: board(keyframe),
    currentProject: { id: "p1", title: "t", approvals: ["script"] },
  } as never);
  return render(<CheckpointBanner />);
}

const approveButton = () => screen.queryByRole("button", { name: /approve|looks good|continue/i });

beforeEach(() => {
  useApp.setState({ board: null, currentProject: null } as never);
});

describe("the storyboard checkpoint", () => {
  it("waits while a keyframe is still rendering", () => {
    mount("rendering");
    expect(approveButton()).toBeNull();
  });

  it("appears once the keyframes are drafted", () => {
    mount("draft");
    expect(approveButton()).not.toBeNull();
  });

  it("appears when a keyframe was skipped, not just when one was rendered", () => {
    // The dead end: a scene conditioned on an uploaded image has no keyframe
    // coming, so a gate that waits for `draft` waits forever. The approve
    // button never renders and beginner mode has no other way forward.
    mount("skipped");
    expect(approveButton()).not.toBeNull();
  });

  it("appears for a scene with no keyframe node at all", () => {
    mount(null);
    expect(approveButton()).not.toBeNull();
  });
});
