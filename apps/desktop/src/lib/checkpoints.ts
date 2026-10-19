import type { Board, Checkpoint, NodeState, Project, SceneCardModel } from "../api/types";
import { isSettled } from "./status";

/**
 * The beginner-mode gate this project is sitting at, or null.
 *
 * A checkpoint is the one state where the engine is deliberately holding
 * work: `_checkpoint_open` refuses to enqueue anything past an unapproved
 * gate, so no job backs any node behind one. Current engines say so with
 * `held`, but an engine that predates it reports those nodes as `queued`,
 * which from the board alone is indistinguishable from a project whose
 * queue was lost. Anything that reasons about "the queue is not delivering"
 * still has to ask this first.
 *
 * A stage appears only once its inputs have settled, which is what makes it
 * a safe answer to that question. Work the gate has already RELEASED that
 * subsequently lost its queue leaves the upstream unready, so no stage is
 * reported and the stall is still seen — the suppression covers the gate,
 * not the whole of beginner mode.
 */
export function pendingCheckpoint(
  project: Pick<Project, "mode" | "approvals"> | null,
  board: Board | null,
): Checkpoint | null {
  if (!project || project.mode !== "beginner" || !board) return null;
  const approvals = project.approvals ?? [];
  if (!approvals.includes("script")) {
    return board.aux.script && isSettled(board.aux.script.status) ? "script" : null;
  }
  if (approvals.includes("storyboard")) return null;
  // A skipped keyframe counts as ready: the scene is conditioned on an
  // uploaded image, so no keyframe is coming. Waiting for one leaves the
  // storyboard checkpoint — and with it all of beginner mode — unreachable.
  const keyframesReady =
    board.scenes.length > 0 &&
    board.scenes.every((scene) => !scene.keyframe || isSettled(scene.keyframe.status));
  return keyframesReady ? "storyboard" : null;
}

/**
 * What a scene's new take re-rolls: its clip, except while the clip is held
 * behind the storyboard checkpoint. There the generated keyframe is the
 * picture under review, and the clip has no job until the storyboard is
 * approved, so a new take of the clip changes a seed nothing has rendered
 * and nothing on screen moves. A scene built from the user's own picture has
 * no keyframe to re-roll, and at the script checkpoint the keyframe is held
 * too, so both keep the clip.
 */
export function newTakeNode(scene: SceneCardModel): NodeState {
  const keyframe = scene.keyframe;
  if (scene.clip.status !== "held" || scene.still || !keyframe) return scene.clip;
  return keyframe.status === "held" ? scene.clip : keyframe;
}
