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

/**
 * Statuses that mean "this node produced what it was going to produce".
 *
 * SETTLED answers a different question — *is anything still coming from the
 * queue* — and `blocked` is the one status where the two answers differ.
 * `skipped` is settled AND done: the scene is conditioned on an uploaded
 * image, so the storyboard really is finished. `blocked` is settled and NOT
 * done: nothing is coming, but nothing was made either, because the node is
 * waiting on a person.
 *
 * Ask isSettled when a gate must not hang on work that will never arrive.
 * Ask this when the answer is REPORTED as completion — a ✓, a done count, a
 * "Create final video" button. Adding `blocked` to SETTLED alone made the
 * project header tick the Export stage green for a project whose export
 * cannot be assembled, and offer a primary action that enqueues nothing and
 * so appears to do nothing at all.
 */
export const isDone = (status: NodeStatus): boolean => isSettled(status) && status !== "blocked";
