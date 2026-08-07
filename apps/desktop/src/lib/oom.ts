import type { Job, ModelRow, NodeState } from "../api/types";

/**
 * What the engine's three OOM suggestions mean in terms this app can act on.
 *
 * `scheduler.py` publishes `["lower_resolution", "smaller_model", "cloud"]`
 * when the fallback ladder is exhausted, with the comment "the UI renders
 * this as choices, not an error code" — so each one has to become a control
 * that does the thing it names, or say plainly that it cannot.
 */

/** The scales the "render this smaller" chip walks down. The engine's own
 * ladder explores 0.75 and 0.5 WITHIN one render; these are graph-level, so
 * they start below where that ladder already failed and give it new ground
 * (its rungs are ceilings, so a graph at 0.5 keeps the ladder at 0.5). */
const SCALE_STEPS = [0.5, 0.25] as const;

/** The next scale below the one a node is already asking for, or null at the
 * floor. Below 0.25 a video is too small to judge, so the honest answer
 * becomes "this machine cannot render this", not a smaller number. */
export function nextResolutionScale(current: unknown): number | null {
  const now = typeof current === "number" && current > 0 ? current : 1;
  return SCALE_STEPS.find((step) => step < now - 1e-9) ?? null;
}

/**
 * Manifest tasks able to serve the node behind an id — the desktop's mirror
 * of the engine's `COMFY_TASKS`. Derived from the id because that is what
 * every other consumer here does (`NodeState` carries no kind), and pinned
 * against the engine by `test_ui_contract.py`: a task string that drifts
 * makes the smaller-model chip silently offer nothing.
 */
export function tasksForNode(nodeId: string): string[] {
  if (/\.clip\d*$/.test(nodeId)) return ["video.i2v", "video.t2v"];
  if (nodeId.endsWith(".keyframe")) return ["image.gen"];
  if (nodeId === "thumbnail") return ["image.gen"];
  if (nodeId === "music") return ["music.gen"];
  return [];
}

/** The model the failed render actually used. `Job.model` is what the backend
 * reported; `NodeState.model` is only the request, and is usually null
 * ("whatever the backend is configured with"), so the job is the better
 * source and the node the fallback. */
export function modelThatFailed(
  nodeId: string,
  jobs: Job[],
  node: NodeState | undefined,
): string | null {
  const failed = jobs.filter((job) => job.spec.node_id === nodeId && job.status === "failed");
  const latest = failed.reduce<Job | null>(
    (best, job) => (best === null || job.created_at > best.created_at ? job : best),
    null,
  );
  return latest?.model ?? node?.model ?? null;
}

/**
 * The best installed model for this node that needs less VRAM than the one
 * that just ran out of it, or null when there is nothing smaller to offer.
 *
 * "Best", not "smallest": dropping straight to the least capable model
 * available is a bigger quality loss than the failure requires. Only
 * downloaded models count — offering a model the user would have to fetch
 * first is not a one-click answer to a failed render.
 */
export function smallerModelFor(
  nodeId: string,
  models: ModelRow[],
  failedModelId: string | null,
): ModelRow | null {
  const tasks = new Set(tasksForNode(nodeId));
  if (tasks.size === 0) return null;
  const candidates = models.filter((model) => tasks.has(model.task) && model.downloaded);
  const failed = failedModelId
    ? (models.find((model) => model.id === failedModelId) ?? null)
    : null;
  // With no identifiable failed model there is no "smaller than" to measure
  // against, so every installed candidate qualifies and the ranking below
  // picks the best of them — still a real choice, just not a comparison.
  const ceiling = failed?.requirements.vram_gb ?? Infinity;
  const smaller = candidates.filter(
    (model) => model.id !== failedModelId && model.requirements.vram_gb < ceiling,
  );
  if (smaller.length === 0) return null;
  return smaller.reduce((best, model) =>
    model.quality_score !== best.quality_score
      ? model.quality_score > best.quality_score
        ? model
        : best
      : // Tie on quality: prefer the lighter one, then by id so the answer is
        // the same on every machine (code-unit order, per the layout rule).
        model.requirements.vram_gb !== best.requirements.vram_gb
        ? model.requirements.vram_gb < best.requirements.vram_gb
          ? model
          : best
        : model.id < best.id
          ? model
          : best,
  );
}
