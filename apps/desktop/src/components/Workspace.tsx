import { DockviewDefaultTab, DockviewReact, themeDark } from "dockview-react";
import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import "dockview-core/dist/styles/dockview.css";
import { useEffect, useRef, useState } from "react";
import { t, type MessageKey } from "../i18n";
import { movedOrder, orderedScenes } from "../lib/order";
import { useWorkspace, type WorkspaceView } from "../lib/workspace";
import { useApp } from "../store";
import { Composer } from "./Composer";
import { PanelHelp } from "./Help";
import { Inspector } from "./Inspector";
import { Monitor } from "./Monitor";
import { NodeCanvas } from "./NodeCanvas";
import { SceneCard } from "./SceneCard";
import { TimelineStrip } from "./TimelineStrip";
import { Tip } from "./Tooltip";

/** Our token-mapped dockview theme (CSS in app.css). */
const THEME = { ...themeDark, name: "localcut", className: "dockview-theme-localcut" };

// Bumping the version retires everyone's saved layouts once so a new
// default (v3: rebalanced prompt/board split) actually shows up —
// "Reset layout" would otherwise be required.
const LAYOUT_VERSION = "v3";
const layoutKey = (view: WorkspaceView) => `localcut.layout.${LAYOUT_VERSION}.${view}`;

// Default row heights (group incl. tab bar). The board takes the rest.
const COMPOSER_H = 160;
const TIMELINE_H = 200;

// Sash floors: below these, fixed chrome (the composer's controls row,
// the timeline's transport and clip strip) clips away instead of
// shrinking — the textarea alone absorbs composer shrinkage. The composer
// floor also reserves a line for the feedback hint that renders below the
// box after an edit; without the reserve the hint squeezes the box and
// pushes the controls through its border.
const COMPOSER_MIN_H = 156;
const TIMELINE_MIN_H = 170;

/** Pin a minimum height on the panel's current GROUP, following re-docks.
 * Sash drags then stop at the floor instead of clipping the content, and
 * a drag past the floor pushes the next sash (dockview propagation). */
function useGroupMinHeight(api: IDockviewPanelProps["api"], minimumHeight: number) {
  useEffect(() => {
    const apply = () => {
      api.group.api.setConstraints({ minimumHeight });
      // setConstraints only governs future sash drags — it does not resize a
      // group that is ALREADY shorter. A layout restored from an older
      // version (or one saved before a floor was raised) therefore keeps its
      // undersized height, and the panel's content, which is bottom-aligned
      // and refuses to shrink below min-content, then paints upward over its
      // own tab strip. Lift it back to the floor.
      if (api.group.api.height < minimumHeight) {
        api.group.api.setSize({ height: minimumHeight });
      }
    };
    apply();
    const disposable = api.onDidGroupChange(apply);
    return () => disposable.dispose();
  }, [api, minimumHeight]);
}

/* ---------- panels ---------- */

const DRAFT_TEACH_KEY = "localcut.draftTaught";

function BoardPanel(_props: IDockviewPanelProps) {
  const { board, applyTimeline, addScene } = useApp();
  const density = useWorkspace((state) => state.density);
  const [dragged, setDragged] = useState<string | null>(null);
  const [addingScene, setAddingScene] = useState(false);
  const [addSceneError, setAddSceneError] = useState<string | null>(null);
  const [draftTaught, setDraftTaught] = useState(
    () => localStorage.getItem(DRAFT_TEACH_KEY) === "1",
  );
  // The one-time draft-quality note rides the FIRST rendering card and
  // retires when THAT scene's render completes (or on dismiss) — it must
  // neither hop to the next rendering card nor retire early on a poll that
  // lands in a gap between renders.
  const scenes = board ? orderedScenes(board) : [];
  const teachShownRef = useRef<string | null>(null);
  const shownScene = teachShownRef.current;
  const teachId = draftTaught
    ? null
    : shownScene
      ? (scenes.find(
          (scene) => scene.scene_id === shownScene && scene.clip.status === "rendering",
        )?.scene_id ?? null)
      : (scenes.find((scene) => scene.clip.status === "rendering")?.scene_id ?? null);
  const markTaught = () => {
    localStorage.setItem(DRAFT_TEACH_KEY, "1");
    setDraftTaught(true);
  };
  useEffect(() => {
    if (teachId) teachShownRef.current = teachId;
    else if (teachShownRef.current) markTaught();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachId]);

  if (!board) return null;
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
      <div className="board-help">
        <PanelHelp panel="board" />
      </div>
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
              teachDraft={scene.scene_id === teachId}
              onTeachDismiss={markTaught}
            />
          ))}
          {scenes.length > 0 && (
            <Tip label={t("scene.addScene")} hint={t("scene.addSceneTitle")}>
              <button
                className="scene-card scene-add"
                disabled={addingScene}
                onClick={() => {
                  setAddingScene(true);
                  setAddSceneError(null);
                  void addScene()
                    .then((error) => setAddSceneError(error))
                    .finally(() => setAddingScene(false));
                }}
              >
                <span aria-hidden="true">+</span>
                {t("scene.addScene")}
              </button>
            </Tip>
          )}
        </div>
        {addSceneError && <div role="status">{addSceneError}</div>}
      </div>
    </div>
  );
}

/** The composer as its own dockable panel — drag its top sash to give the
 * prompt more lines, or dock it anywhere like the other panels. */
function ComposerPanel(props: IDockviewPanelProps) {
  useGroupMinHeight(props.api, COMPOSER_MIN_H);
  return (
    <div className="composer-panel">
      <Composer />
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

/** The flowchart view's document panel. Like the board it is the center of
 * its view, so it is registered the same way and locked the same way. */
function CanvasPanel(_props: IDockviewPanelProps) {
  return <NodeCanvas />;
}

function TimelinePanel(props: IDockviewPanelProps) {
  useGroupMinHeight(props.api, TIMELINE_MIN_H);
  return (
    <div className="timeline-panel">
      <TimelineStrip />
    </div>
  );
}

const PANEL_COMPONENTS = {
  board: BoardPanel,
  canvas: CanvasPanel,
  monitor: MonitorPanel,
  inspector: InspectorPanel,
  timeline: TimelinePanel,
  composer: ComposerPanel,
};

/** Only the Details panel is closable — the structural panels (board,
 * monitor, timeline) are rearranged, never closed. */
function PanelTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose={props.api.id !== "inspector"} />;
}

/** Stable panel id → catalog key. The keys stay module-level; the display
 * title is resolved through t() at each call site (never at module load). */
const PANEL_TITLE_KEYS = {
  board: "workspace.panels.board",
  canvas: "workspace.panels.canvas",
  monitor: "workspace.panels.monitor",
  inspector: "workspace.panels.inspector",
  timeline: "workspace.panels.timeline",
  composer: "workspace.panels.composer",
} as const satisfies Record<keyof typeof PANEL_COMPONENTS, MessageKey>;

const panelTitle = (id: keyof typeof PANEL_TITLE_KEYS): string => t(PANEL_TITLE_KEYS[id]);

/** The center document of a view — the one panel that is always present and
 * never docks away, so everything else has something to dock against. */
type DocumentPanel = "board" | "canvas";
const documentPanel = (view: WorkspaceView): DocumentPanel =>
  view === "flowchart" ? "canvas" : "board";

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
  // The pending layout save, cancellable from outside onReady's closure so a
  // view switch can drop a snapshot of the layout it is replacing.
  const saveTimerRef = useRef<{ cancel: () => void } | null>(null);

  // Board · composer · timeline stack in one vertical branch. dockview's
  // setSize trades space with ADJACENT siblings (like dragging the sash),
  // so sizing composer and timeline against each other just shuttles the
  // excess between them — the board never absorbs it. Instead size the
  // board itself to (workspace − composer − timeline) and let the two
  // fixed rows claim their share from what's left.
  const enforceRowHeights = (api: DockviewApi, documentId: DocumentPanel) => {
    const size = () => {
      const total = api.height;
      if (total > COMPOSER_H + TIMELINE_H + 200) {
        api.getPanel(documentId)?.api.setSize({ height: total - COMPOSER_H - TIMELINE_H });
      }
      api.getPanel("composer")?.api.setSize({ height: COMPOSER_H });
      api.getPanel("timeline")?.api.setSize({ height: TIMELINE_H });
    };
    // setSize during construction is ignored — wait out the initial layout
    // pass first; the second frame corrects any residual redistribution.
    requestAnimationFrame(() => {
      size();
      requestAnimationFrame(size);
    });
  };

  /** The composer docks under the view's DOCUMENT, which is the canvas in the
   * flowchart view — dockview throws for a referencePanel that is not in the
   * layout, so a hardcoded "board" here took the whole flowchart build down
   * with it and left the view holding nothing but the canvas. */
  const addComposer = (api: DockviewApi, documentId: DocumentPanel) => {
    api.addPanel({
      id: "composer",
      component: "composer",
      title: panelTitle("composer"),
      position: { referencePanel: documentId, direction: "below" },
    });
  };

  const buildDefault = (api: DockviewApi, target: WorkspaceView) => {
    busyRef.current = true;
    try {
      api.clear();
      // Each view has ONE center document: the storyboard and player are
      // built around the board, the flowchart around the canvas. Same lock,
      // same role — a view whose document could be dragged away has no
      // anchor for anything else to dock against.
      const documentId = documentPanel(target);
      // Not named `document`: this is a dockview panel, and shadowing the
      // global in the one function that already reaches for element heights
      // is a trap for the next DOM call added below it.
      const documentPane = api.addPanel({
        id: documentId,
        component: documentId,
        title: panelTitle(documentId),
      });
      documentPane.group.locked = true;
      if (target === "player") {
        api.addPanel({
          id: "monitor",
          component: "monitor",
          title: panelTitle("monitor"),
          position: { referencePanel: documentId, direction: "left" },
        });
      }
      addComposer(api, documentId);
      // No reference panel: dock against the root edge so the timeline
      // spans the full workspace width in every view. The strip only needs
      // chip-height blocks; the board gets the room.
      api.addPanel({
        id: "timeline",
        component: "timeline",
        title: panelTitle("timeline"),
        position: { direction: "below" },
        initialHeight: 200,
      });
      enforceRowHeights(api, documentId);
      documentPane.api.setActive();
    } finally {
      busyRef.current = false;
    }
  };

  const restore = (api: DockviewApi, target: WorkspaceView) => {
    const documentId = documentPanel(target);
    const raw = localStorage.getItem(layoutKey(target));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const ids = Object.keys(parsed?.panels ?? {});
        // Per-view document check, not a fixed "board": a flowchart layout
        // restored without its canvas would come up with no document at all,
        // and every later dock would have nothing to reference.
        const valid =
          ids.length > 0 &&
          ids.every((id) => id in PANEL_COMPONENTS) &&
          ids.includes(documentId);
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
          // Layouts saved before the composer became a panel lack it.
          if (!api.getPanel("composer")) {
            busyRef.current = true;
            try {
              addComposer(api, documentId);
            } finally {
              busyRef.current = false;
            }
            enforceRowHeights(api, documentId);
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
      const composer = api.getPanel("composer");
      const composerWasFullHeight = composer
        ? composer.api.height >= api.height - 4
        : true;
      busyRef.current = true;
      try {
        // Root-edge dock (no reference panel): Details opens as a
        // full-height right column beside the whole workspace, not a
        // split confined to the board row.
        api.addPanel({
          id: "inspector",
          component: "inspector",
          title: panelTitle("inspector"),
          position: { direction: "right" },
          initialWidth: 420,
        });
      } finally {
        busyRef.current = false;
      }
      // The root-edge split occasionally hoists the composer out of the
      // document's column into its own full-height column (a dockview
      // re-orientation edge case) — and a save would then make that
      // permanent. If the composer just BECAME full-height, re-dock it.
      const documentId = documentPanel(viewRef.current);
      requestAnimationFrame(() => {
        const hoisted = api.getPanel("composer");
        if (
          !composerWasFullHeight &&
          hoisted &&
          hoisted.api.height >= api.height - 4
        ) {
          busyRef.current = true;
          try {
            api.removePanel(hoisted);
            addComposer(api, documentId);
          } finally {
            busyRef.current = false;
          }
          enforceRowHeights(api, documentId);
        }
      });
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
    //
    // The view is captured WHEN THE CHANGE FIRED, not when the timer expires.
    // `viewRef.current` is assigned during render, but the effect that
    // actually swaps the layout runs after the commit — so a view switch
    // inside the debounce window left a gap where the api still held the
    // outgoing layout while the ref already named the incoming view, and the
    // save wrote one view's panel arrangement over another's.
    api.onDidLayoutChange(() => {
      if (busyRef.current) return;
      saveTimerRef.current?.cancel();
      const view = viewRef.current;
      const handle = setTimeout(() => {
        // Still the same view when the timer fires? If not, this snapshot
        // belongs to a layout that is no longer on screen — drop it.
        if (viewRef.current !== view) return;
        try {
          localStorage.setItem(layoutKey(view), JSON.stringify(api.toJSON()));
        } catch {
          /* storage full — layouts are recoverable from defaults */
        }
      }, 400);
      saveTimerRef.current = { cancel: () => clearTimeout(handle) };
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
    // Drop any save still pending for the OUTGOING view before the layout is
    // replaced under it — belt and braces with the view check in the timer.
    saveTimerRef.current?.cancel();
    saveTimerRef.current = null;
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
