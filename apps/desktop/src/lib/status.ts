import type { NodeStatus } from "../api/types";

/**
 * Statuses that mean "this node is not waiting on anything".
 *
 * The distinction that matters is *pending vs not*, which is not the same as
 * *has an artifact*: `skipped` produces nothing, but nothing is coming either
 * — the compiler deliberately never enqueues it. Anything that waits for a
 * node to settle has to count it, or it waits forever.
 *
 * Two copies of this list already existed (the checkpoint banner and the tool
 * session) and both read `["draft", "final", "pinned"]`, so a scene
 * conditioned on an uploaded image left the storyboard checkpoint
 * unreachable: its keyframe is skipped, never becomes ready, and the approve
 * button that unblocks beginner mode never appears.
 */
export const SETTLED: readonly NodeStatus[] = ["draft", "final", "pinned", "skipped"];

export const isSettled = (status: NodeStatus): boolean => SETTLED.includes(status);

/** A node the engine will never produce an artifact for, by design. */
export const isSkipped = (status: NodeStatus): boolean => status === "skipped";
