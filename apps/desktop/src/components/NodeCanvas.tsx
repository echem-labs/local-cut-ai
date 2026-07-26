/**
 * The flowchart view: the Story Graph as a node canvas.
 *
 * Doc 01's one-graph architecture says the modes are views of one structure,
 * not separate products. The storyboard shows that structure as scene cards;
 * this shows it as what it actually is — a DAG with named input ports — and
 * that is the only view where an *edge* is visible and editable at all.
 *
 * Three deliberate constraints:
 *
 * 1. **No node-editor library.** react-flow and friends bring a canvas
 *    runtime, their own event model and their own stylesheet, and this graph
 *    is tens of nodes. Absolutely-positioned divs over one SVG layer is less
 *    code than the integration would be, keeps the app's own focus and theme
 *    rules, and does not add a dependency to a bundle that ships in an
 *    installer.
 *
 * 2. **Layout is derived, never stored.** See lib/graphLayout — positions are
 *    a pure function of the graph, so there is no per-project layout file to
 *    save, migrate or conflict, and a template opens looking the same on
 *    someone else's machine.
 *
 * 3. **Every edit is a graph patch.** Wiring, unwiring and deleting go
 *    through the same `/patch` endpoint the inspector and the LLM editor use.
 *    The canvas never has a private mutation path, so the cycle check, the
 *    voice-consent gate and the re-plan all apply here for free.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { GraphNode, NodeState } from "../api/types";
import { m, plural, t } from "../i18n";
import {
  CANVAS_PADDING,
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePath,
  layoutGraph,
  occupiedPorts,
  wouldCycle,
} from "../lib/graphLayout";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHelp } from "./Help";

/** A wire being dragged, from the moment a source port is grabbed. */
interface PendingWire {
  src: string;
  /** Pointer position in canvas coordinates, for the live wire. */
  x: number;
  y: number;
}

/** The board's status for a node, if the board knows it.
 *
 * The graph and the board are two reads of one project, and only the board
 * carries render state. Joining them here rather than asking the engine for a
 * combined document keeps `/graph` a plain structural read — which is what
 * makes it usable for a template export and a canvas alike.
 */
type BoardOrNull = ReturnType<typeof useApp.getState>["board"];

function statusIndex(board: BoardOrNull): Record<string, NodeState> {
  const index: Record<string, NodeState> = {};
  if (!board) return index;
  for (const scene of board.scenes) {
    for (const slot of [scene.keyframe, scene.clip, scene.narration, ...(scene.clip_takes ?? [])]) {
      if (slot) index[slot.node_id] = slot;
    }
  }
  for (const node of Object.values(board.aux)) index[node.node_id] = node;
  return index;
}

const kindLabel = (kind: string): string => {
  const kinds = m().canvas.kinds as Record<string, string>;
  // Fall back to the wire value rather than blanking the node: a kind this
  // build has no word for is still a node the user needs to see and select.
  return kinds[kind] ?? kind;
};

const portLabel = (port: string): string => {
  const ports = m().canvas.ports as Record<string, string>;
  return ports[port] ?? port;
};

export function NodeCanvas() {
  const graph = useApp((state) => state.graph);
  const graphError = useApp((state) => state.graphError);
  const board = useApp((state) => state.board);
  const projectId = useApp((state) => state.currentProject?.id ?? null);
  const selectedNode = useApp((state) => state.selectedNode);
  const select = useApp((state) => state.select);
  const refreshGraph = useApp((state) => state.refreshGraph);
  const connectNodes = useApp((state) => state.connectNodes);
  const disconnectPort = useApp((state) => state.disconnectPort);
  const removeNode = useApp((state) => state.removeNode);

  const [wire, setWire] = useState<PendingWire | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // Deleting a node is the one edit here with no way back: `add_node` has no
  // UI at all, so a structural node (export, timeline, script) removed by a
  // stray Delete leaves a project that can never finish a cut. ConfirmDialog
  // is what the app already puts in front of acts like that, and Backspace on
  // a focused element is a reflex key, not a decision.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Fetch on mount and whenever the project changes. The storyboard never
  // needs the graph, so this is the only thing that asks for it.
  useEffect(() => {
    if (projectId) void refreshGraph();
  }, [projectId, refreshGraph]);

  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const statuses = useMemo(() => statusIndex(board), [board]);

  /** Pointer position in canvas coordinates, accounting for scroll. */
  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const box = surface.getBoundingClientRect();
    return {
      x: event.clientX - box.left + surface.scrollLeft,
      y: event.clientY - box.top + surface.scrollTop,
    };
  };

  const startWire = (src: string, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const point = toCanvas(event);
    setWire({ src, ...point });
    setHint(t("canvas.wiring.prompt"));
  };

  const dropWire = async (dst: string, port: string) => {
    const pending = wire;
    setWire(null);
    if (!pending) return;
    if (pending.src === dst) {
      setHint(t("canvas.wiring.self"));
      return;
    }
    // Refuse here as well as on the engine. The engine's check is what makes
    // it safe; this one is what makes it explicable — a wire that snaps back
    // with a reason beats one accepted, sent, and 422'd a round trip later.
    if (wouldCycle(graph, pending.src, dst)) {
      setHint(t("canvas.wiring.cycle"));
      return;
    }
    setHint(null);
    const error = await connectNodes(pending.src, dst, port);
    if (error) setHint(error);
  };

  const onSurfaceKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape" && wire) {
      setWire(null);
      setHint(null);
    }
  };

  if (graphError && !graph) {
    return (
      <div className="canvas-panel canvas-empty">
        <p className="canvas-error">{graphError}</p>
        <button type="button" onClick={() => void refreshGraph()}>
          {t("canvas.reload")}
        </button>
      </div>
    );
  }
  if (!graph) {
    return <div className="canvas-panel canvas-empty">{t("canvas.loading")}</div>;
  }
  if (layout.nodes.length === 0) {
    return <div className="canvas-panel canvas-empty">{t("canvas.empty")}</div>;
  }

  return (
    <div className="canvas-panel">
      <div className="canvas-bar">
        <span className="canvas-counts">
          {plural("canvas.nodes", layout.nodes.length)} ·{" "}
          {plural("canvas.edges", graph.edges.length)}
        </span>
        {hint && <span className="canvas-hint">{hint}</span>}
        <PanelHelp panel="canvas" />
      </div>
      <div
        className="canvas-surface"
        ref={surfaceRef}
        onKeyDown={onSurfaceKeyDown}
        onPointerMove={(event) => {
          if (wire) setWire({ ...wire, ...toCanvas(event) });
        }}
        // Releasing anywhere but on a port abandons the wire. Without this a
        // half-made connection follows the pointer forever.
        onPointerUp={() => {
          if (wire) {
            setWire(null);
            setHint(null);
          }
        }}
      >
        <div
          className="canvas-stage"
          style={{ width: layout.width, height: layout.height }}
          role="application"
          aria-label={t("canvas.title")}
        >
          <svg className="canvas-wires" width={layout.width} height={layout.height} aria-hidden>
            {graph.edges.map((edge) => {
              const from = layout.byId[edge.src];
              const to = layout.byId[edge.dst];
              if (!from || !to) return null; // an edge to a node the graph lost
              const active = selectedNode === edge.src || selectedNode === edge.dst;
              return (
                <path
                  key={`${edge.src}->${edge.dst}:${edge.port}`}
                  className={`canvas-wire${active ? " active" : ""}`}
                  d={edgePath(from, to)}
                />
              );
            })}
            {wire && layout.byId[wire.src] && (
              <path
                className="canvas-wire pending"
                d={edgePath(layout.byId[wire.src]!, {
                  id: "",
                  depth: 0,
                  row: 0,
                  // The live end follows the pointer: shift back by half a box
                  // so the curve terminates AT the cursor, not past it.
                  x: wire.x,
                  y: wire.y - NODE_HEIGHT / 2,
                })}
              />
            )}
          </svg>

          {layout.nodes.map((placed) => {
            const node = graph.nodes[placed.id]!;
            const state = statuses[placed.id];
            const held = occupiedPorts(graph, placed.id);
            return (
              <NodeBox
                key={placed.id}
                node={node}
                state={state}
                x={placed.x}
                y={placed.y}
                selected={selectedNode === placed.id}
                wiring={wire !== null}
                heldPorts={held}
                onSelect={() => select(placed.id)}
                onStartWire={(event) => startWire(placed.id, event)}
                onDropWire={(port) => void dropWire(placed.id, port)}
                onDisconnect={(port) => void disconnectPort(placed.id, port)}
                onRemove={() => setPendingDelete(placed.id)}
              />
            );
          })}
        </div>
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={t("canvas.confirmDelete.title", { id: pendingDelete })}
          message={t("canvas.confirmDelete.message")}
          confirmLabel={t("canvas.confirmDelete.confirm")}
          danger
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void removeNode(target).then((error) => {
              if (error) setHint(error);
            });
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

interface NodeBoxProps {
  node: GraphNode;
  state: NodeState | undefined;
  x: number;
  y: number;
  selected: boolean;
  wiring: boolean;
  heldPorts: Record<string, string>;
  onSelect: () => void;
  onStartWire: (event: React.PointerEvent) => void;
  onDropWire: (port: string) => void;
  onDisconnect: (port: string) => void;
  onRemove: () => void;
}

/** The input ports a node offers.
 *
 * Derived from the edges it already has, plus `default` — rather than a table
 * of which kind accepts which port. The engine owns that knowledge (the
 * template builder and the backends share the port constants), and a second
 * copy here would drift silently: a port added engine-side would simply not
 * appear, with nothing to fail.
 */
function portsFor(node: GraphNode, held: Record<string, string>): string[] {
  const ports = new Set<string>(Object.keys(held));
  if (node.kind !== "asset" && node.kind !== "script") ports.add("default");
  return [...ports].sort();
}

function NodeBox(props: NodeBoxProps) {
  const { node, state, heldPorts } = props;
  const ports = portsFor(node, heldPorts);
  const status = state?.status;
  return (
    <div
      className={`canvas-node${props.selected ? " selected" : ""}${
        node.pinned ? " pinned" : ""
      }${status ? ` status-${status}` : ""}`}
      style={{ left: props.x, top: props.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      // A GROUP, not a button, even though the whole box is clickable. The
      // ports below are real buttons, and ARIA specifies the children of a
      // `button` as presentational: nesting them inside one hides the only
      // way to disconnect an edge — and every drop target for a wire — from
      // assistive technology, however reachable they are by Tab. The node's
      // own select affordance is the body button instead, which fills the box.
      role="group"
      aria-label={t("canvas.nodeGroupAria", { id: node.id })}
    >
      <button
        type="button"
        className="canvas-node-body"
        aria-pressed={props.selected}
        aria-label={t("canvas.nodeAria", {
          kind: kindLabel(node.kind),
          id: node.id,
          // Through the catalog like every other status surface — the raw
          // value is a wire id ("skipped" reads "not needed" everywhere else).
          status: status ? t(`status.${status}`) : t("canvas.kinds.scene"),
        })}
        onClick={props.onSelect}
        // Enter and Space are the button's own; only the delete keys need
        // handling, and they ask rather than act (see the canvas's dialog).
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            props.onRemove();
          }
        }}
      >
        <span className="canvas-node-kind">{kindLabel(node.kind)}</span>
        <span className="canvas-node-id">{node.id}</span>
      </button>
      {node.pinned && (
        <span className="canvas-node-pin" title={t("canvas.pinned")} aria-hidden>
          ●
        </span>
      )}

      <div className="canvas-ports in">
        {ports.map((port) => (
          <button
            key={port}
            type="button"
            className={`canvas-port${heldPorts[port] ? " filled" : ""}`}
            aria-label={t("canvas.portAria", { port: portLabel(port), id: node.id })}
            // Pointer-up rather than click: the wire is a drag, and a click
            // needs a matching down on the same element, which the drag
            // started elsewhere.
            onPointerUp={(event) => {
              if (!props.wiring) return;
              event.stopPropagation();
              props.onDropWire(port);
            }}
            onClick={(event) => {
              // Not wiring: a click on a filled port frees it. Stopped so the
              // node's own select handler does not also fire.
              event.stopPropagation();
              if (!props.wiring && heldPorts[port]) props.onDisconnect(port);
            }}
            title={
              heldPorts[port]
                ? t("canvas.actions.disconnect", { port: portLabel(port) })
                : portLabel(port)
            }
          />
        ))}
      </div>

      <button
        type="button"
        className="canvas-port out"
        aria-label={t("canvas.outputAria", { id: node.id })}
        onPointerDown={props.onStartWire}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
