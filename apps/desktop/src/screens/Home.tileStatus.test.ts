import { describe, expect, it } from "vitest";

import { isToolSession, tileStatus, toolKindOf } from "./Home";
import type { Job, Project } from "../api/types";

/**
 * A quick tool session has no export stage — its artifact is the output of
 * the single node named for the tool. `tileStatus` only ever looked for an
 * `export` job, so every finished one-off reported "Draft" forever: the tile
 * and the rail dot said the work was unfinished while the download link sat
 * right next to them.
 */

const project = (mode: string): Project => ({
  id: "p1",
  title: "a lighthouse at dusk",
  created_at: 0,
  updated_at: 0,
  mode,
  approvals: [],
});

/** A session the engine has recorded an artifact for. */
const ready = (mode: string): Project => ({ ...project(mode), tool_artifact_hash: "abc123" });

const job = (node_id: string, status: Job["status"], created_at = 0): Job => ({
  id: `j-${node_id}-${created_at}`,
  project_id: "p1",
  status,
  progress: 1,
  error: null,
  created_at,
  started_at: created_at,
  finished_at: created_at,
  model: null,
  spec: { node_id, kind: node_id },
});

describe("tileStatus", () => {
  it("reports a finished quick tool as ready, not draft", () => {
    expect(tileStatus(ready("tool:image"), [])).toBe("ready");
  });

  it("reports every tool kind the same way", () => {
    for (const kind of ["script", "thumbnail", "voiceover", "image", "music", "clip"]) {
      expect(tileStatus(ready(`tool:${kind}`), [])).toBe("ready");
    }
  });

  /**
   * A DONE job row is NOT the same claim as "there is an artifact". The
   * engine derives the meta field through its trusted artifact cache, so a
   * placeholder from a fallback tier that has since been distrusted leaves
   * no hash while its DONE row is still in the 200-row window. Believing
   * the row would paint a green tile that opens on a queued session with
   * nothing to download.
   */
  it("does not call a session ready on a job row alone", () => {
    expect(tileStatus(project("tool:image"), [job("image", "done")])).toBe("draft");
  });

  // The clip tool renders its keyframe first; that finishing is not the
  // session finishing, and it is the clip's artifact the meta records.
  it("does not call a clip session ready on its keyframe alone", () => {
    expect(tileStatus(project("tool:clip"), [job("keyframe", "done")])).toBe("draft");
  });

  it("still reserves final for a project that exported", () => {
    expect(tileStatus(project("prompt"), [job("export", "done")])).toBe("final");
  });

  // "ready" belongs to tool sessions alone: a project's export is the only
  // thing that makes it final, however many scene jobs have landed.
  it("does not promote a project on a scene job named after a tool", () => {
    expect(tileStatus(project("prompt"), [job("image", "done")])).toBe("draft");
  });

  it("lets active work and a trailing failure win over readiness", () => {
    expect(tileStatus(ready("tool:image"), [job("image", "rendering", 2)])).toBe("generating");
    expect(tileStatus(ready("tool:image"), [job("image", "failed", 2)])).toBe("failed");
  });

  // A retry that succeeded is a finished session, not a failed one — the
  // trailing job decides, so the older failure must not pin the tile.
  it("clears a failure the session has since recovered from", () => {
    const jobs = [job("image", "failed", 1), job("image", "done", 2)];
    expect(tileStatus(ready("tool:image"), jobs)).toBe("ready");
  });

  /**
   * The reason the engine records the artifact on the meta at all. `allJobs`
   * is `GET /jobs` — the newest 200 rows across EVERY project — so a session
   * older than a couple of full renders has no rows left. History is made of
   * exactly those sessions, and asking the job list whether they finished
   * answers "no" for all of them, beside a download link that works.
   */
  it("reads a finished session from the meta when its jobs have aged out", () => {
    const aged = { ...project("tool:voiceover"), tool_artifact_hash: "abc123" };
    expect(tileStatus(aged, [])).toBe("ready");
  });

  it("does not call a session ready with no artifact and no jobs", () => {
    expect(tileStatus(project("tool:voiceover"), [])).toBe("draft");
  });

  // Live work still outranks the recorded artifact: a re-run in flight is
  // "generating", not "ready", however finished the previous take was.
  it("lets a re-run outrank the recorded artifact", () => {
    const rerun = { ...project("tool:image"), tool_artifact_hash: "abc123" };
    expect(tileStatus(rerun, [job("image", "rendering", 5)])).toBe("generating");
  });
});

/**
 * A session made by a NEWER engine carries a kind this build has no copy or
 * icon for. It is still history — listable, openable, deletable — but it
 * must not be looked up in the tools catalog: `m().tools[kind].label` throws
 * on a miss, which takes Home down through the error boundary.
 */
describe("tool kind resolution", () => {
  it("treats an unknown kind as a session but not as a known tool", () => {
    const future = project("tool:caption");
    expect(isToolSession(future)).toBe(true);
    expect(toolKindOf(future)).toBeNull();
  });

  it("resolves every kind this build ships", () => {
    for (const kind of ["script", "thumbnail", "voiceover", "image", "music", "clip"]) {
      expect(toolKindOf(project(`tool:${kind}`))).toBe(kind);
    }
  });

  it("does not mistake a real project for a session", () => {
    expect(isToolSession(project("prompt"))).toBe(false);
    expect(toolKindOf(project("prompt"))).toBeNull();
  });

  // Status comes from the meta, which the engine writes for any kind it
  // can run — so an unlabelled session still reports honestly.
  it("still reports an unknown kind's session as ready", () => {
    expect(tileStatus(ready("tool:caption"), [])).toBe("ready");
  });
});
