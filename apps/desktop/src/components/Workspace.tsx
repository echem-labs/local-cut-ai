import { DockviewDefaultTab, DockviewReact, themeDark } from "dockview-react";
import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import "dockview-core/dist/styles/dockview.css";
import { useEffect, useRef, useState } from "react";
import { movedOrder, orderedScenes } from "../lib/order";
import { useWorkspace, type WorkspaceView } from "../lib/workspace";
import { useApp } from "../store";
import { Composer } from "./Composer";
import { Inspector } from "./Inspector";
import { Monitor } from "./Monitor";
import { SceneCard } from "./SceneCard";
import { TimelineStrip } from "./TimelineStrip";

/** Our token-mapped dockview theme (CSS in app.css). */
const THEME = { ...themeDark, name: "localcut", className: "dockview-theme-localcut" };

const LAYOUT_VERSION = "v1";
const layoutKey = (view: WorkspaceView) => `localcut.layout.${LAYOUT_VERSION}.${view}`;

/* ---------- panels ---------- */

function BoardPanel(_props: IDockviewPanelProps) {
  const { board, applyTimeline } = useApp();
  const density = useWorkspace((state) => state.density);
  const [dragged, setDragged] = useState<string | null>(null);
  if (!board) return null;
  const scenes = orderedScenes(board);
  const order = scenes.map((scene) => scene.scene_id);

  const dropAt = (targetIndex: number, after: boolean) => {
    if (!dragged) return;
    const from = order.indexOf(dragged);
    let to = after ? targetIndex + 1 : targetIndex;
    if (from < to) to -= 1;
    const next = movedOrder(order, from, to);
    if (next) applyTimeline({ order: next });
    setDragged(null);
  };

  return (
    <div className="board-panel">
      <div className="board-scroll">
        <div className={`scene-grid density-${density}`}>
          {scenes.map((scene, index) => (
            <SceneCard
              key={scene.scene_id}
              scene={scene}
              dragging={dragged === scene.scene_id}
              onDragStart={() => setDragged(scene.scene_id)}
              onDragEnd={() => setDragged(null)}
              onDropSide={(after) => dropAt(index, after)}
            />
          ))}
        </div>
      </div>
      {/* the composer is fixed chrome of the board — every view keeps it */}
      <div className="board-composer">
        <Composer />
      </div>
    </div>
  );
}

function MonitorPanel(_props: IDockviewPanelProps) {
  return (
    <div className="monitor-panel">
      <Monitor variant="panel" />
    </div>
  );
}

function InspectorPanel(_props: IDockviewPanelProps) {
  return <Inspector />;
}

function TimelinePanel(_props: IDockviewPanelProps) {
  return (
    <div className="timeline-panel">
      <TimelineStrip />
    </div>
  );
}

const PANEL_COMPONENTS = {
  board: BoardPanel,
  monitor: MonitorPanel,
  inspector: InspectorPanel,
  timeline: TimelinePanel,
};

/** Only the Details panel is closable — the structural panels (board,
 * monitor, timeline) are rearranged, never closed. */
function PanelTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose={props.api.id !== "inspector"} />;
}

const PANEL_TITLES: Record<string, string> = {
  board: "Storyboard",
  monitor: "Monitor",
  inspector: "Details",
  timeline: "Timeline",
};

/* ---------- workspace ---------- */

/** True drag-docking with guardrails (review 3 + doc 09 amendment): a
 * fixed registry of four named panels, the board locked as the center
 * document, code-defined views (Storyboard · Player) as defaults, layout
 * persisted per view, and Reset always restoring a sane state. */
export function Workspace() {
  const view = useWorkspace((state) => state.view);
  const resetNonce = useWorkspace((state) => state.resetNonce);
  const selectedNode = useApp((state) => state.selectedNode);
  const apiRef = useRef<DockviewApi | null>(null);
  // Guards: programmatic layout churn must not be saved or treated as a
  // user action (fromJSON fires add/remove events for every panel).
  const busyRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const buildDefault = (api: DockviewApi, target: WorkspaceView) => {
    busyRef.current = true;
    try {
      api.clear();
      const board = api.addPanel({ id: "board", component: "board", title: PANEL_TITLES.board });
      board.group.locked = true; // the center document never docks away
      if (target === "player") {
        api.addPanel({
          id: "monitor",
          component: "monitor",
          title: PANEL_TITLES.monitor,
          position: { referencePanel: "board", direction: "left" },
        });
      }
      // No reference panel: dock against the root edge so the timeline
      // spans the full workspace width in every view.
      api.addPanel({
        id: "timeline",
        component: "timeline",
        title: PANEL_TITLES.timeline,
        position: { direction: "below" },
        initialHeight: 150,
      });
      board.api.setActive();
    } finally {
      busyRef.current = false;
    }
  };

  const restore = (api: DockviewApi, target: WorkspaceView) => {
    const raw = localStorage.getItem(layoutKey(target));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const ids = Object.keys(parsed?.panels ?? {});
        const valid =
          ids.length > 0 &&
          ids.every((id) => id in PANEL_COMPONENTS) &&
          ids.includes("board");
        if (valid) {
          busyRef.current = true;
          try {
            api.fromJSON(parsed);
          } finally {
            busyRef.current = false;
          }
          // The inspector's presence is selection-driven, not layout-driven.
          const inspector = api.getPanel("inspector");
          if (inspector && !useApp.getState().selectedNode) {
            busyRef.current = true;
            try {
              api.removePanel(inspector);
            } finally {
              busyRef.current = false;
            }
          }
          return;
        }
      } catch {
        /* corrupt layout — fall through to the default */
      }
      localStorage.removeItem(layoutKey(target));
    }
    buildDefault(api, target);
  };

  const syncInspector = (api: DockviewApi, selected: string | null) => {
    const panel = api.getPanel("inspector");
    if (selected && !panel) {
      busyRef.current = true;
      try {
        api.addPanel({
          id: "inspector",
          component: "inspector",
          title: PANEL_TITLES.inspector,
          position: { referencePanel: "board", direction: "right" },
          initialWidth: 340,
        });
      } finally {
        busyRef.current = false;
      }
    } else if (!selected && panel) {
      busyRef.current = true;
      try {
        api.removePanel(panel);
      } finally {
        busyRef.current = false;
      }
    }
  };

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    restore(api, viewRef.current);
    syncInspector(api, useApp.getState().selectedNode);

    // Persist user-made layout changes per view, debounced.
    let timer: ReturnType<typeof setTimeout> | null = null;
    api.onDidLayoutChange(() => {
      if (busyRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(layoutKey(viewRef.current), JSON.stringify(api.toJSON()));
        } catch {
          /* storage full — layouts are recoverable from defaults */
        }
      }, 400);
    });

    // Closing the Details tab by hand deselects — the two stay in step.
    api.onDidRemovePanel((panel) => {
      if (panel.id === "inspector" && !busyRef.current && useApp.getState().selectedNode) {
        useApp.getState().select(null);
      }
    });
  };

  // View switch → that view's stored layout (or its default).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const api = apiRef.current;
    if (!api) return;
    restore(api, view);
    syncInspector(api, useApp.getState().selectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Reset layout → rebuild the active view from code.
  useEffect(() => {
    if (resetNonce === 0) return;
    const api = apiRef.current;
    if (!api) return;
    localStorage.removeItem(layoutKey(view));
    buildDefault(api, view);
    syncInspector(api, useApp.getState().selectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNonce]);

  // Selection opens/closes the Details panel.
  useEffect(() => {
    const api = apiRef.current;
    if (api) syncInspector(api, selectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode]);

  return (
    <div className="workspace-root">
      <DockviewReact
        components={PANEL_COMPONENTS}
        defaultTabComponent={PanelTab}
        onReady={onReady}
        theme={THEME}
        disableFloatingGroups
      />
    </div>
  );
}
