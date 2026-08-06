import type { StoryGraph } from "../api/types";

/**
 * A free id for a node the canvas is about to add: `<kind>-<n>`.
 *
 * The suffix is not decoration. The engine names its own pipeline nodes after
 * what they are ("music", "timeline") or where they sit ("s1.keyframe"), and
 * `add_node` refuses an id the graph already holds — so a bare kind would
 * collide with the pipeline on the most ordinary graph there is.
 *
 * Numbering counts past the highest taken rather than filling gaps: reusing
 * the id of a deleted node makes two different nodes indistinguishable in the
 * job history that outlives them.
 */
export function nextNodeId(graph: StoryGraph | null, kind: string): string {
  const taken = graph ? Object.keys(graph.nodes) : [];
  const prefix = `${kind}-`;
  let highest = 0;
  for (const id of taken) {
    if (!id.startsWith(prefix)) continue;
    const suffix = Number(id.slice(prefix.length));
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
  }
  return `${prefix}${highest + 1}`;
}
