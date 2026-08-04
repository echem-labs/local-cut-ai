import type { Job, Project } from "../api/types";
import { newestJob } from "./jobs";
import { isToolSession } from "./tools";

export type TileStatus = "generating" | "failed" | "ready" | "final" | "draft";

/** Tile status from the global queue: active work wins, then a trailing
 * failure, then a finished output, else draft. Shared by the Library, Home's
 * Continue shelf and the rail's open-project tabs so every status dot in the
 * app agrees — the single status oracle (plan doc 11, U2).
 *
 * A quick tool has no export stage — `tool_graph` names its terminal node
 * for the tool itself — so the export rule below never matched and every
 * finished one-off read "Draft" beside its own download link. Tool sessions
 * settle at "ready" rather than "final": "Final" is a claim about a cut, and
 * a voiceover is not a cut. */
export function tileStatus(project: Project, allJobs: Job[]): TileStatus {
  const jobs = allJobs.filter((job) => job.project_id === project.id);
  if (jobs.some((job) => job.status === "queued" || job.status === "rendering")) {
    return "generating";
  }
  const newest = newestJob(jobs);
  if (newest?.status === "failed") return "failed";
  if (isToolSession(project)) {
    // The engine's record, and ONLY that. Two reasons it beats the job list.
    //
    // Reach: `allJobs` is the newest 200 rows across ALL projects, so an old
    // session's rows have aged out behind a couple of full renders — and
    // history is made of exactly those old sessions.
    //
    // Meaning: a DONE row is not the same claim as "there is an artifact".
    // The engine derives this field through the trusted artifact cache, so a
    // placeholder rendered by a fallback tier and since distrusted has no
    // hash here while its DONE row is still in the window. Reading the row
    // would paint a green "Ready" tile that opens on a queued session with
    // nothing to download — two sources disagreeing, which is the whole
    // thing this field exists to stop.
    return project.tool_artifact_hash ? "ready" : "draft";
  }
  if (jobs.some((job) => job.spec.node_id === "export" && job.status === "done")) return "final";
  return "draft";
}
