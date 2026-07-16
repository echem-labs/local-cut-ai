import { useEffect } from "react";
import type { NodeState } from "../api/types";
import { Inspector } from "../components/Inspector";
import { SceneCard } from "../components/SceneCard";
import { StatusChip } from "../components/StatusRing";
import { useApp } from "../store";

/** Project window: scene board + (v1-simple) status strip; all modes land
 * here after generation. */
export function Project() {
  const { currentProject, board, refreshBoard, finalize, client } = useApp();

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  if (!currentProject || !board) return null;
  const exportNode: NodeState | undefined = board.aux.export;
  const script = board.aux.script;

  return (
    <div>
      <div className="board-header">
        <h1>{currentProject.title}</h1>
        {exportNode?.artifact_hash && client && (
          <a
            className="btn-ghost"
            style={{ textDecoration: "none" }}
            href={client.artifactUrl(currentProject.id, exportNode.artifact_hash)}
            download
          >
            ⬇ Export
          </a>
        )}
        <button className="btn-primary" onClick={() => void finalize()}>
          Finalize
        </button>
      </div>

      {board.scenes.length === 0 ? (
        <div className="banner">
          {script?.status === "failed"
            ? `Script generation failed: ${script.error}`
            : "Writing the script and breaking it into scenes…"}
        </div>
      ) : (
        <div className="scene-grid">
          {board.scenes.map((scene) => (
            <SceneCard key={scene.scene_id} scene={scene} />
          ))}
        </div>
      )}

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
