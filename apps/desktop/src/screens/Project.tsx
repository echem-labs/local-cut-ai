import {
  Download,
  Grid2x2,
  Grid3x3,
  LayoutGrid,
  MonitorPlay,
  MoreHorizontal,
  Sparkles,
  Square,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NodeState } from "../api/types";
import { Alert } from "../components/Alert";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { NoticeBar } from "../components/NoticeBar";
import { Dropdown } from "../components/Dropdown";
import { SavePoints } from "../components/SavePoints";
import { ToolSession } from "../components/ToolSession";
import { PromotedFrom } from "../components/Provenance";
import { PublishKit } from "../components/PublishKit";
import { Workspace } from "../components/Workspace";
import { m, t } from "../i18n";
import { pendingCheckpoint } from "../lib/checkpoints";
import { EXPORT_FPS_CHOICES, EXPORT_SHORT_SIDE_CHOICES } from "../lib/formats";
import { finalizeEta, recordBoard } from "../lib/eta";
import { isStalled } from "../lib/jobs";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { isDone, isSettled } from "../lib/status";
import { useWorkspace } from "../lib/workspace";
import { useApp } from "../store";

/** One pipeline stage in the header: done ✓ · working ● · failed ! · —.
 *
 * `isDone`, not `isSettled`: a blocked node is settled (nothing is coming
 * from the queue) but has produced nothing, so it falls through to "off" —
 * the same muted dash `cancelled` gets, and for the same reason. Nothing is
 * happening here and there is no result. Ticking it green claimed a project
 * was exported while an unwritten scene held the whole assembly back. */
type Stage = "done" | "work" | "fail" | "off";

function stageOf(node: NodeState | null | undefined): Stage {
  if (!node) return "off";
  if (isDone(node.status)) return "done";
  if (node.status === "rendering" || node.status === "queued") return "work";
  if (node.status === "failed") return "fail";
  return "off";
}

/** The same ladder, for a stage backed by several nodes: a failure anywhere
 * is the honest headline, then all-done, then anything genuinely in flight.
 * Everything else is "off" — nothing is happening and there is no result.
 *
 * Folding `stageOf` rather than restating it, because the storyboard and
 * audio stages restated it and got a different answer: both asked
 * `!isSettled(status)` for "in flight", which is also true of `failed` and
 * `cancelled`, so a keyframe that had failed for good pulsed the `work` dot
 * (`.pipeline .st.work i` animates infinitely) and the `fail` glyph the
 * stage defines was unreachable. That is the same lie about the same node
 * the `off` arm was added to remove, animated.
 *
 * Takes states rather than nodes because the two stages mean different
 * things by a missing one: an absent aux node means the project has no audio
 * stage at all (contributes nothing), while a scene whose keyframe was
 * removed is not an unfinished storyboard (contributes "done"). */
function aggregateStage(states: readonly Stage[]): Stage {
  if (states.length === 0) return "off";
  if (states.includes("fail")) return "fail";
  if (states.every((state) => state === "done")) return "done";
  if (states.includes("work")) return "work";
  return "off";
}

const STAGE_GLYPH = { done: "✓", work: "●", fail: "!", off: "—" } as const;

/** Scene id from a node id ("s3.clip" → "s3"), null for aux nodes. */
const sceneIdOf = (nodeId: string | null | undefined): string | null =>
  nodeId?.includes(".") ? nodeId.split(".")[0] : null;

/** Bring a scene's board card into view (keyboard nav + pipeline jump). */
const scrollToScene = (sceneId: string, options: ScrollIntoViewOptions = { block: "nearest" }) =>
  document.querySelector(`.scene-grid [data-scene="${sceneId}"]`)?.scrollIntoView(options);

const INTRO_KEY = "localcut.pipelineTaught";

// The engine's full closed sets, not a curated subset. A menuitemradio group
// has to be able to show what the node actually holds, and the NL editor, a
// raw /patch and the MCP surface all accept every member — so "export at 25
// fps" left the Frame rate group with NOTHING checked (Auto is unchecked too,
// fps being non-null), reporting a state the menu did not contain.
// Resolution reads large-to-small; formats.ts mirrors both for the contract test.
const BOARD_FPS_CHOICES = EXPORT_FPS_CHOICES;
const BOARD_SHORT_SIDES = [...EXPORT_SHORT_SIDE_CHOICES].reverse();

/** One-time teaching strip on the user's first project: how the pipeline
 * flows, with the live stage highlighted. Structural teaching — no modal
 * tour (spec doc 09 + review 3). */
function PipelineIntro({
  stages,
}: {
  stages: { id: string; state: "done" | "work" | "fail" | "off" }[];
}) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(INTRO_KEY) === "1");
  if (dismissed) return null;
  // Stable ids drive both the displayed label and the stage match — the final
  // step lands on the "export" stage. Never compare on translated text.
  const steps: { id: "script" | "storyboard" | "videos" | "finalCut"; stageId: string }[] = [
    { id: "script", stageId: "script" },
    { id: "storyboard", stageId: "storyboard" },
    { id: "videos", stageId: "videos" },
    { id: "finalCut", stageId: "export" },
  ];
  const stageState = (stageId: string) =>
    stages.find((stage) => stage.id === stageId)?.state ?? "off";
  return (
    <div className="pipeline-intro" role="note" aria-label={t("pipeline.title")}>
      <span className="intro-title">{t("pipeline.title")}</span>
      {steps.map((step, index) => (
        <span key={step.id} className={`intro-step ${stageState(step.stageId)}`}>
          <i>{index + 1}</i>
          <span>
            <b>{t(`pipeline.steps.${step.id}.label`)}</b>
            <small>{t(`pipeline.steps.${step.id}.teach`)}</small>
          </span>
        </span>
      ))}
      <button
        className="icon-btn-sm"
        aria-label={t("common.dismiss")}
        title={t("common.gotItTitle")}
        onClick={() => {
          localStorage.setItem(INTRO_KEY, "1");
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The board says work is coming and the queue disagrees.
 *
 * Kill the engine mid-render, or reconnect to one that restarted, and nodes
 * keep reading `rendering` with nothing behind them — a progress bar that
 * will never move again, and no route back into flight, since an empty
 * `/patch` re-plans nothing. `POST /render` is that route; this is the one
 * place the app can tell it is needed.
 *
 * A `note`, not an `alert`: nothing failed, and the state is true until
 * acted on rather than in response to something the user just did.
 *
 * Silent at a beginner checkpoint. The engine holds every node past an
 * unapproved gate out of the queue on purpose, which from the board alone
 * looks exactly like a lost one — and there the offer would be both a
 * contradiction of the approve banner directly above it and a button that
 * enqueues nothing. Approving is itself the resume: it runs the same
 * enqueue `/render` would.
 */
function StalledNotice() {
  const board = useApp((state) => state.board);
  const jobs = useApp((state) => state.jobs);
  const currentProject = useApp((state) => state.currentProject);
  const resumeRender = useApp((state) => state.resumeRender);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pendingCheckpoint(currentProject, board) !== null) return null;
  if (!isStalled(board, jobs)) return null;
  return (
    <div className="banner stalled" role="note" aria-label={t("project.stalledLabel")}>
      <span>{t("project.stalled")}</span>
      <button
        className="btn-secondary"
        disabled={busy}
        title={t("terms.tips.resume")}
        onClick={() => {
          setError(null);
          setBusy(true);
          void resumeRender()
            .then(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? t("project.resuming") : t("project.resume")}
      </button>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}

/** Header overflow menu (⋯): history, audio behavior, caption mode, export
 * encode choices, pro-editor handoff, and layout reset. */
function BoardMenu() {
  const {
    board,
    client,
    currentProject,
    applyTimeline,
    applyExport,
    history,
    undoEdit,
    redoEdit,
    resumeRender,
  } = useApp();
  const resetLayout = useWorkspace((state) => state.resetLayout);
  const [open, setOpen] = useState(false);
  const [savePointsOpen, setSavePointsOpen] = useState(false);
  // The rows stay enabled off the last known depths (refreshHistory keeps
  // them on a failed poll rather than flashing the affordances), so they are
  // clickable exactly when the engine is unreachable. Discarding the message
  // the action returns made that a no-op with nothing on screen.
  const [historyError, setHistoryError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!board || !currentProject) return null;
  const timeline = board.aux.timeline;
  const exportNode = board.aux.export;
  const ducking = timeline?.params.ducking !== false;
  const beatAlign = timeline?.params.beat_align === true;
  const captions = String(exportNode?.params.captions ?? "burn");
  const fps = typeof exportNode?.params.fps === "number" ? exportNode.params.fps : null;
  const shortSide =
    typeof exportNode?.params.resolution === "number" ? exportNode.params.resolution : null;
  const kindLabel = (kind: string | undefined): string => {
    const catalog = m().project.historyKinds as Record<string, string>;
    return kind && catalog[kind] ? ` — ${catalog[kind]}` : "";
  };

  return (
    <div className="board-menu" ref={ref}>
      <button
        className="icon-btn"
        aria-label={t("project.menu.aria")}
        aria-expanded={open}
        title={t("project.menu.title")}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-label">{t("project.menu.history")}</div>
          <button
            role="menuitem"
            disabled={!history?.undo_depth}
            onClick={() => {
              setHistoryError(null);
              void undoEdit().then(setHistoryError);
            }}
          >
            <span className="check" />
            {t("project.menu.undo")}
            <small>{kindLabel(history?.undo_top?.kind)}</small>
          </button>
          <button
            role="menuitem"
            disabled={!history?.redo_depth}
            onClick={() => {
              setHistoryError(null);
              void redoEdit().then(setHistoryError);
            }}
          >
            <span className="check" />
            {t("project.menu.redo")}
            <small>{kindLabel(history?.redo_top?.kind)}</small>
          </button>
          {historyError && (
            <div role="status" className="banner error">
              {historyError}
            </div>
          )}
          <button
            role="menuitem"
            onClick={() => {
              setSavePointsOpen(true);
              setOpen(false);
            }}
          >
            <span className="check" />
            {t("project.menu.savePoints")}
          </button>
          {/* Always available, not only when the stall is detected: the
              detection reads the board, and the case worth covering is the
              one where the board is wrong about itself. */}
          <button
            role="menuitem"
            onClick={() => {
              setHistoryError(null);
              void resumeRender().then(setHistoryError);
              setOpen(false);
            }}
          >
            <span className="check" />
            {t("project.menu.resume")}
          </button>
          {timeline && (
            <>
              <div className="menu-label">{t("project.menu.audio")}</div>
              <button
                role="menuitemcheckbox"
                aria-checked={ducking}
                title={t("terms.tips.duck")}
                onClick={() => applyTimeline({ ducking: !ducking })}
              >
                <span className="check">{ducking ? "✓" : ""}</span>
                {t("project.menu.duck")}
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={beatAlign}
                title={t("terms.tips.beat")}
                onClick={() => applyTimeline({ beat_align: !beatAlign })}
              >
                <span className="check">{beatAlign ? "✓" : ""}</span>
                {t("project.menu.beat")}
              </button>
            </>
          )}
          {exportNode && (
            <>
              <div className="menu-label">{t("project.menu.captions")}</div>
              <button
                role="menuitemradio"
                aria-checked={captions === "burn"}
                title={t("terms.tips.captionsBurn")}
                onClick={() => applyExport({ captions: "burn" })}
              >
                <span className="check">{captions === "burn" ? "✓" : ""}</span>
                {t("project.menu.captionsOnVideo")}
              </button>
              <button
                role="menuitemradio"
                aria-checked={captions === "sidecar"}
                title={t("terms.tips.captionsSidecar")}
                onClick={() => applyExport({ captions: "sidecar" })}
              >
                <span className="check">{captions === "sidecar" ? "✓" : ""}</span>
                {t("project.menu.captionsSidecar")}
              </button>
              <div className="menu-label">{t("project.menu.frameRate")}</div>
              <button
                role="menuitemradio"
                aria-checked={fps === null}
                onClick={() => applyExport({ fps: null })}
              >
                <span className="check">{fps === null ? "✓" : ""}</span>
                {t("project.menu.fpsAuto")}
              </button>
              {BOARD_FPS_CHOICES.map((choice) => (
                <button
                  key={choice}
                  role="menuitemradio"
                  aria-checked={fps === choice}
                  onClick={() => applyExport({ fps: choice })}
                >
                  <span className="check">{fps === choice ? "✓" : ""}</span>
                  {t("project.menu.fpsValue", { fps: choice })}
                </button>
              ))}
              <div className="menu-label">{t("project.menu.resolution")}</div>
              <button
                role="menuitemradio"
                aria-checked={shortSide === null}
                onClick={() => applyExport({ resolution: null })}
              >
                <span className="check">{shortSide === null ? "✓" : ""}</span>
                {t("project.menu.resolutionAuto")}
              </button>
              {BOARD_SHORT_SIDES.map((choice) => (
                <button
                  key={choice}
                  role="menuitemradio"
                  aria-checked={shortSide === choice}
                  onClick={() => applyExport({ resolution: choice })}
                >
                  <span className="check">{shortSide === choice ? "✓" : ""}</span>
                  {t("project.menu.resolutionValue", { px: choice })}
                </button>
              ))}
            </>
          )}
          {exportNode?.artifact_hash && client && (
            <>
              <div className="menu-label">{t("project.menu.proEditor")}</div>
              <a role="menuitem" href={client.exportUrl(currentProject.id, "otio")} download>
                <span className="check" />
                {t("project.menu.premiereResolve")} <small>.otio</small>
              </a>
              <a role="menuitem" href={client.exportUrl(currentProject.id, "fcpxml")} download>
                <span className="check" />
                {t("project.menu.finalCutPro")} <small>.fcpxml</small>
              </a>
            </>
          )}
          <div className="menu-label">{t("project.menu.workspace")}</div>
          <button
            role="menuitem"
            title={t("project.menu.resetLayoutTitle")}
            onClick={() => {
              resetLayout();
              setOpen(false);
            }}
          >
            <span className="check" />
            {t("project.menu.resetLayout")}
          </button>
        </div>
      )}
      {savePointsOpen && <SavePoints onClose={() => setSavePointsOpen(false)} />}
    </div>
  );
}

/** Project window: header chrome over the dockable workspace (board,
 * monitor, details, timeline). Tool sessions get a focused single panel. */
export function Project() {
  const {
    currentProject,
    board,
    refreshBoard,
    finalize,
    regenerate,
    client,
    actionError,
    dismissActionError,
  } = useApp();
  const view = useWorkspace((state) => state.view);
  const setView = useWorkspace((state) => state.setView);
  const density = useWorkspace((state) => state.density);
  const setDensity = useWorkspace((state) => state.setDensity);
  const [finalizing, setFinalizing] = useState(false);
  // The keyboard path has no control to look at, so a refused undo (409
  // "nothing to undo" after a concurrent CLI edit, 422 for a snapshot that
  // fails the restore gate, or no engine at all) would otherwise be
  // indistinguishable from a board that simply did not move.
  const [historyKeyError, setHistoryKeyError] = useState<string | null>(null);

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  // Session render-timing observations feed the honest CTA estimate and
  // the per-card "about Ns left" labels.
  useEffect(() => {
    if (currentProject && board) recordBoard(currentProject.id, board);
  }, [currentProject, board]);

  // Space = draft preview from the selected scene (or the top); ←/→ move the
  // board selection — anywhere a form control doesn't own the key. Playback
  // stops when the project closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // Settings is an OVERLAY: it does not unmount the project, so this
      // handler stays live underneath it. Without the check, Space in
      // Settings started playback of a video the user cannot even see, and
      // the arrow keys moved a selection on a hidden board. Same for the
      // command palette and any modal — whatever is on top owns the
      // keyboard. Checked against the DOM rather than store state so a
      // layer that manages its own visibility is covered too.
      if (document.querySelector(".settings-layer, .modal-backdrop, .cmdk")) return;
      const formOwned =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      // Ctrl+Z / Ctrl+Shift+Z — graph-level undo/redo. Text fields keep
      // their native text undo; the graph chord only owns the key when no
      // form control does.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (formOwned) return;
        event.preventDefault();
        const state = useApp.getState();
        setHistoryKeyError(null);
        if (event.shiftKey) {
          if (state.history?.redo_depth) void state.redoEdit().then(setHistoryKeyError);
        } else if (state.history?.undo_depth) {
          void state.undoEdit().then(setHistoryKeyError);
        }
        return;
      }
      if (event.code === "Space") {
        if (formOwned || target.tagName === "BUTTON") return;
        event.preventDefault();
        const playback = usePlayback.getState();
        if (playback.playing) {
          playback.pause();
          return;
        }
        const state = useApp.getState();
        if (!state.board || state.board.scenes.length === 0) return;
        const ids = orderedScenes(state.board).map((scene) => scene.scene_id);
        const selectedScene = sceneIdOf(state.selectedNode);
        const start =
          playback.sceneId ??
          (selectedScene && ids.includes(selectedScene) ? selectedScene : ids[0]);
        state.select(`${start}.clip`);
        playback.play(start, true);
        return;
      }
      if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
        // Same exclusions as Space: a focused button keeps its keyboard.
        if (formOwned || target.tagName === "BUTTON") return;
        const state = useApp.getState();
        if (!state.board || state.board.scenes.length === 0) return;
        const scenes = orderedScenes(state.board);
        const current = sceneIdOf(state.selectedNode);
        const index = current ? scenes.findIndex((s) => s.scene_id === current) : -1;
        const next =
          event.code === "ArrowRight"
            ? Math.min(scenes.length - 1, index + 1)
            : Math.max(0, index === -1 ? 0 : index - 1);
        if (next === index) return;
        event.preventDefault();
        const scene = scenes[next];
        state.select(scene.keyframe ? scene.keyframe.node_id : scene.clip.node_id);
        requestAnimationFrame(() => scrollToScene(scene.scene_id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      usePlayback.getState().stop();
    };
  }, []);

  if (!currentProject || !board) return null;
  const script = board.aux.script;

  if (currentProject.mode.startsWith("tool:")) {
    return (
      <div className="tool-shell">
        <div className="board-header">
          {/* A tool project is titled by its own ask, so this line is
              routinely longer than the column and ellipsizes. The native
              tooltip (not our Tip bubble) is what can wrap a paragraph. */}
          <h1 title={currentProject.title}>{currentProject.title}</h1>
        </div>
        {/* The script-shortfall notice lives on the tool node — without this
            the tool screen was the one place it never showed. */}
        <NoticeBar />
        <ToolSession />
      </div>
    );
  }

  const scenes = orderedScenes(board);

  // The header's pipeline indicator: the project's story arc at a glance.
  // Everything counted here is REPORTED as progress, so it asks isDone — a
  // scene nobody has written yet is not one of the videos that are ready.
  const clipDone = scenes.filter((scene) => isDone(scene.clip.status)).length;
  const clipFailed = scenes.filter((scene) => scene.clip.status === "failed").length;
  const clipsRendering = scenes.some(
    (scene) => scene.clip.status === "rendering" || scene.clip.status === "queued",
  );
  // Nothing is coming and nothing was made: the stage is `off`, not `work`.
  // Falling through to `work` gave a blocked keyframe a pulsing accent dot
  // that never stops, which is the same lie as the green tick, animated —
  // and `aggregateStage` is what keeps that answer the same one `stageOf`
  // gives for `failed` and `cancelled` too.
  const storyboardStage = aggregateStage(
    scenes.map((scene) => (scene.keyframe ? stageOf(scene.keyframe) : "done")),
  );
  // The beginner checkpoint is a gate, not a report: it asks isSettled so it
  // opens on a keyframe that is never coming (see lib/status.ts). Splitting
  // the two is the point — the banner must not hang, and the header must not
  // claim a storyboard is finished when a scene is still waiting on a prompt.
  const keyframesAllSettled =
    scenes.length > 0 &&
    scenes.every((scene) => !scene.keyframe || isSettled(scene.keyframe.status));
  const audioStage = aggregateStage(
    [board.aux.voiceover, board.aux.music]
      .filter((node): node is NodeState => Boolean(node))
      .map(stageOf),
  );
  const exportNode = board.aux.export;
  const stages: {
    // Stable id: matched on for logic AND resolves the displayed label via
    // t("project.stages.<id>"). Never compare on the translated label.
    id: "script" | "storyboard" | "videos" | "audio" | "export";
    state: "done" | "work" | "fail" | "off";
    detail?: string;
    // A stage with a landing surface renders as a button (review 3 §3A).
    onClick?: () => void;
    hint?: string;
  }[] = [
    { id: "script", state: stageOf(script) },
    { id: "storyboard", state: storyboardStage },
    {
      id: "videos",
      state:
        clipFailed > 0
          ? "fail"
          : scenes.length > 0 && clipDone === scenes.length
            ? "done"
            : clipsRendering
              ? "work"
              : "off",
      detail:
        scenes.length > 0
          ? t("project.stages.videosDetail", { done: clipDone, total: scenes.length }) +
            (clipFailed > 0 ? t("project.stages.videosFailed", { failed: clipFailed }) : "")
          : undefined,
      onClick:
        scenes.length > 0
          ? () => {
              const target =
                scenes.find((scene) => !isDone(scene.clip.status)) ?? scenes[0];
              scrollToScene(target.scene_id, { behavior: "smooth", block: "center" });
            }
          : undefined,
      hint: t("project.stages.videosHint"),
    },
    { id: "audio", state: audioStage },
    { id: "export", state: stageOf(exportNode) },
  ];

  // The screen's ONE primary action, staged per doc 09 (Review → Create
  // final video → Download). Suppressed while a beginner checkpoint banner
  // owns the accent.
  const approvals = currentProject.approvals ?? [];
  const scriptReady = script ? isSettled(script.status) : false;
  const checkpointPending =
    currentProject.mode === "beginner" &&
    ((!approvals.includes("script") && scriptReady) ||
      (approvals.includes("script") && !approvals.includes("storyboard") && keyframesAllSettled));
  // The CTA is an offer to do work, so it asks isDone: with a blocked clip
  // there is nothing to enqueue, and the button would refresh the board and
  // change nothing — a primary action that silently does nothing at all.
  const allReady = scenes.length > 0 && scenes.every((scene) => isDone(scene.clip.status));
  const exported = exportNode?.status === "final" && exportNode.artifact_hash;
  // "~9 min", from renders observed this session — absent until we've
  // actually watched one (honest ETA, review 3).
  const eta = finalizeEta(board);

  const runFinalize = async () => {
    if (finalizing) return;
    setFinalizing(true);
    try {
      await finalize();
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <div className="project-shell screen-enter">
      <div className="board-header">
        {/* The header is a horizontal toolbar; the provenance line belongs
            UNDER the title, so the two share a column rather than becoming
            a third item on the row. */}
        <div className="board-title">
          <h1 title={currentProject.title}>{currentProject.title}</h1>
          <PromotedFrom project={currentProject} />
        </div>
        <div className="pipeline" role="status" aria-label={t("project.progressAria")}>
          {stages.map((stage) => {
            const inner = (
              <>
                <i aria-hidden="true">{STAGE_GLYPH[stage.state]}</i>
                {t(`project.stages.${stage.id}`)}
                {stage.detail ? <small>{stage.detail}</small> : null}
              </>
            );
            return stage.onClick ? (
              <button
                key={stage.id}
                className={`st ${stage.state}`}
                title={stage.hint}
                onClick={stage.onClick}
              >
                {inner}
              </button>
            ) : (
              <span key={stage.id} className={`st ${stage.state}`}>
                {inner}
              </span>
            );
          })}
        </div>
        {board.scenes.length > 0 && (
          <>
            {/* One picker, not three buttons: the views are mutually
                exclusive and only one can be current, which is what a
                dropdown says and a row of toggles only implies. It also
                stops the header growing a segment every time a view is
                added, beside the tile-size picker that already works this
                way. */}
            <Dropdown
              value={view}
              ariaLabel={t("project.viewAria")}
              options={[
                {
                  value: "storyboard",
                  label: t("project.view.storyboard"),
                  icon: LayoutGrid,
                },
                { value: "player", label: t("project.view.player"), icon: MonitorPlay },
                { value: "flowchart", label: t("project.view.flowchart"), icon: Workflow },
              ]}
              onChange={setView}
            />
            <Dropdown
              value={density}
              ariaLabel={t("project.tileSize.aria")}
              options={[
                { value: "s", label: t("project.tileSize.small"), icon: Grid3x3 },
                { value: "m", label: t("project.tileSize.medium"), icon: Grid2x2 },
                { value: "l", label: t("project.tileSize.large"), icon: Square },
              ]}
              onChange={setDensity}
            />
          </>
        )}
        <BoardMenu />
        {!checkpointPending &&
          (exported && client ? (
            <a
              className="btn-primary"
              style={{ textDecoration: "none" }}
              href={client.artifactUrl(currentProject.id, exportNode.artifact_hash!)}
              download
            >
              <Download size={14} strokeWidth={2} />
              {t("project.cta.download")}
            </a>
          ) : allReady ? (
            <button
              className="btn-primary"
              disabled={finalizing}
              onClick={() => void runFinalize()}
              title={t("terms.tips.createFinal")}
            >
              <Sparkles size={14} strokeWidth={2} />
              {finalizing
                ? t("project.cta.creating")
                : eta
                  ? t("project.cta.createWithEta", { eta })
                  : t("project.cta.create")}
            </button>
          ) : scenes.length > 0 ? (
            /* Present but not pressable, rather than absent. The screen's
               one primary action used to vanish while the videos rendered
               and reappear when they finished, which reads as the app
               having lost it — and left nothing on screen to say what the
               final cut is waiting for. */
            <button
              className="btn-primary"
              disabled
              title={t("project.cta.pendingTitle", { done: clipDone, total: scenes.length })}
            >
              <Sparkles size={14} strokeWidth={2} />
              {t("project.cta.pending", { done: clipDone, total: scenes.length })}
            </button>
          ) : null)}
      </div>

      {currentProject.mode === "beginner" && <CheckpointBanner />}
      <NoticeBar />
      <StalledNotice />
      {/* Only once there is a video to publish. Offering to write a title
          for a cut that does not exist yet puts the last step first, and the
          engine refuses it anyway while the script is unrendered. */}
      {exported && <PublishKit />}
      {historyKeyError && (
        <div role="status" className="banner error">
          {historyKeyError}
        </div>
      )}
      {/* A project-level action fired from the command palette, which closes
          on run and so has nowhere to report a refusal. "Prepare to publish"
          before the script has rendered is the one that happens: the engine
          answers with the reason, and this is where it lands. */}
      {actionError?.scope === "board" && (
        <Alert message={actionError.message} onDismiss={dismissActionError} />
      )}

      {board.scenes.length === 0 ? (
        <div className="banner">
          {script?.status === "failed" ? (
            <>
              {t("project.scriptFailed", { error: script.error ?? "" })}
              {/* With no scenes there is no board, composer or inspector to
                  regenerate from — the banner is the only surface left, so
                  it carries the retry itself. */}
              <button className="btn-secondary" onClick={() => void regenerate("script")}>
                {t("project.retryScript")}
              </button>
            </>
          ) : (
            t("project.writingScript")
          )}
        </div>
      ) : (
        <>
          <PipelineIntro stages={stages} />
          <Workspace />
        </>
      )}
    </div>
  );
}
