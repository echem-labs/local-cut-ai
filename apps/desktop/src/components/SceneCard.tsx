import type { SceneCardModel } from "../api/types";
import { useApp } from "../store";
import { StatusRing } from "./StatusRing";

/** Scene card: thumbnail, status ring, narration snippet, and at
 * most 3 hover actions — everything else lives in the inspector. */
export function SceneCard({ scene }: { scene: SceneCardModel }) {
  const { client, currentProject, selectedNode, select, regenerate } = useApp();
  const clip = scene.clip;
  const keyframeHash = scene.keyframe.artifact_hash;
  const selected = selectedNode === clip.node_id || selectedNode === scene.keyframe.node_id;
  const narrationText = String(scene.narration.params.text ?? "");

  return (
    <div
      className={`scene-card ${selected ? "selected" : ""}`}
      onClick={() => select(scene.keyframe.node_id)}
      role="button"
      tabIndex={0}
      aria-label={`Scene ${scene.scene_id}, ${clip.status}`}
      onKeyDown={(event) => {
        if (event.key === "Enter") select(scene.keyframe.node_id);
        if (event.key.toLowerCase() === "r") void regenerate(clip.node_id);
      }}
    >
      <div className="thumb">
        {keyframeHash && client && currentProject ? (
          <img
            src={client.artifactUrl(currentProject.id, keyframeHash)}
            alt={`Scene ${scene.scene_id} keyframe`}
          />
        ) : (
          <span>{clip.status === "failed" ? "render failed" : "generating…"}</span>
        )}
      </div>
      <div className="body">
        <div className="narration">{narrationText || "…"}</div>
        <div className="footer">
          <StatusRing status={clip.status} progress={clip.progress} />
          <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
            {scene.scene_id}
          </span>
          <div className="actions">
            <button title="Preview (space)" aria-label="Preview">
              ▶
            </button>
            <button
              title="Regenerate (R)"
              aria-label="Regenerate"
              onClick={(event) => {
                event.stopPropagation();
                void regenerate(clip.node_id);
              }}
            >
              🔄
            </button>
            <button
              title="Edit prompt"
              aria-label="Edit prompt"
              onClick={(event) => {
                event.stopPropagation();
                select(scene.keyframe.node_id);
              }}
            >
              ✏️
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
