/**
 * Chain focus and canvas search, as set arithmetic over the graph.
 *
 * The interesting cases are the ones a hand-clicked check would never reach:
 * a diamond (a node upstream by two different routes must not be counted
 * twice or missed), and a graph that already contains a cycle — which the
 * canvas refuses to CREATE, but can still be handed by an engine that has
 * one, and a naive walk hangs on.
 */
import { describe, expect, it } from "vitest";

import type { StoryGraph } from "../api/types";
import { chainOf, searchMatches } from "./canvasFocus";

/** Kind from the id's last segment, the way the engine names pipeline nodes
 * ("s1.clip" is a clip) — so a search by kind and a search by id are
 * genuinely different lookups in these fixtures. */
const node = (id: string) => ({
  id,
  kind: id.split(".").pop()!,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  frozen_hash: null,
});

/** script → keyframe → clip → timeline, with music joining the timeline. */
const graph = (edges: [string, string][], ids: string[]): StoryGraph =>
  ({
    nodes: Object.fromEntries(ids.map((id) => [id, node(id)])),
    edges: edges.map(([src, dst]) => ({ src, dst, port: "default" })),
  }) as unknown as StoryGraph;

const LINE = graph(
  [
    ["script", "keyframe"],
    ["keyframe", "clip"],
    ["clip", "timeline"],
    ["music", "timeline"],
  ],
  ["script", "keyframe", "clip", "timeline", "music"],
);

describe("chainOf", () => {
  it("takes everything upstream and downstream, transitively", () => {
    // From the clip: back through keyframe to script, forward to timeline.
    // Music is neither — it only shares a destination.
    expect(chainOf(LINE, "clip")).toEqual(new Set(["script", "keyframe", "clip", "timeline"]));
  });

  it("includes the node itself even when nothing is wired to it", () => {
    const lonely = graph([], ["orphan"]);
    expect(chainOf(lonely, "orphan")).toEqual(new Set(["orphan"]));
  });

  it("counts a node reachable by two routes once, and terminates on a cycle", () => {
    // a → b → d and a → c → d (diamond), plus d → a closing a loop the
    // canvas would refuse to draw but an engine could still serve.
    const diamond = graph(
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
        ["d", "a"],
      ],
      ["a", "b", "c", "d"],
    );
    expect(chainOf(diamond, "b")).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("is empty for no selection, so nothing dims", () => {
    expect(chainOf(LINE, null).size).toBe(0);
    expect(chainOf(null, "clip").size).toBe(0);
    // A selection the graph does not have (deleted under the panel) must not
    // dim the entire canvas around a node that is not there.
    expect(chainOf(LINE, "ghost").size).toBe(0);
  });
});

describe("searchMatches", () => {
  it("matches id and kind, case-insensitively", () => {
    expect(searchMatches(LINE, "CLI")).toEqual(["clip"]);
    // "keyframe" is both an id here and a kind — one node, listed once.
    expect(searchMatches(LINE, "keyframe")).toEqual(["keyframe"]);
  });

  it("returns matches in the graph's own id order, so Enter cycles stably", () => {
    const many = graph([], ["s2.clip", "s1.clip", "s10.clip"]);
    // Code-unit order, per the repo's layout rule — never localeCompare.
    expect(searchMatches(many, "clip")).toEqual(["s1.clip", "s10.clip", "s2.clip"]);
  });

  it("finds nothing for an empty or whitespace query", () => {
    expect(searchMatches(LINE, "")).toEqual([]);
    expect(searchMatches(LINE, "   ")).toEqual([]);
    expect(searchMatches(null, "clip")).toEqual([]);
  });
});
