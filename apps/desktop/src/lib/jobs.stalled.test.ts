/**
 * When the board is promising work the queue will never deliver.
 *
 * A node reading `queued` or `rendering` is a promise that something is
 * coming. Kill the engine mid-render, or reconnect to one that restarted,
 * and the promise outlives the queue that backed it: the project sits
 * looking busy forever. Nothing polls it back to life, and an empty `/patch`
 * does not either — the engine re-plans only when an op dirtied something,
 * so with no edit to make there is no route back into flight at all.
 */
import { describe, expect, it } from "vitest";

import type { Board, Job, NodeState } from "../api/types";
import { isStalled } from "./jobs";

const node = (id: string, status: string): NodeState =>
  ({
    node_id: id,
    status,
    progress: 0,
    error: null,
    artifact_hash: null,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const board = (clip: string, aux: Record<string, string> = {}): Board =>
  ({
    scenes: [
      {
        scene_id: "s1",
        keyframe: node("s1.keyframe", "draft"),
        clip: node("s1.clip", clip),
        narration: node("s1.narration", "draft"),
      },
    ],
    aux: Object.fromEntries(
      Object.entries(aux).map(([id, status]) => [id, node(id, status)]),
    ),
    assembled_durations: {},
  }) as unknown as Board;

const job = (status: string): Job =>
  ({ id: "j1", project_id: "p1", status, created_at: 1, spec: { node_id: "s1.clip", kind: "clip" } }) as unknown as Job;

describe("a board waiting on a queue that is not there", () => {
  it("is stalled when a queued node has no job behind it", () => {
    expect(isStalled(board("queued"), [])).toBe(true);
  });

  it("is stalled when a node claims to be rendering and nothing is", () => {
    // The worst version: a progress bar that will never move again.
    expect(isStalled(board("rendering"), [job("done")])).toBe(true);
  });

  it("is not stalled while the queue still holds the work", () => {
    expect(isStalled(board("queued"), [job("queued")])).toBe(false);
    expect(isStalled(board("rendering"), [job("rendering")])).toBe(false);
  });

  it("is not stalled when nothing was promised", () => {
    // Everything settled: there is no outstanding claim to be stale.
    expect(isStalled(board("draft"), [])).toBe(false);
  });

  it("does not treat a failure as a stall", () => {
    // Nothing is coming for a failed node either — but that is the truth,
    // not a stale promise. Offering "resume" on every failure would make the
    // offer meaningless where it means something.
    expect(isStalled(board("failed"), [])).toBe(false);
    expect(isStalled(board("cancelled"), [])).toBe(false);
  });

  it("counts an aux node, not only the scene grid", () => {
    // The timeline and the export are exactly the nodes a killed engine
    // leaves half-done, and neither is in board.scenes.
    expect(isStalled(board("draft", { timeline: "rendering" }), [])).toBe(true);
  });

  it("says nothing about a project that is not open", () => {
    expect(isStalled(null, [])).toBe(false);
  });
});
