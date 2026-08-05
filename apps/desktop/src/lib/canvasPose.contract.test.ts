/**
 * The flowchart mock's geometry, against the layout the app actually
 * produces (plan doc 11, rule 3 + the cross-boundary contract rule).
 *
 * canvas-mock.html hard-codes node positions, because a static HTML drawing
 * cannot run layoutGraph. That makes the mock a second copy of numbers the
 * app derives — exactly the drift `test_ui_contract.py` exists to catch on
 * the Python/TS boundary, one boundary over. If a spacing constant or the
 * column ordering changes, this goes red and names the frame that has to be
 * redrawn and re-rendered, instead of the pixel gate failing later with a
 * diff nobody can read.
 */
import { describe, expect, it } from "vitest";

import {
  POSE_CHAIN,
  POSE_GRAPH,
  POSE_LAYOUT,
  POSE_QUERY,
  POSE_SELECTED,
} from "../../scripts/rig/canvas-pose.mjs";
import { chainOf, searchMatches } from "./canvasFocus";
import { layoutGraph } from "./graphLayout";

const graph = POSE_GRAPH;

describe("the canvas reference pose", () => {
  it("lays out exactly where the mock draws it", () => {
    const layout = layoutGraph(graph);
    const placed = Object.fromEntries(layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    expect(placed).toEqual(POSE_LAYOUT.nodes);
  });

  it("fills exactly the extent the mock's stage is sized to", () => {
    const layout = layoutGraph(graph);
    expect({ width: layout.width, height: layout.height }).toEqual({
      width: POSE_LAYOUT.width,
      height: POSE_LAYOUT.height,
    });
  });

  it("lights the chain the mock draws undimmed", () => {
    expect([...chainOf(graph, POSE_SELECTED)].sort()).toEqual([...POSE_CHAIN].sort());
  });

  it("matches the three nodes the mock outlines", () => {
    // And none of them is the selection: the frame is what a match looks
    // like ON a dimmed node, which is the pair that has to stay legible.
    const matches = searchMatches(graph, POSE_QUERY);
    expect(matches).toEqual(["s2.clip", "s2.keyframe", "s2.narration"]);
    expect(matches).not.toContain(POSE_SELECTED);
  });

  it("counts what the mock's bar says", () => {
    expect(Object.keys(graph.nodes)).toHaveLength(10);
    expect(graph.edges).toHaveLength(13);
  });
});
