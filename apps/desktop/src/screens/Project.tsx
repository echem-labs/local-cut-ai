import { Download, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { NodeState } from "../api/types";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { EditPrompt } from "../components/EditPrompt";
import { Inspector } from "../components/Inspector";
import { SceneCard } from "../components/SceneCard";
import { TimelineStrip } from "../components/TimelineStrip";
import { ToolSession } from "../components/ToolSession";
import { movedOrder, orderedScenes } from "../lib/order";
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
          <EditPrompt
            scope="project"
            placeholder='Describe a change — "make it punchier", "crossfade everything", "remove scene 3"'
          />
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
        </>
      )}

      <TimelineStrip />

      <Inspector />
    </div>
  );
}
