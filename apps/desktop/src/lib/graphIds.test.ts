/**
 * Ids for nodes the canvas adds.
 *
 * The engine validates against NODE_ID_PATTERN and rejects a collision, so a
 * bad id here is a 422 the user cannot act on. The pattern is mirrored in the
 * test rather than imported, which is the point: if the engine's changes,
 * this is what notices.
 */
import { describe, expect, it } from "vitest";

import type { StoryGraph } from "../api/types";
import { nextNodeId } from "./graphIds";

/** engine/graph/model.py::NODE_ID_PATTERN, mirrored on purpose. */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const graphOf = (ids: string[]): StoryGraph =>
  ({
    nodes: Object.fromEntries(
      ids.map((id) => [
        id,
        { id, kind: "clip", params: {}, seed: 0, model: null, pinned: false, frozen_hash: null },
      ]),
    ),
    edges: [],
  }) as unknown as StoryGraph;

describe("nextNodeId", () => {
  it("numbers from one and skips what the graph already has", () => {
    expect(nextNodeId(graphOf([]), "keyframe")).toBe("keyframe-1");
    expect(nextNodeId(graphOf(["keyframe-1"]), "keyframe")).toBe("keyframe-2");
    // A gap is not reused: "keyframe-2" was deleted, but re-issuing the id
    // makes two different nodes indistinguishable in a job log.
    expect(nextNodeId(graphOf(["keyframe-1", "keyframe-3"]), "keyframe")).toBe("keyframe-4");
  });

  it("never collides with the engine's own pipeline names", () => {
    // The pipeline calls its nodes "music", "timeline", "s1.keyframe" — the
    // suffix is what keeps a hand-added node out of that namespace.
    const pipeline = graphOf(["script", "music", "timeline", "s1.keyframe", "export"]);
    expect(nextNodeId(pipeline, "music")).toBe("music-1");
    expect(nextNodeId(pipeline, "keyframe")).toBe("keyframe-1");
  });

  it("produces ids the engine's pattern accepts", () => {
    for (const kind of ["keyframe", "clip", "narration", "music", "thumbnail"]) {
      expect(nextNodeId(graphOf([]), kind)).toMatch(NODE_ID_PATTERN);
    }
  });

  it("still answers for a graph that has not loaded", () => {
    expect(nextNodeId(null, "clip")).toBe("clip-1");
  });
});
