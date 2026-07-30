import type { NodeStatus } from "../api/types";

/**
 * Statuses that mean "this node is not waiting on anything".
 *
 * The distinction that matters is *pending vs not*, which is not the same as
 * *has an artifact*: `skipped` produces nothing, but nothing is coming either
 * — the compiler deliberately never enqueues it. Anything that waits for a
 * node to settle has to count it, or it waits forever.
 *
 * Three copies of this list already existed (the checkpoint banner, the tool
 * session and the project header) and all read `["draft", "final", "pinned"]`,
 * so a scene conditioned on an uploaded image left the storyboard checkpoint
 * unreachable: its keyframe is skipped, never becomes ready, and the approve
 * button that unblocks beginner mode never appears. Every one of them now
 * imports this — a fourth copy is how the two halves of the gate came to
 * disagree in the first place.
 */
export const SETTLED: readonly NodeStatus[] = [
  "draft",
  "final",
  "pinned",
  "skipped",
  // `blocked` counts for the same reason `skipped` does, and it is the same
  // bug if it does not: the compiler never enqueues it, so a gate that waits
  // for it waits forever. It is pending on a person, not on the queue — and
  // the board says so in the tile, which is where that belongs.
  "blocked",
];

export const isSettled = (status: NodeStatus): boolean => SETTLED.includes(status);
