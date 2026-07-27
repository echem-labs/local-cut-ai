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
import { CheckpointBanner } from "../components/CheckpointBanner";
import { Dropdown } from "../components/Dropdown";
import { ToolSession } from "../components/ToolSession";
import { Workspace } from "../components/Workspace";
import { t } from "../i18n";
import { finalizeEta, recordBoard } from "../lib/eta";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { isSettled } from "../lib/status";
import { useWorkspace } from "../lib/workspace";
import { useApp } from "../store";

/** One pipeline stage in the header: done ✓ · working ● · failed ! · —. */
function stageOf(node: NodeState | null | undefined): "done" | "work" | "fail" | "off" {
  if (!node) return "off";
  if (isSettled(node.status)) return "done";
  if (node.status === "rendering" || node.status === "queued") return "work";
  if (node.status === "failed") return "fail";
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

/** Header overflow menu (⋯): audio behavior, caption mode, pro-editor
 * handoff, and layout reset. */
function BoardMenu() {
  const { board, client, currentProject, applyTimeline, applyExport } = useApp();
  const resetLayout = useWorkspace((state) => state.resetLayout);
  const [open, setOpen] = useState(false);
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
    </div>
  );
}

/** Project window: header chrome over the dockable workspace (board,
 * monitor, details, timeline). Tool sessions get a focused single panel. */
export function Project() {
  const { currentProject, board, refreshBoard, finalize, client } = useApp();
  const view = useWorkspace((state) => state.view);
  const setView = useWorkspace((state) => state.setView);
  const density = useWorkspace((state) => state.density);
  const setDensity = useWorkspace((state) => state.setDensity);
  const [finalizing, setFinalizing] = useState(false);

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
          <h1>{currentProject.title}</h1>
        </div>
        <ToolSession />
      </div>
    );
  }

  const scenes = orderedScenes(board);

  // The header's pipeline indicator: the project's story arc at a glance.
  const clipDone = scenes.filter((scene) => isSettled(scene.clip.status)).length;
  const clipFailed = scenes.filter((scene) => scene.clip.status === "failed").length;
  const clipsRendering = scenes.some(
    (scene) => scene.clip.status === "rendering" || scene.clip.status === "queued",
  );
  const keyframesAllReady =
    scenes.length > 0 &&
    scenes.every((scene) => !scene.keyframe || isSettled(scene.keyframe.status));
  const audioNodes = [board.aux.voiceover, board.aux.music].filter(
    (node): node is NodeState => Boolean(node),
  );
  const audioStage =
    audioNodes.length === 0
      ? ("off" as const)
      : audioNodes.every((node) => isSettled(node.status))
        ? ("done" as const)
        : audioNodes.some((node) => node.status === "failed")
          ? ("fail" as const)
          : ("work" as const);
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
    {
      id: "storyboard",
      state: scenes.length === 0 ? "off" : keyframesAllReady ? "done" : "work",
    },
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
                scenes.find((scene) => !isSettled(scene.clip.status)) ?? scenes[0];
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
      (approvals.includes("script") && !approvals.includes("storyboard") && keyframesAllReady));
  const allReady =
    scenes.length > 0 && scenes.every((scene) => isSettled(scene.clip.status));
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
        <h1>{currentProject.title}</h1>
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
            <div className="seg-toggle view-switch" role="group" aria-label={t("project.viewAria")}>
              <button
                className={view === "storyboard" ? "active" : ""}
                onClick={() => setView("storyboard")}
                title={t("project.view.storyboardTitle")}
              >
                <LayoutGrid size={12} strokeWidth={1.8} />
                {t("project.view.storyboard")}
              </button>
              <button
                className={view === "player" ? "active" : ""}
                onClick={() => setView("player")}
                title={t("project.view.playerTitle")}
              >
                <MonitorPlay size={12} strokeWidth={1.8} />
                {t("project.view.player")}
              </button>
              <button
                className={view === "flowchart" ? "active" : ""}
                onClick={() => setView("flowchart")}
                title={t("project.view.flowchartTitle")}
              >
                <Workflow size={12} strokeWidth={1.8} />
                {t("project.view.flowchart")}
              </button>
            </div>
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
          ) : null)}
      </div>

      {currentProject.mode === "beginner" && <CheckpointBanner />}

      {board.scenes.length === 0 ? (
        <div className="banner">
          {script?.status === "failed"
            ? t("project.scriptFailed", { error: script.error ?? "" })
            : t("project.writingScript")}
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
