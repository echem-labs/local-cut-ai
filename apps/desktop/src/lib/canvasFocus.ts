/**
 * Chain focus and search over the graph — pure, like graphLayout and
 * canvasView beside it.
 *
 * "Which nodes feed this one, and which does it feed" is a question about the
 * graph, not about the canvas, so it is answered here and merely *drawn*
 * there. That also makes the two cases worth caring about testable without a
 * DOM: a diamond, and a graph that already contains a cycle.
 */
import type { StoryGraph } from "../api/types";

/**
 * Every node reachable from `id` against the edges plus every node reachable
 * with them — the transitive upstream and downstream cone, including `id`.
 *
 * Empty when there is no selection, or when the selection is a node the graph
 * does not have (a node deleted while its Details panel was open): dimming
 * everything around something that is not on screen explains nothing.
 *
 * The visited set is what makes a diamond cost one visit per node instead of
 * one per path, and what stops a pre-existing cycle from looping forever. The
 * canvas refuses to CREATE a cycle (see wouldCycle), but nothing here gets to
 * assume the graph it was handed came from this canvas.
 */
export function chainOf(graph: StoryGraph | null, id: string | null): Set<string> {
  const chain = new Set<string>();
  if (!graph || !id || !graph.nodes[id]) return chain;

  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!down.has(edge.src)) down.set(edge.src, []);
    down.get(edge.src)!.push(edge.dst);
    if (!up.has(edge.dst)) up.set(edge.dst, []);
    up.get(edge.dst)!.push(edge.src);
  }

  const walk = (from: string, along: Map<string, string[]>) => {
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const next of along.get(at) ?? []) {
        if (chain.has(next)) continue;
        chain.add(next);
        queue.push(next);
      }
    }
  };

  chain.add(id);
  walk(id, up);
  walk(id, down);
  return chain;
}

/**
 * Node ids whose id or kind contains `query`, case-insensitively.
 *
 * Sorted by code unit rather than `localeCompare` — the same rule the derived
 * layout follows, so that pressing Enter walks the matches in an order that
 * cannot depend on the machine's locale.
 */
export function searchMatches(graph: StoryGraph | null, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!graph || !needle) return [];
  return Object.values(graph.nodes)
    .filter(
      (node) =>
        node.id.toLowerCase().includes(needle) || node.kind.toLowerCase().includes(needle),
    )
    .map((node) => node.id)
    .sort();
}
