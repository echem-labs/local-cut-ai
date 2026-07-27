/**
 * Where the nodes go on the flowchart canvas.
 *
 * Deliberately deterministic and dependency-free. A force-directed layout
 * moves every node whenever any node changes, so the graph a user was reading
 * rearranges under them on each render tick — and a Story Graph is a DAG
 * whose whole meaning is "this flows into that", which a layered layout says
 * directly and a physics simulation only approximates.
 *
 * Determinism also means positions are not state. Nothing is persisted, there
 * is no per-project layout file to migrate, and the same graph draws the same
 * way on every machine — which is what makes a template's shape recognisable
 * when someone else opens it.
 *
 * The algorithm is the standard layered one, minus the parts that need a
 * solver: longest-path layering (a node sits one column right of its deepest
 * input), then within each column, order by the average row of the node's
 * inputs so edges stay short and crossings stay rare. That is a heuristic,
 * not an optimum, and it is the right trade here — a story graph is tens of
 * nodes, not thousands.
 */
import type { GraphEdge, StoryGraph } from "../api/types";

/** Node box and spacing, in canvas units. The canvas scales these; they are
 * fixed here so layout arithmetic never depends on the viewport. */
export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 64;
export const COLUMN_GAP = 84;
export const ROW_GAP = 26;
export const CANVAS_PADDING = 32;

export interface PlacedNode {
  id: string;
  /** Column (0 = no inputs) and row within it. */
  depth: number;
  row: number;
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  byId: Record<string, PlacedNode>;
  width: number;
  height: number;
}

/** Inputs per node, as `dst -> src[]`. */
function inputsOf(edges: GraphEdge[]): Map<string, string[]> {
  const inputs = new Map<string, string[]>();
  for (const edge of edges) {
    const list = inputs.get(edge.dst);
    if (list) list.push(edge.src);
    else inputs.set(edge.dst, [edge.src]);
  }
  return inputs;
}

/**
 * Longest-path depth per node: one past its deepest input.
 *
 * Iterative with an explicit stack rather than recursion, and guarded by a
 * `visiting` set. The engine rejects cycles on every write path, but this
 * renders whatever the engine sent — including a graph written by a build
 * that did not have that check. A cycle must degrade to a readable picture,
 * never a blown stack that takes the whole window down.
 */
function depths(nodeIds: string[], inputs: Map<string, string[]>): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  for (const start of nodeIds) {
    if (depth.has(start)) continue;
    const stack: { id: string; expanded: boolean }[] = [{ id: start, expanded: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (depth.has(frame.id)) {
        stack.pop();
        visiting.delete(frame.id);
        continue;
      }
      const sources = (inputs.get(frame.id) ?? []).filter((src) => nodeIds.includes(src));
      if (!frame.expanded) {
        frame.expanded = true;
        visiting.add(frame.id);
        // Push unresolved inputs; a source we are already visiting is a
        // cycle, so it is skipped and contributes nothing to the depth.
        for (const src of sources) {
          if (!depth.has(src) && !visiting.has(src)) stack.push({ id: src, expanded: false });
        }
        continue;
      }
      const resolved = sources.map((src) => depth.get(src)).filter((d) => d !== undefined);
      depth.set(frame.id, resolved.length === 0 ? 0 : Math.max(...resolved) + 1);
      visiting.delete(frame.id);
      stack.pop();
    }
  }
  return depth;
}

/**
 * Place every node of `graph` on a grid.
 *
 * The result depends only on the graph's CONTENT, never on the order its keys
 * happen to be in: `Object.keys` follows insertion, which differs between a
 * freshly created project and the same project reloaded from disk, and a
 * layout that changed on reload would look like the graph had changed.
 *
 * Two things enforce that, and they overlap on purpose — sorting the ids here,
 * and the id tie-break in the column ordering below. Either alone is enough
 * today (removing one leaves the other holding it, which is why no single-line
 * change breaks graphLayout.test's stability cases; removing both does). They
 * are kept together because they fail in different directions: the sort covers
 * any traversal that grows an order dependence later, the tie-break covers a
 * future ordering pass that does not inherit this array's order.
 */
export function layoutGraph(graph: StoryGraph | null): GraphLayout {
  const empty: GraphLayout = { nodes: [], byId: {}, width: 0, height: 0 };
  if (!graph) return empty;
  const nodeIds = Object.keys(graph.nodes).sort();
  if (nodeIds.length === 0) return empty;

  const inputs = inputsOf(graph.edges);
  const depth = depths(nodeIds, inputs);

  const columns = new Map<number, string[]>();
  for (const id of nodeIds) {
    const column = depth.get(id) ?? 0;
    const list = columns.get(column);
    if (list) list.push(id);
    else columns.set(column, [id]);
  }

  // Order each column by the mean row of its inputs, left to right, so a
  // node sits across from what feeds it. Columns are processed in order, so
  // by the time a column is placed its inputs already have rows.
  const rowOf = new Map<string, number>();
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(column)!;
    const weight = (id: string): number => {
      const sources = (inputs.get(id) ?? []).map((src) => rowOf.get(src)).filter(
        (row): row is number => row !== undefined,
      );
      // No placed input: sink to the bottom of the column rather than the
      // top, so unconnected nodes never split a chain that reads as one flow.
      if (sources.length === 0) return Number.POSITIVE_INFINITY;
      return sources.reduce((sum, row) => sum + row, 0) / sources.length;
    };
    // Tie-break by id: two nodes fed by the same source have the SAME
    // barycentre, and Array sort is stable, so without a tie-break their
    // order is whatever order they arrived in. See the note on layoutGraph
    // for why this and the id sort there are deliberately redundant.
    //
    // Code-unit order, NOT localeCompare: the promise this module makes is
    // that a graph draws the same way on every machine, and collation is a
    // property of the host's locale — "Beta" and "alpha" swap places between
    // one and the next. It is also the order the id sort above uses, so the
    // two guards agree instead of quietly disagreeing.
    const ordered = [...ids].sort(
      (a, b) => weight(a) - weight(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    ordered.forEach((id, row) => rowOf.set(id, row));
    columns.set(column, ordered);
  }

  const nodes: PlacedNode[] = [];
  const byId: Record<string, PlacedNode> = {};
  let width = 0;
  let height = 0;
  for (const [column, ids] of columns) {
    ids.forEach((id, row) => {
      const placed: PlacedNode = {
        id,
        depth: column,
        row,
        x: CANVAS_PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: CANVAS_PADDING + row * (NODE_HEIGHT + ROW_GAP),
      };
      nodes.push(placed);
      byId[id] = placed;
      width = Math.max(width, placed.x + NODE_WIDTH + CANVAS_PADDING);
      height = Math.max(height, placed.y + NODE_HEIGHT + CANVAS_PADDING);
    });
  }
  // Stable draw order: by column then row, so the DOM order matches reading
  // order and tab-through follows the flow.
  nodes.sort((a, b) => a.depth - b.depth || a.row - b.row);
  return { nodes, byId, width, height };
}

/** Just the corner an edge is drawn from or to. */
interface Point {
  x: number;
  y: number;
}

/**
 * An SVG path from one node's output edge to another's input edge.
 *
 * A cubic with horizontal control points: the curve leaves the source going
 * right and arrives at the target going right, which reads as flow direction
 * even where a long edge skips several columns.
 *
 * Takes only the two points it reads. Typed as PlacedNode, the live-wire
 * caller had to invent `id: ""`, `depth: 0`, `row: 0` for every drag frame —
 * three fields nothing here looks at, and `depth: 0` reads as a layout claim.
 */
export function edgePath(from: Point, to: Point): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  // Scale the control offset with the gap so a back-edge (a target LEFT of
  // its source, possible only in a graph this build did not write) still
  // bows visibly instead of collapsing to a straight line through the boxes.
  const reach = Math.max(COLUMN_GAP / 2, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

/** Every node's occupied ports, as `dst -> port -> src`.
 *
 * Connecting to an occupied port replaces what is there, which is why the
 * canvas needs to know. Built for the whole graph in one pass rather than
 * per node: the canvas needs it for every node it draws, so a per-node scan
 * is O(nodes x edges) — redone on every pointermove of a wire drag and every
 * job-progress tick of a live render. Memoized on `graph` beside the layout.
 */
export function occupiedPortIndex(
  graph: StoryGraph | null,
): Record<string, Record<string, string>> {
  const index: Record<string, Record<string, string>> = {};
  for (const edge of graph?.edges ?? []) {
    (index[edge.dst] ??= {})[edge.port] = edge.src;
  }
  return index;
}

/**
 * Would connecting `src -> dst` create a cycle?
 *
 * Asked here so the canvas can refuse the drag rather than let the engine
 * 422 it: the engine's check is authoritative and stays, but a wire that
 * snaps back with a reason beats one that is accepted, sent, and rejected.
 */
export function wouldCycle(graph: StoryGraph | null, src: string, dst: string): boolean {
  if (src === dst) return true;
  if (!graph) return false;
  // Walk down from dst; reaching src means the new edge closes a loop.
  const seen = new Set<string>([dst]);
  const frontier = [dst];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const edge of graph.edges) {
      if (edge.src !== current || seen.has(edge.dst)) continue;
      if (edge.dst === src) return true;
      seen.add(edge.dst);
      frontier.push(edge.dst);
    }
  }
  return false;
}
