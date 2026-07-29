import { describe, expect, it } from "vitest";

import { tileStatus } from "./Home";
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
    expect(tileStatus(project("tool:image"), [job("image", "done")])).toBe("ready");
  });

  it("reads each tool's own node, not a shared one", () => {
    for (const kind of ["script", "thumbnail", "voiceover", "image", "music", "clip"]) {
      expect(tileStatus(project(`tool:${kind}`), [job(kind, "done")])).toBe("ready");
    }
  });

  // The clip tool renders its keyframe first; that job finishing is not the
  // session finishing, and reporting "ready" at that point would offer a
  // download for a video that does not exist yet.
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
    const done = job("image", "done", 1);
    expect(tileStatus(project("tool:image"), [done, job("image", "rendering", 2)])).toBe(
      "generating",
    );
    expect(tileStatus(project("tool:image"), [done, job("image", "failed", 2)])).toBe("failed");
  });

  // A retry that succeeded is a finished session, not a failed one — the
  // trailing job decides, so the older failure must not pin the tile.
  it("clears a failure the session has since recovered from", () => {
    const jobs = [job("image", "failed", 1), job("image", "done", 2)];
    expect(tileStatus(project("tool:image"), jobs)).toBe("ready");
  });
});
