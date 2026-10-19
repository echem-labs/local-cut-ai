/**
 * The beginner-mode checkpoint gate.
 *
 * This banner is the only way to approve a checkpoint, and it renders nothing
 * until every keyframe has settled. So any node status it does not recognise
 * as settled does not merely look wrong — it removes the approve button, and
 * beginner mode has no other way forward.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, NodeStatus, ReadinessRow } from "../api/types";
import { t } from "../i18n";
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

/** Script already approved, so the storyboard checkpoint is the one in play.
 * `mode` is part of the fixture because the stage is a function of it —
 * checkpoints exist only in beginner mode, and the stalled-project notice
 * asks the same question from a call site that has no mode gate above it. */
function mount(keyframe: NodeStatus | null) {
  useApp.setState({
    board: board(keyframe),
    currentProject: { id: "p1", title: "t", mode: "beginner", approvals: ["script"] },
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

/**
 * Approving a checkpoint is what releases the work held behind it, so it is
 * where the "Before you render" gate asks about that work: the keyframes,
 * narration and music behind the script, and the clips and the final video
 * behind the storyboard. A gap in a stage that has already run, or one still
 * held behind a later checkpoint, is not part of the answer.
 */
describe("approving a checkpoint with stages that are not ready", () => {
  const gap = (
    kind: string,
    reason: string,
    verdict: ReadinessRow["verdict"],
    task?: string,
  ): ReadinessRow => ({
    kind,
    model: null,
    backend: null,
    verdict,
    reason: reason as ReadinessRow["reason"],
    data: task ? { task } : {},
    fix: null,
  });
  const comfyuiDown = [
    gap("keyframe", "comfyui_down", "placeholder", "image.gen"),
    gap("music", "comfyui_down", "placeholder", "music.gen"),
  ];
  const noFfmpeg = [gap("export", "no_ffmpeg", "will_fail")];

  let approve: ReturnType<typeof vi.fn>;

  function atCheckpoint(approvals: string[], rows: ReadinessRow[], keyframe: NodeStatus | null) {
    approve = vi.fn(async () => {});
    useApp.setState({
      board: approvals.length === 0 ? { ...board(null), scenes: [] } : board(keyframe),
      currentProject: {
        id: `p-${approvals.length}-${rows.length}`,
        title: "t",
        mode: "beginner",
        approvals,
      },
      client: {
        projectReadiness: vi.fn(async () => ({ rows })),
        artifactUrl: () => "http://engine/artifact",
      },
      models: [],
      warnMissingModels: true,
      approve,
      actionError: null,
    } as never);
    return render(<CheckpointBanner />);
  }

  const click = async (name: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };
  const gate = () => screen.queryByRole("alertdialog", { name: t("readiness.dialog.title") });

  it("holds the script's approval while the stages it releases would be stand-ins", async () => {
    atCheckpoint([], comfyuiDown, null);
    await click(t("checkpoint.approveScript"));
    expect(gate()).not.toBeNull();
    expect(gate()).toHaveTextContent("Keyframes");
    expect(gate()).toHaveTextContent("Music");
    expect(approve).not.toHaveBeenCalled();
    await click(t("readiness.dialog.renderAnyway"));
    expect(approve).toHaveBeenCalledWith("script");
  });

  it("approves the script straight away when only later stages have gaps", async () => {
    atCheckpoint([], noFfmpeg, null);
    await click(t("checkpoint.approveScript"));
    expect(gate()).toBeNull();
    expect(approve).toHaveBeenCalledWith("script");
  });

  it("holds the storyboard's approval while the final video would fail", async () => {
    atCheckpoint(["script"], [...comfyuiDown, ...noFfmpeg], "draft");
    await click(t("checkpoint.approveStoryboard"));
    expect(gate()).not.toBeNull();
    expect(gate()).toHaveTextContent("Final video");
    // The keyframes and the music have already run.
    expect(gate()).not.toHaveTextContent("Keyframes");
    expect(approve).not.toHaveBeenCalled();
  });
});
