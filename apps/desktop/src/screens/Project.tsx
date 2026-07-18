import { Download, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { EditPrompt } from "../components/EditPrompt";
import { Inspector } from "../components/Inspector";
import { SceneCard } from "../components/SceneCard";
import { StatusPill } from "../components/StatusRing";
import { TimelineStrip } from "../components/TimelineStrip";
import { ToolSession } from "../components/ToolSession";
import { useApp } from "../store";

const READY = ["draft", "final", "pinned"];

/** Project window: scene board over a timeline strip; all modes land
 * here after generation. Tool sessions get a focused single panel. */
export function Project() {
  const { currentProject, board, refreshBoard, finalize, client } = useApp();
  const [finalizing, setFinalizing] = useState(false);

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

  // Status roll-up: the header answers "how far along is this video"
  // without reading every card.
  const counts = new Map<string, number>();
  for (const scene of board.scenes) {
    counts.set(scene.clip.status, (counts.get(scene.clip.status) ?? 0) + 1);
  }

  // The screen's ONE primary action, staged per doc 09 (Review → Finalize →
  // Export). Suppressed while a beginner checkpoint banner owns the accent.
  const approvals = currentProject.approvals ?? [];
  const scriptReady = script ? READY.includes(script.status) : false;
  const keyframesReady =
    board.scenes.length > 0 &&
    board.scenes.every((scene) => !scene.keyframe || READY.includes(scene.keyframe.status));
  const checkpointPending =
    currentProject.mode === "beginner" &&
    ((!approvals.includes("script") && scriptReady) ||
      (approvals.includes("script") && !approvals.includes("storyboard") && keyframesReady));
  const exportNode = board.aux.export;
  const allReady =
    board.scenes.length > 0 && board.scenes.every((scene) => READY.includes(scene.clip.status));
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

  return (
    <div>
      <div className="board-header">
        <h1>{currentProject.title}</h1>
        {(["rendering", "draft", "final", "failed"] as const).map((status) => {
          const count = counts.get(status);
          if (!count) return null;
          return (
            <span key={status} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <StatusPill status={status} />
              <span className="hint">{count}</span>
            </span>
          );
        })}
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
            : "Writing the script and breaking it into scenes…"}
        </div>
      ) : (
        <>
          <EditPrompt
            scope="project"
            placeholder='Describe a change — "make it punchier", "crossfade everything", "remove scene 3"'
          />
          <div className="scene-grid">
            {board.scenes.map((scene) => (
              <SceneCard key={scene.scene_id} scene={scene} />
            ))}
          </div>
        </>
      )}

      <TimelineStrip />

      <Inspector />
    </div>
  );
}
