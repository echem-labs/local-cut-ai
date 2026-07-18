import { Download, MoreHorizontal, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NodeState } from "../api/types";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { Composer } from "../components/Composer";
import { Inspector } from "../components/Inspector";
import { SceneCard } from "../components/SceneCard";
import { TimelineStrip } from "../components/TimelineStrip";
import { ToolSession } from "../components/ToolSession";
import { TIPS } from "../help/terms";
import { movedOrder, orderedScenes } from "../lib/order";
import { usePlayback } from "../lib/playback";
import { useApp } from "../store";

const READY = ["draft", "final", "pinned"];

type Density = "s" | "m" | "l";
const DENSITY_KEY = "localcut.board.density";

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

/** Header overflow menu (⋯): the settings the old strip hid past its
 * scroll fold — audio behavior, caption mode, pro-editor handoff. */
function BoardMenu() {
  const { board, client, currentProject, applyTimeline, applyExport } = useApp();
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
        title="Audio, captions & pro-editor handoff"
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
        </div>
      )}
    </div>
  );
}

/** Project window: scene board over a timeline strip; all modes land
 * here after generation. Tool sessions get a focused single panel. */
export function Project() {
  const { currentProject, board, refreshBoard, finalize, client, applyTimeline } = useApp();
  const [finalizing, setFinalizing] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) ?? "m",
  );

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  // Space = draft preview from the selected scene (or the top), anywhere a
  // form control doesn't own the key. Playback stops when the project closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
        target.isContentEditable
      )
        return;
      event.preventDefault();
      const playback = usePlayback.getState();
      if (playback.playing) {
        playback.pause();
        return;
      }
      const state = useApp.getState();
      if (!state.board || state.board.scenes.length === 0) return;
      const ids = orderedScenes(state.board).map((scene) => scene.scene_id);
      const selectedScene = state.selectedNode?.includes(".")
        ? state.selectedNode.split(".")[0]
        : null;
      const start =
        playback.sceneId ??
        (selectedScene && ids.includes(selectedScene) ? selectedScene : ids[0]);
      state.select(`${start}.clip`);
      playback.play(start, true);
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
      <div>
        <div className="board-header">
          <h1>{currentProject.title}</h1>
        </div>
        <ToolSession />
      </div>
    );
  }

  const scenes = orderedScenes(board);
  const order = scenes.map((scene) => scene.scene_id);

  // The header's pipeline indicator: the project's story arc at a glance,
  // replacing both the status-pill roll-up and the raw aux dump.
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
  const stages: { label: string; state: "done" | "work" | "fail" | "off"; detail?: string }[] = [
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
    },
    { label: "Audio", state: audioStage },
    { label: "Export", state: stageOf(exportNode) },
  ];

  const setDensityPersisted = (value: Density) => {
    setDensity(value);
    localStorage.setItem(DENSITY_KEY, value);
  };

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

  const runFinalize = async () => {
    if (finalizing) return;
    setFinalizing(true);
    try {
      await finalize();
    } finally {
      setFinalizing(false);
    }
  };

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
    <div>
      <div className="board-header">
        <h1>{currentProject.title}</h1>
        <div className="pipeline" role="status" aria-label="Project progress">
          {stages.map((stage) => (
            <span key={stage.label} className={`st ${stage.state}`}>
              <i aria-hidden="true">{STAGE_GLYPH[stage.state]}</i>
              {stage.label}
              {stage.detail ? <small>{stage.detail}</small> : null}
            </span>
          ))}
        </div>
        {board.scenes.length > 0 && (
          <div className="seg-toggle density" role="group" aria-label="Card size">
            {(["s", "m", "l"] as const).map((value) => (
              <button
                key={value}
                className={density === value ? "active" : ""}
                onClick={() => setDensityPersisted(value)}
                title={`${value.toUpperCase()} cards`}
              >
                {value.toUpperCase()}
              </button>
            ))}
          </div>
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
              title="Re-renders any draft scenes at full quality, then builds your MP4"
            >
              <Sparkles size={14} strokeWidth={2} />
              {finalizing ? "Creating final video…" : "Create final video"}
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
          <Composer />
        </>
      )}

      <TimelineStrip />

      <Inspector />
    </div>
  );
}
