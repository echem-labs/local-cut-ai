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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Minus, Plus, Search, X } from "lucide-react";

import type { GraphNode, NodeState } from "../api/types";
import { m, plural, t } from "../i18n";
import { chainOf, searchMatches } from "../lib/canvasFocus";
import { anchoredScroll, clampZoom, fitZoom, stepZoom, wheelZoom } from "../lib/canvasView";
import { useMenuFit } from "../lib/useMenuFit";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePath,
  layoutGraph,
  occupiedPortIndex,
  wouldCycle,
} from "../lib/graphLayout";
import { useApp } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { PanelHelp } from "./Help";
import { MediaThumb } from "./MediaThumb";
import { Tip } from "./Tooltip";

/** The one node the engine refuses to remove (see graph/patch.py): the rest
 * of the pipeline is rebuilt from it, so deleting it would make every other
 * deletion permanent. Checked here as well as there for the same reason the
 * cycle check is — the engine's refusal is what makes it safe, this one is
 * what makes it explicable at the moment the key was pressed. */
const SCRIPT_NODE_ID = "script";

/** What "Add node" offers.
 *
 * Five of the engine's eleven kinds. The others are not additions a person
 * makes: `script` is the one node the pipeline is rebuilt FROM, `scene`,
 * `timeline`, `export` and `captions` are structure `expand_screenplay`
 * maintains, and `asset` arrives by upload with its bytes — an empty one
 * would be a node with nothing in it and no way to fill it. */
const ADDABLE_KINDS = ["keyframe", "clip", "narration", "music", "thumbnail"] as const;

/** Kinds whose artifact is a still image, so the node can show it. A clip's
 * artifact is an mp4 and a narration's a wav: both need a player, which is
 * what the Details panel and the storyboard are for. */
const IMAGE_KINDS = new Set(["keyframe", "thumbnail", "asset"]);

/** How far a press may travel and still count as a click rather than a pan
 * (CSS px). No hand holds a mouse perfectly still. */
const PAN_SLOP = 3;

/** Shared, so a node with no incoming edge does not allocate a fresh object
 * on every render (and can be compared by identity by a memoized child). */
const EMPTY_PORTS: Record<string, string> = {};
const NO_VACATED: string[] = [];

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
    // `still` too: a user's image is a real node on the canvas, and without
    // it the only asset the graph shows draws with no status at all.
    for (const slot of [
      scene.keyframe,
      scene.still,
      scene.clip,
      scene.narration,
      ...(scene.clip_takes ?? []),
    ]) {
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

  const addNode = useApp((state) => state.addNode);
  const client = useApp((state) => state.client);

  const [wire, setWire] = useState<PendingWire | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // View transform. Session state, never persisted: a saved zoom would be
  // the first per-machine thing in a project directory whose whole point is
  // that it opens identically elsewhere (see lib/canvasView).
  const [zoom, setZoom] = useState(1);
  // The live zoom, written before the state that renders it.
  //
  // Two presses of − in one task are ONE React batch, so a handler reading
  // the rendered `zoom` computes both from the same number and the second
  // press does nothing. A wheel spins several events per frame and loses
  // most of them the same way. Handlers read and write this; `zoom` exists
  // to re-render.
  const zoomRef = useRef(1);
  // Where a zoom should leave the scroll, computed from the event that
  // caused it and applied after the DOM has the new scale — otherwise the
  // scroll is set against the old stage size and the graph jumps.
  const anchorRef = useRef<{
    gx: number;
    gy: number;
    cx: number;
    cy: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  // Which match Enter goes to next; reset whenever the query changes.
  const [matchAt, setMatchAt] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const fit = useMenuFit();
  const addRef = useRef<HTMLDivElement>(null);
  // Drag-to-pan: the grab point and the scroll it started from. A ref, not
  // state — it is read on every pointermove and re-rendering per frame to
  // store a number nothing draws would be a wasted render each time.
  const panRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    /** Whether the press ever became a drag. A press that did not is a
     * click on empty space, which clears the selection. */
    moved: boolean;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  // Deleting a node is the one edit here with no way back: `add_node` has no
  // UI at all, so a structural node (export, timeline, script) removed by a
  // stray Delete leaves a project that can never finish a cut. ConfirmDialog
  // is what the app already puts in front of acts like that, and Backspace on
  // a focused element is a reflex key, not a decision.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Ports emptied by a click here, kept as drop targets afterwards.
  //
  // A node's ports are derived from the edges it HAS (see portsFor), which
  // made disconnect a one-way door: unwire a clip's `keyframe` and the
  // keyframe port stops being drawn, so the only remaining target is
  // `default` — which the clip backends ignore, leaving the scene rendering
  // with no conditioning image and no error. Remembering what was just
  // vacated is what makes the unwire undoable in the session that did it.
  const [vacated, setVacated] = useState<Record<string, string[]>>({});
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Fetch on mount and whenever the project changes. The storyboard never
  // needs the graph, so this is the only thing that asks for it.
  useEffect(() => {
    if (projectId) void refreshGraph();
    // A vacated port belongs to the project it was vacated in; carrying the
    // set across would draw ports on nodes of a graph that never had them.
    setVacated({});
  }, [projectId, refreshGraph]);

  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const statuses = useMemo(() => statusIndex(board), [board]);
  // One pass over the edges for the whole graph, not one pass per node
  // inside the render loop: that was O(nodes x edges) redone on every
  // pointermove of a drag and every progress tick of a live render.
  const occupied = useMemo(() => occupiedPortIndex(graph), [graph]);

  /** Pointer position in GRAPH coordinates — scroll and zoom removed.
   *
   * The wire's live end is drawn inside the stage, which is scaled, so it
   * has to be positioned in the stage's own units. Dividing by the zoom is
   * what keeps the curve under the pointer at any magnification. */
  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const box = surface.getBoundingClientRect();
    return {
      x: (event.clientX - box.left + surface.scrollLeft) / zoom,
      y: (event.clientY - box.top + surface.scrollTop) / zoom,
    };
  };

  /** Zoom, keeping the graph point under the pointer where it is.
   *
   * `compute` takes the LIVE zoom rather than a finished number, so a second
   * press in the same batch steps from where the first one left it. */
  const zoomAt = (
    compute: (from: number) => number,
    event: { clientX: number; clientY: number },
  ) => {
    const from = zoomRef.current;
    const next = compute(from);
    if (next === from) return;
    const surface = surfaceRef.current;
    if (surface) {
      const box = surface.getBoundingClientRect();
      const cx = event.clientX - box.left;
      const cy = event.clientY - box.top;
      anchorRef.current = {
        gx: (cx + surface.scrollLeft) / from,
        gy: (cy + surface.scrollTop) / from,
        cx,
        cy,
      };
    }
    zoomRef.current = next;
    setZoom(next);
  };

  /** A −/+ press has no pointer, so it holds the middle of the view. */
  const zoomFromCentre = (compute: (from: number) => number) => {
    const surface = surfaceRef.current;
    if (!surface) {
      const next = compute(zoomRef.current);
      zoomRef.current = next;
      setZoom(next);
      return;
    }
    const box = surface.getBoundingClientRect();
    zoomAt(compute, {
      clientX: box.left + surface.clientWidth / 2,
      clientY: box.top + surface.clientHeight / 2,
    });
  };

  // Applied after paint, against the stage that now carries the new scale.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!surface || !anchor) return;
    const { left, top } = anchoredScroll(
      { gx: anchor.gx, gy: anchor.gy },
      { cx: anchor.cx, cy: anchor.cy },
      zoom,
    );
    surface.scrollLeft = left;
    surface.scrollTop = top;
  }, [zoom]);

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

  // The selected node's transitive cone, and the search's hits. Both are set
  // arithmetic over the graph (lib/canvasFocus) — memoized because they are
  // read once per node inside the render loop.
  const chain = useMemo(() => chainOf(graph, selectedNode), [graph, selectedNode]);
  const matches = useMemo(() => searchMatches(graph, query), [graph, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const jumpToMatch = () => {
    if (matches.length === 0) return;
    const at = matchAt % matches.length;
    select(matches[at]!);
    setMatchAt(at + 1);
  };

  const fitToPanel = () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const next = fitZoom(
      { width: layout.width, height: layout.height },
      { width: surface.clientWidth, height: surface.clientHeight },
    );
    zoomRef.current = next;
    setZoom(next);
    // Fit shows the whole graph, so the only scroll that shows all of it is
    // none — no anchor to preserve.
    surface.scrollLeft = 0;
    surface.scrollTop = 0;
  };

  const add = async (kind: string) => {
    setAddOpen(false);
    const error = await addNode(kind);
    // A refusal has to say so: the menu closing over a graph that did not
    // change looks exactly like success.
    setHint(error ?? t("canvas.added", { kind: kindLabel(kind) }));
  };

  // Escape clears the selection, and with it the chain focus. Window-level
  // for the same reason the wire's Escape is: the surface has no focus of
  // its own, so an onKeyDown there only fires for a focused descendant.
  useEffect(() => {
    if (!selectedNode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A wire in flight owns Escape first — that handler cancels the wire
      // and leaves the selection alone.
      if (wire) return;
      // So does an open menu: one key press dismisses the thing most
      // recently opened, not two things at once.
      if (addOpen) return;
      // Not while typing in the search box: Escape there clears the query.
      if (document.activeElement?.classList.contains("canvas-search-input")) return;
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNode, wire, addOpen, select]);

  // The Add node menu dismisses like every other menu-pop in the app
  // (ModelsPopover, the Library's sort menu, a tile's lifecycle menu): an
  // outside press, or Escape. Without it this was the one popover that
  // stayed open over the canvas it had just changed.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // Whether the surface is on screen at all — the three states below return
  // before it renders, and the wheel listener has to wait for it.
  const hasSurface = graph !== null && layout.nodes.length > 0;

  // Ctrl+wheel zoom, as a NATIVE listener rather than React's `onWheel`.
  //
  // React registers `wheel` on the root container with `passive: true`
  // (react-dom's addTrappedEventListener, alongside touchstart/touchmove),
  // so `preventDefault` inside an onWheel handler is ignored: Chromium logs
  // "Unable to preventDefault inside passive event listener invocation" as a
  // console ERROR and the browser's own ctrl+wheel zoom is left unsuppressed
  // — the app scaling underneath a canvas that is also scaling. Only a
  // listener registered `{ passive: false }` can refuse it, and only the
  // element's own listener can be registered that way.
  //
  // The handler reads zoom through zoomRef and writes through setZoom, both
  // stable for the life of the component, so it does not need rebinding on
  // every zoom — which at wheel frequency is the point.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!hasSurface || !surface) return;
    const onWheel = (event: WheelEvent) => {
      // A bare wheel is the surface's own scroll — the gesture a plain
      // mouse has for moving around a graph taller than the panel — and
      // taking it would leave no way to scroll at all.
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomAt((from) => wheelZoom(from, event.deltaY), event);
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSurface]);

  // Keyed on whether a wire exists rather than on the wire itself: the live
  // end is rewritten on every pointermove, so depending on the object would
  // rebind the listener below at pointer-event frequency.
  const wiring = wire !== null;

  // The surface's own pointerup only sees a release INSIDE it. Let go over
  // the toolbar, over the Details panel, or outside the window entirely and
  // the wire never ended — it kept following the pointer, and the next
  // release over any port then completed a connection nobody was drawing.
  useEffect(() => {
    if (!wiring) return;
    const abandon = (event: Event) => {
      // A release on an input port is a DROP, and that port's own handler
      // owns it — including the hint it leaves behind. This is only the
      // backstop for a release that landed nowhere at all.
      const target = event.target;
      if (target instanceof Element && target.closest(".canvas-ports.in")) return;
      setWire(null);
      setHint(null);
    };
    // Escape belongs here too, for the same reason. The surface's own
    // onKeyDown can only fire for a focused descendant, and startWire calls
    // preventDefault on the port's pointerdown — which suppresses the
    // compatibility mousedown that would have focused it. So during a
    // mouse-drawn wire focus is still wherever it was, and the one key that
    // cancels never reached the handler. Window-level, like every other
    // Escape in the app (Palette, Inspector, ConfirmDialog, Help).
    const onEscape = (event: KeyboardEvent) => {
      // Not via `abandon`: its port check is about where a POINTER was
      // released, and would swallow Escape whenever a port happens to hold
      // focus.
      if (event.key !== "Escape") return;
      setWire(null);
      setHint(null);
    };
    window.addEventListener("pointerup", abandon);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerup", abandon);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("keydown", onEscape);
    };
  }, [wiring]);

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

        <div className="canvas-search">
          <Search size={12} strokeWidth={1.8} aria-hidden="true" />
          <input
            className="canvas-search-input"
            value={query}
            placeholder={t("canvas.searchPlaceholder")}
            aria-label={t("canvas.searchAria")}
            // The Enter hint lives here rather than in the tally beside the
            // field: it is the same sentence on every keystroke, and the bar
            // is the narrowest row in the app.
            //
            // The browser's tooltip on purpose, like the timeline's timecode
            // box. `Tip` shows on `:focus-visible`, which Chromium matches
            // for a TEXT input however it was focused, so the bubble would
            // sit over the canvas for as long as a search is being typed.
            title={t("canvas.searchHint")}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchAt(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                jumpToMatch();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        {/* The tally sits BESIDE the field, not inside it. Inside, the field
            grew when you typed and grew again when the count changed length
            — a text box that resizes under the cursor mid-word. */}
        {query.trim() && (
          <span className="canvas-search-count">
            {matches.length === 0
              ? t("canvas.noMatches")
              : plural("canvas.matches", matches.length)}
          </span>
        )}

        {hint && <span className="canvas-hint">{hint}</span>}

        <div className="canvas-zoom" role="group" aria-label={t("canvas.title")}>
          <button
            type="button"
            aria-label={t("canvas.zoomOut")}
            onClick={() => zoomFromCentre((from) => stepZoom(from, -1))}
          >
            <Minus size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <span
            className="canvas-zoom-value"
            role="status"
            aria-label={t("canvas.zoomValueAria", {
              pct: Math.round(zoom * 100),
            })}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label={t("canvas.zoomIn")}
            onClick={() => zoomFromCentre((from) => stepZoom(from, +1))}
          >
            <Plus size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button type="button" aria-label={t("canvas.zoomFit")} onClick={fitToPanel}>
            {t("canvas.fit")}
          </button>
        </div>

        <div className="canvas-add" ref={addRef}>
          <button
            type="button"
            className="btn-ghost"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            aria-label={t("canvas.addNodeAria")}
            onClick={() => setAddOpen(!addOpen)}
          >
            <Plus size={12} strokeWidth={2} aria-hidden="true" />
            {t("canvas.addNode")}
          </button>
          {addOpen && (
            <div className="menu-pop" role="menu" ref={fit}>
              {ADDABLE_KINDS.map((kind) => (
                <button key={kind} type="button" role="menuitem" onClick={() => void add(kind)}>
                  <span className="grow">{kindLabel(kind)}</span>
                  <small>{(m().canvas.kindHints as Record<string, string>)[kind]}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <PanelHelp panel="canvas" />
      </div>
      <div
        className={`canvas-surface${panning ? " panning" : ""}`}
        ref={surfaceRef}
        onKeyDown={onSurfaceKeyDown}
        // The wheel is handled natively (see the effect above); React's own
        // onWheel cannot preventDefault.
        onPointerDown={(event) => {
          // Empty space only: a press on a node, a port or the toolbar is
          // that control's own gesture.
          if (wire || event.button !== 0) return;
          if (event.target instanceof Element && event.target.closest(".canvas-node")) return;
          const surface = surfaceRef.current;
          if (!surface) return;
          panRef.current = {
            x: event.clientX,
            y: event.clientY,
            left: surface.scrollLeft,
            top: surface.scrollTop,
            moved: false,
          };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          if (wire) {
            setWire({ ...wire, ...toCanvas(event) });
            return;
          }
          const pan = panRef.current;
          const surface = surfaceRef.current;
          if (!pan || !surface) return;
          // A few pixels of travel while pressing is a click, not a drag —
          // no mouse is perfectly still. Past that it is a pan, and the
          // release must not also clear the selection.
          if (!pan.moved && Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > PAN_SLOP) {
            pan.moved = true;
          }
          // Scroll the opposite way to the drag: the graph follows the hand.
          surface.scrollLeft = pan.left - (event.clientX - pan.x);
          surface.scrollTop = pan.top - (event.clientY - pan.y);
        }}
        // Releasing anywhere but on a port abandons the wire. Without this a
        // half-made connection follows the pointer forever.
        onPointerUp={() => {
          const pan = panRef.current;
          panRef.current = null;
          setPanning(false);
          if (wire) {
            setWire(null);
            setHint(null);
            return;
          }
          // A press on empty space that never became a drag is a click on
          // nothing: it clears the selection, and with it the chain focus.
          // The same gesture Escape has, for the hand already on the mouse.
          if (pan && !pan.moved) select(null);
        }}
        onPointerLeave={() => {
          panRef.current = null;
          setPanning(false);
        }}
      >
        {/* A transform does not change the layout box, so without this the
            surface kept scrolling over the full-size graph however far it
            was zoomed out — Fit left a scrollbar over a screen of nothing.
            The sizer carries the SCALED extent; the stage inside it keeps
            graph units, which is what every node's position is in. */}
        <div
          className="canvas-sizer"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="canvas-stage"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
              // From the top-left, not the centre: the scroll offsets that
              // position the stage are measured from that corner, and scaling
              // about the middle slides the graph out from under them.
              transformOrigin: "0 0",
            }}
            // A GROUP, not `application`. `application` takes a screen reader
            // out of browse mode for everything inside — which would undo the
            // reason NodeBox is a group rather than a button (keeping the port
            // buttons individually reachable). Every control here is a real
            // button already, so there is no custom key handling to protect,
            // and `group` is the container role the rest of the app uses.
            role="group"
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
              const held = occupied[placed.id] ?? EMPTY_PORTS;
              return (
                <NodeBox
                  key={placed.id}
                  node={node}
                  state={state}
                  x={placed.x}
                  y={placed.y}
                  selected={selectedNode === placed.id}
                  // Outside the selected node's chain: still legible, just not
                  // competing with it. Nothing dims when nothing is selected.
                  dimmed={chain.size > 0 && !chain.has(placed.id)}
                  matched={matchSet.has(placed.id)}
                  thumbUrl={
                    IMAGE_KINDS.has(node.kind) && state?.artifact_hash && client && projectId
                      ? client.artifactUrl(projectId, state.artifact_hash)
                      : null
                  }
                  wiring={wiring}
                  heldPorts={held}
                  vacatedPorts={vacated[placed.id] ?? NO_VACATED}
                  onSelect={() => select(placed.id)}
                  onStartWire={(event) => startWire(placed.id, event)}
                  onDropWire={(port) => void dropWire(placed.id, port)}
                  // Same reporting as a wire and a delete: an unwire the engine
                  // refuses has to say so, or the edge simply stays on screen
                  // with nothing to explain why the click did nothing.
                  onDisconnect={(port) =>
                    void disconnectPort(placed.id, port).then((error) => {
                      if (error) {
                        setHint(error);
                        return;
                      }
                      // Only once the engine agreed it is gone: keeping the
                      // port drawn is what lets the same click be undone.
                      setVacated((previous) => {
                        const held = previous[placed.id] ?? [];
                        if (held.includes(port)) return previous;
                        return { ...previous, [placed.id]: [...held, port] };
                      });
                    })
                  }
                  onRemove={() => {
                    if (placed.id === SCRIPT_NODE_ID) {
                      setHint(t("canvas.cannotRemove"));
                      return;
                    }
                    setPendingDelete(placed.id);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      {/* The legend the v3 mock puts in the corner the graph flows away
          from: what the selection is doing to the rest of the canvas, and
          the two gestures that have no affordance to discover them by. */}
      <div className="canvas-legend" role="note">
        {selectedNode && graph.nodes[selectedNode] && (
          <b>{t("canvas.chainOf", { id: selectedNode })} ·</b>
        )}
        <span>{t("canvas.panHint")}</span>
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
  /** Outside the selected node's chain. */
  dimmed: boolean;
  /** Hit by the current search. */
  matched: boolean;
  /** The node's own render, when it is a still image. */
  thumbUrl: string | null;
  wiring: boolean;
  heldPorts: Record<string, string>;
  /** Ports this session emptied — still offered, so the unwire is undoable. */
  vacatedPorts: string[];
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
 *
 * `vacated` is what this session emptied. Without it the derivation makes
 * disconnect irreversible — the port disappears with its edge, and the only
 * target left is `default`, which is not the port the backend reads.
 */
function portsFor(node: GraphNode, held: Record<string, string>, vacated: string[]): string[] {
  const ports = new Set<string>([...Object.keys(held), ...vacated]);
  if (node.kind !== "asset" && node.kind !== "script") ports.add("default");
  return [...ports].sort();
}

function NodeBox(props: NodeBoxProps) {
  const { node, state, heldPorts } = props;
  const ports = portsFor(node, heldPorts, props.vacatedPorts);
  const status = state?.status;
  return (
    <div
      // A pin shows as the dot below and as `status-pinned` from the board;
      // there is no third rule keyed on the node's own flag, so emitting one
      // would only be a class nothing styles.
      className={`canvas-node${props.selected ? " selected" : ""}${
        status ? ` status-${status}` : ""
      }${props.dimmed ? " dimmed" : ""}${props.matched ? " match" : ""}`}
      style={{
        left: props.x,
        top: props.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
      // The id, for the walk and the parity rig: every other handle on a
      // node is a translated accessible name.
      data-node={node.id}
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
          // Structural nodes (the script, a scene container) never appear on
          // the board and so have no render state of their own to report.
          status: status ? t(`status.${status}`) : t("canvas.noStatus"),
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
        {/* The node's own render, when it is a still. Decorative, and named
            nowhere: the button's accessible name already says which node
            this is and what state it is in, so a second name here would
            read the id twice. */}
        <MediaThumb className="canvas-node-thumb" src={props.thumbUrl} />
        <span className="canvas-node-text">
          <span className="canvas-node-kind">{kindLabel(node.kind)}</span>
          <span className="canvas-node-id">{node.id}</span>
        </span>
        {/* Live progress, on the node rather than only in the queue tray:
            mid-render is exactly when someone opens the canvas to see which
            part of the pipeline is moving. */}
        {status === "rendering" && (
          <>
            <span className="canvas-node-pct">{Math.round((state?.progress ?? 0) * 100)}%</span>
            <span className="canvas-node-prog" aria-hidden="true">
              <span
                className="canvas-node-bar"
                style={{ width: `${Math.round((state?.progress ?? 0) * 100)}%` }}
              />
            </span>
          </>
        )}
      </button>
      {/* No tooltip of any kind, and the `title` it used to carry was dead:
          the dot is `pointer-events: none` so it can never be hovered, and
          `aria-hidden` so it is not announced either. It is a mark that the
          node is pinned; the inspector's pin button is where that state is
          named and changed. */}
      {node.pinned && (
        <span className="canvas-node-pin" aria-hidden>
          ●
        </span>
      )}

      {/* Delete, as a control rather than only a key. Backspace on a focused
          node was the only way to remove one, which is a thing you have to
          be told; a sibling button (never nested in the body, see above) is
          a thing you can find. It asks first, like the key does. */}
      <Tip label={t("canvas.actions.remove", { id: node.id })} className="canvas-node-del-slot">
        <button
          type="button"
          className="canvas-node-del"
          aria-label={t("canvas.actions.remove", { id: node.id })}
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <X size={11} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </Tip>

      <div className={`canvas-ports in${ports.length > 4 ? " crowded" : ""}`}>
        {ports.map((port) => (
          /* While a wire is out, a filled port is a REPLACEMENT, not a
             disconnect — said on the hover before the release rather than
             leaving the displaced edge to be noticed afterwards. */
          <Tip
            key={port}
            label={portLabel(port)}
            hint={
              !heldPorts[port]
                ? undefined
                : props.wiring
                  ? t("canvas.wiring.replace", { port: portLabel(port) })
                  : t("canvas.actions.disconnect", { port: portLabel(port) })
            }
            side="right"
          >
            <button
              type="button"
              className={`canvas-port${heldPorts[port] ? " filled" : ""}`}
              aria-label={t("canvas.portAria", {
                port: portLabel(port),
                id: node.id,
              })}
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
            />
          </Tip>
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
