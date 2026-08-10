/**
 * What the taskbar and the window title are allowed to claim.
 *
 * These two report to someone who is not looking at the app, so the failures
 * that matter are the ones that keep claiming after the truth changed: a bar
 * left at 40% by an engine that died, and a denominator taken from a job
 * history that grows with every render.
 */
import { describe, expect, it } from "vitest";

import type { Board, Job, NodeState, NodeStatus } from "../api/types";
import { shellProgress } from "./shellProgress";

const node = (status: NodeStatus): NodeState => ({ status }) as NodeState;

/** A board of `statuses.length` scene clips. */
const boardOf = (statuses: NodeStatus[]): Board =>
  ({
    scenes: statuses.map((status) => ({ clip: node(status) })),
    aux: {},
  }) as unknown as Board;

const job = (status: Job["status"], progress = 0): Job =>
  ({ status, progress, spec: { node_id: "n", kind: "clip" } }) as Job;

describe("what the shell is told about a render", () => {
  it("says nothing at all when the queue is empty", () => {
    // Not the same as "0%": an idle app must clear the bar, not draw one at
    // the left edge.
    const board = boardOf(["final", "queued"]);
    expect(shellProgress(board, [job("done")])).toBeNull();
  });

  it("stays quiet when the board promises work the queue is not doing", () => {
    // The stalled case. Nodes read `queued` because an engine died mid-run;
    // nothing is coming, and a bar frozen part-way is worse than no bar.
    const board = boardOf(["final", "queued", "queued"]);
    expect(shellProgress(board, [])).toBeNull();
  });

  it("counts the whole board, not the job history", () => {
    // `/jobs` carries every render this project ever had, so a denominator
    // taken from it would read as nearly finished before this run began.
    const board = boardOf(["final", "final", "queued", "queued"]);
    const history = [job("done"), job("done"), job("done"), job("rendering")];
    expect(shellProgress(board, history)).toMatchObject({ done: 2, total: 4 });
  });

  it("moves while a single node renders instead of sitting at zero", () => {
    // A one-node tool render would otherwise show 0% for its whole life and
    // then disappear, which reads as nothing having happened.
    const board = boardOf(["rendering"]);
    expect(shellProgress(board, [job("rendering", 0.5)])?.fraction).toBe(0.5);
  });

  it("does not count a rendering node twice", () => {
    const board = boardOf(["final", "rendering"]);
    const progress = shellProgress(board, [job("rendering", 1)]);
    expect(progress?.fraction).toBe(1);
    expect(progress?.done).toBe(1);
  });

  it("leaves a blocked node out of the done count", () => {
    // status.ts: `blocked` is settled but NOT done — it waits on a person and
    // produced nothing, so reporting it as finished would tick a ✓ for work
    // that never happened.
    const board = boardOf(["final", "blocked", "queued"]);
    expect(shellProgress(board, [job("queued")])).toMatchObject({ done: 1, total: 3 });
  });

  it("counts a skipped node as done, because nothing is coming for it", () => {
    // The other half of the same rule: skipped produces nothing but the
    // compiler deliberately never enqueues it, so the render really is that
    // much further along.
    const board = boardOf(["skipped", "queued"]);
    expect(shellProgress(board, [job("queued")])).toMatchObject({ done: 1, total: 2 });
  });

  it("never reports more than finished, whatever the engine says", () => {
    const board = boardOf(["final", "rendering"]);
    expect(shellProgress(board, [job("rendering", 99)])?.fraction).toBe(1);
  });
});
