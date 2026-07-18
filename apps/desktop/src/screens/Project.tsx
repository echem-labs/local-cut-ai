import { Download, LayoutGrid, MonitorPlay, MoreHorizontal, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NodeState } from "../api/types";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { ToolSession } from "../components/ToolSession";
import { Workspace } from "../components/Workspace";
import { TIPS } from "../help/terms";
import { finalizeEta, recordBoard } from "../lib/eta";
import { orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { useWorkspace } from "../lib/workspace";
import { useApp } from "../store";

const READY = ["draft", "final", "pinned"];

/** One pipeline stage in the header: done ✓ · working ● · failed ! · —. */
function stageOf(node: NodeState | null | undefined): "done" | "work" | "fail" | "off" {
  if (!node) return "off";
  if (node.status === "final" || node.status === "pinned" || node.status === "draft")
    return "done";
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
  stages: { label: string; state: "done" | "work" | "fail" | "off" }[];
}) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(INTRO_KEY) === "1");
  if (dismissed) return null;
  const steps = [
    { label: "Script", teach: "your idea becomes narration, split into scenes" },
    { label: "Storyboard", teach: "each scene gets a still image — review these first" },
    { label: "Videos", teach: "stills become clips; drafts render fast at lower quality" },
    { label: "Final cut", teach: "everything re-renders at full quality into your MP4" },
  ];
  const stageState = (label: string) =>
    stages.find((stage) => stage.label === (label === "Final cut" ? "Export" : label))?.state ??
    "off";
  return (
    <div className="pipeline-intro" role="note" aria-label="How your video is made">
      <span className="intro-title">How your video is made</span>
      {steps.map((step, index) => (
        <span key={step.label} className={`intro-step ${stageState(step.label)}`}>
          <i>{index + 1}</i>
          <span>
            <b>{step.label}</b>
            <small>{step.teach}</small>
          </span>
        </span>
      ))}
      <button
        className="icon-btn-sm"
        aria-label="Dismiss"
        title="Got it — don't show again"
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
        aria-label="Project options"
        aria-expanded={open}
        title="Audio, captions, handoff & layout"
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {timeline && (
            <>
              <div className="menu-label">Audio</div>
              <button
                role="menuitemcheckbox"
                aria-checked={ducking}
                title={TIPS.duck}
                onClick={() => applyTimeline({ ducking: !ducking })}
              >
                <span className="check">{ducking ? "✓" : ""}</span>
                Lower music under voice
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={beatAlign}
                title={TIPS.beat}
                onClick={() => applyTimeline({ beat_align: !beatAlign })}
              >
                <span className="check">{beatAlign ? "✓" : ""}</span>
                Cut on the beat
              </button>
            </>
          )}
          {exportNode && (
            <>
              <div className="menu-label">Captions</div>
              <button
                role="menuitemradio"
                aria-checked={captions === "burn"}
                title={TIPS.captionsBurn}
                onClick={() => applyExport({ captions: "burn" })}
              >
                <span className="check">{captions === "burn" ? "✓" : ""}</span>
                On the video
              </button>
              <button
                role="menuitemradio"
                aria-checked={captions === "sidecar"}
                title={TIPS.captionsSidecar}
                onClick={() => applyExport({ captions: "sidecar" })}
              >
                <span className="check">{captions === "sidecar" ? "✓" : ""}</span>
                Separate file (.srt)
              </button>
            </>
          )}
          {exportNode?.artifact_hash && client && (
            <>
              <div className="menu-label">Open in a pro editor</div>
              <a role="menuitem" href={client.exportUrl(currentProject.id, "otio")} download>
                <span className="check" />
                Premiere / Resolve <small>.otio</small>
              </a>
              <a role="menuitem" href={client.exportUrl(currentProject.id, "fcpxml")} download>
                <span className="check" />
                Final Cut Pro <small>.fcpxml</small>
              </a>
            </>
          )}
          <div className="menu-label">Workspace</div>
          <button
            role="menuitem"
            title="Restore this view's default panel layout"
            onClick={() => {
              resetLayout();
              setOpen(false);
            }}
          >
            <span className="check" />
            Reset layout
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
  const clipDone = scenes.filter((scene) => READY.includes(scene.clip.status)).length;
  const clipFailed = scenes.filter((scene) => scene.clip.status === "failed").length;
  const clipsRendering = scenes.some(
    (scene) => scene.clip.status === "rendering" || scene.clip.status === "queued",
  );
  const keyframesAllReady =
    scenes.length > 0 &&
    scenes.every((scene) => !scene.keyframe || READY.includes(scene.keyframe.status));
  const audioNodes = [board.aux.voiceover, board.aux.music].filter(
    (node): node is NodeState => Boolean(node),
  );
  const audioStage =
    audioNodes.length === 0
      ? ("off" as const)
      : audioNodes.every((node) => READY.includes(node.status))
        ? ("done" as const)
        : audioNodes.some((node) => node.status === "failed")
          ? ("fail" as const)
          : ("work" as const);
  const exportNode = board.aux.export;
  const stages: {
    label: string;
    state: "done" | "work" | "fail" | "off";
    detail?: string;
    // A stage with a landing surface renders as a button (review 3 §3A).
    onClick?: () => void;
    hint?: string;
  }[] = [
    { label: "Script", state: stageOf(script) },
    {
      label: "Storyboard",
      state: scenes.length === 0 ? "off" : keyframesAllReady ? "done" : "work",
    },
    {
      label: "Videos",
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
          ? `${clipDone}/${scenes.length}${clipFailed > 0 ? ` · ${clipFailed} failed` : ""}`
          : undefined,
      onClick:
        scenes.length > 0
          ? () => {
              const target =
                scenes.find((scene) => !READY.includes(scene.clip.status)) ?? scenes[0];
              scrollToScene(target.scene_id, { behavior: "smooth", block: "center" });
            }
          : undefined,
      hint: "Show these scenes on the board",
    },
    { label: "Audio", state: audioStage },
    { label: "Export", state: stageOf(exportNode) },
  ];

  // The screen's ONE primary action, staged per doc 09 (Review → Create
  // final video → Download). Suppressed while a beginner checkpoint banner
  // owns the accent.
  const approvals = currentProject.approvals ?? [];
  const scriptReady = script ? READY.includes(script.status) : false;
  const checkpointPending =
    currentProject.mode === "beginner" &&
    ((!approvals.includes("script") && scriptReady) ||
      (approvals.includes("script") && !approvals.includes("storyboard") && keyframesAllReady));
  const allReady =
    scenes.length > 0 && scenes.every((scene) => READY.includes(scene.clip.status));
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
    <div className="project-shell">
      <div className="board-header">
        <h1>{currentProject.title}</h1>
        <div className="pipeline" role="status" aria-label="Project progress">
          {stages.map((stage) => {
            const inner = (
              <>
                <i aria-hidden="true">{STAGE_GLYPH[stage.state]}</i>
                {stage.label}
                {stage.detail ? <small>{stage.detail}</small> : null}
              </>
            );
            return stage.onClick ? (
              <button
                key={stage.label}
                className={`st ${stage.state}`}
                title={stage.hint}
                onClick={stage.onClick}
              >
                {inner}
              </button>
            ) : (
              <span key={stage.label} className={`st ${stage.state}`}>
                {inner}
              </span>
            );
          })}
        </div>
        {board.scenes.length > 0 && (
          <>
            <div className="seg-toggle view-switch" role="group" aria-label="Workspace view">
              <button
                className={view === "storyboard" ? "active" : ""}
                onClick={() => setView("storyboard")}
                title="Storyboard view — the board leads, monitor in the details panel"
              >
                <LayoutGrid size={12} strokeWidth={1.8} />
                Storyboard
              </button>
              <button
                className={view === "player" ? "active" : ""}
                onClick={() => setView("player")}
                title="Player view — big monitor beside the board"
              >
                <MonitorPlay size={12} strokeWidth={1.8} />
                Player
              </button>
            </div>
            <div className="seg-toggle density" role="group" aria-label="Card size">
              {(["s", "m", "l"] as const).map((value) => (
                <button
                  key={value}
                  className={density === value ? "active" : ""}
                  onClick={() => setDensity(value)}
                  title={`${value.toUpperCase()} cards`}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
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
              Download MP4
            </a>
          ) : allReady ? (
            <button
              className="btn-primary"
              disabled={finalizing}
              onClick={() => void runFinalize()}
              title={TIPS.createFinal}
            >
              <Sparkles size={14} strokeWidth={2} />
              {finalizing
                ? "Creating final video…"
                : `Create final video${eta ? ` · ${eta}` : ""}`}
            </button>
          ) : null)}
      </div>

      {currentProject.mode === "beginner" && <CheckpointBanner />}

      {board.scenes.length === 0 ? (
        <div className="banner">
          {script?.status === "failed"
            ? `Script generation failed: ${script.error}`
            : "Writing the script and splitting it into scenes — each scene gets a still image you can review before any video renders."}
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
