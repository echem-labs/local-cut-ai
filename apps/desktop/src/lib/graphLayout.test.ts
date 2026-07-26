/**
 * Where the flowchart puts things.
 *
 * Layout is a pure function of the graph and nothing persists it, which makes
 * two properties load-bearing rather than nice-to-have: the same graph must
 * lay out the same way every time (or the picture rearranges under the user
 * on every refresh), and a graph the engine would never write must still
 * produce a picture rather than a crash (the canvas renders whatever arrived,
 * including from an older build).
 */
import { describe, expect, it } from "vitest";

import type { StoryGraph } from "../api/types";
import {
  CANVAS_PADDING,
  NODE_WIDTH,
  edgePath,
  layoutGraph,
  occupiedPorts,
  wouldCycle,
} from "./graphLayout";

const node = (id: string) => ({
  id,
  kind: "keyframe",
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  frozen_hash: null,
});

/** script -> keyframe -> clip, the spine of every real project. */
const CHAIN: StoryGraph = {
  version: 1,
  nodes: { script: node("script"), keyframe: node("keyframe"), clip: node("clip") },
  edges: [
    { src: "script", dst: "keyframe", port: "default" },
    { src: "keyframe", dst: "clip", port: "keyframe" },
  ],
};

describe("laying out a story graph", () => {
  it("puts each node one column right of what feeds it", () => {
    const layout = layoutGraph(CHAIN);

    expect(layout.byId.script!.depth).toBe(0);
    expect(layout.byId.keyframe!.depth).toBe(1);
    expect(layout.byId.clip!.depth).toBe(2);
    expect(layout.byId.keyframe!.x).toBeGreaterThan(layout.byId.script!.x);
  });

  it("puts a node one column past its DEEPEST input, not its first", () => {
    // Longest-path layering. Shortest-path would place `export` next to
    // `script`, drawing an edge back across two columns from `clip`.
    const graph: StoryGraph = {
      ...CHAIN,
      nodes: { ...CHAIN.nodes, export: node("export") },
      edges: [
        ...CHAIN.edges,
        { src: "script", dst: "export", port: "default" },
        { src: "clip", dst: "export", port: "default" },
      ],
    };

    expect(layoutGraph(graph).byId.export!.depth).toBe(3);
  });

  it("is stable across insertion order", () => {
    // Object.keys follows insertion, which differs between a project just
    // created and the same project reloaded from disk. A layout that moved
    // on reload would look like the graph had changed.
    //
    // The fixture is a FAN, not the chain: siblings fed by the same source
    // share a barycentre, and Array sort is stable, so a tie is exactly where
    // insertion order would leak through. A chain has one node per column and
    // would pass this whatever the ordering rule was.
    const fan = (...ids: string[]): StoryGraph => ({
      version: 1,
      nodes: Object.fromEntries([["root", node("root")], ...ids.map((id) => [id, node(id)])]),
      edges: ids.map((id) => ({ src: "root", dst: id, port: "default" })),
    });

    expect(layoutGraph(fan("c", "a", "b"))).toEqual(layoutGraph(fan("a", "b", "c")));
  });

  it("orders tied siblings by id, not by however they arrived", () => {
    // The property underneath the one above, asserted directly so a failure
    // says which rule broke rather than just "the two differ".
    const fan: StoryGraph = {
      version: 1,
      nodes: { root: node("root"), zebra: node("zebra"), apple: node("apple") },
      edges: [
        { src: "root", dst: "zebra", port: "default" },
        { src: "root", dst: "apple", port: "default" },
      ],
    };

    const layout = layoutGraph(fan);

    expect(layout.byId.apple!.row).toBe(0);
    expect(layout.byId.zebra!.row).toBe(1);
  });

  it("sizes the stage to hold every node", () => {
    const layout = layoutGraph(CHAIN);

    const rightmost = Math.max(...layout.nodes.map((n) => n.x));
    expect(layout.width).toBeGreaterThanOrEqual(rightmost + NODE_WIDTH);
    expect(layout.height).toBeGreaterThan(CANVAS_PADDING);
  });

  it("draws an empty graph as nothing rather than throwing", () => {
    expect(layoutGraph(null).nodes).toEqual([]);
    expect(layoutGraph({ version: 1, nodes: {}, edges: [] }).nodes).toEqual([]);
  });

  it("places a node with no edges at all", () => {
    // A Quick Tool micro-project is exactly this: one node, no wiring.
    const solo: StoryGraph = { version: 1, nodes: { thumbnail: node("thumbnail") }, edges: [] };

    expect(layoutGraph(solo).byId.thumbnail!.depth).toBe(0);
  });

  it("survives a cycle instead of recursing forever", () => {
    // The engine refuses cycles on every write path, but the canvas renders
    // what it was sent — including from a build that lacked that check. A
    // blown stack here takes the whole renderer down.
    const looped: StoryGraph = {
      version: 1,
      nodes: { a: node("a"), b: node("b") },
      edges: [
        { src: "a", dst: "b", port: "default" },
        { src: "b", dst: "a", port: "default" },
      ],
    };

    const layout = layoutGraph(looped);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("ignores an edge from a node that is not in the graph", () => {
    // A patch can remove a node; a board fetched a moment earlier can still
    // reference it. The layout must not invent a column for a ghost.
    const dangling: StoryGraph = {
      ...CHAIN,
      edges: [...CHAIN.edges, { src: "deleted", dst: "clip", port: "default" }],
    };

    const layout = layoutGraph(dangling);

    expect(layout.byId.deleted).toBeUndefined();
    expect(layout.byId.clip!.depth).toBe(2);
  });

  it("gives every node in a column its own row", () => {
    const fan: StoryGraph = {
      version: 1,
      nodes: { root: node("root"), a: node("a"), b: node("b"), c: node("c") },
      edges: [
        { src: "root", dst: "a", port: "default" },
        { src: "root", dst: "b", port: "default" },
        { src: "root", dst: "c", port: "default" },
      ],
    };

    const rows = layoutGraph(fan)
      .nodes.filter((n) => n.depth === 1)
      .map((n) => n.y);

    expect(new Set(rows).size).toBe(3);
  });
});

describe("drawing an edge", () => {
  it("leaves the source's right edge and arrives at the target's left", () => {
    const layout = layoutGraph(CHAIN);
    const path = edgePath(layout.byId.script!, layout.byId.keyframe!);

    expect(path.startsWith(`M ${layout.byId.script!.x + NODE_WIDTH}`)).toBe(true);
    expect(path).toContain(`${layout.byId.keyframe!.x}`);
  });

  it("bows a back-edge instead of collapsing it to a straight line", () => {
    // Only reachable from a graph this build did not write, but a zero-length
    // control offset would draw the wire straight through both boxes.
    const layout = layoutGraph(CHAIN);
    const backwards = edgePath(layout.byId.clip!, layout.byId.script!);

    expect(backwards).toContain("C");
    expect(backwards).not.toContain("NaN");
  });
});

describe("what a port already holds", () => {
  it("reports the source feeding each occupied input", () => {
    expect(occupiedPorts(CHAIN, "clip")).toEqual({ keyframe: "keyframe" });
    expect(occupiedPorts(CHAIN, "script")).toEqual({});
  });

  it("answers for a null graph", () => {
    expect(occupiedPorts(null, "clip")).toEqual({});
  });
});

describe("refusing a wire before the engine has to", () => {
  it("catches a node fed from its own downstream", () => {
    // clip is downstream of script, so script <- clip closes the loop.
    expect(wouldCycle(CHAIN, "clip", "script")).toBe(true);
  });

  it("catches a node fed from itself", () => {
    expect(wouldCycle(CHAIN, "clip", "clip")).toBe(true);
  });

  it("allows a wire that only adds a shortcut", () => {
    // script -> clip is redundant with script -> keyframe -> clip, but it is
    // still a DAG, and refusing it would refuse a legitimate rewiring.
    expect(wouldCycle(CHAIN, "script", "clip")).toBe(false);
  });

  it("terminates on a graph that is already looped", () => {
    const looped: StoryGraph = {
      version: 1,
      nodes: { a: node("a"), b: node("b") },
      edges: [
        { src: "a", dst: "b", port: "default" },
        { src: "b", dst: "a", port: "default" },
      ],
    };

    expect(wouldCycle(looped, "a", "b")).toBe(true);
  });
});
