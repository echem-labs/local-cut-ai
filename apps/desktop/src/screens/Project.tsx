import { useEffect } from "react";
import { CheckpointBanner } from "../components/CheckpointBanner";
import { EditPrompt } from "../components/EditPrompt";
import { Inspector } from "../components/Inspector";
import { SceneCard } from "../components/SceneCard";
import { StatusChip, StatusPill } from "../components/StatusRing";
import { TimelineStrip } from "../components/TimelineStrip";
import { ToolSession } from "../components/ToolSession";
import { useApp } from "../store";

/** Project window: scene board over a timeline strip; all modes land
 * here after generation. Tool sessions get a focused single panel. */
export function Project() {
  const { currentProject, board, refreshBoard } = useApp();

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

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-6)" }}>
        {Object.entries(board.aux).map(([name, node]) => (
          <span key={name} style={{ display: "flex", gap: "var(--space-1)", alignItems: "center" }}>
            <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
              {name}
            </span>
            <StatusChip status={node.status} />
          </span>
        ))}
      </div>

      <Inspector />
    </div>
  );
}
