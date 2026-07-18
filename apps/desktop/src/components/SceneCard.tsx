import { Pencil, Pin, RotateCw, SlidersHorizontal } from "lucide-react";
import type { SceneCardModel } from "../api/types";
import { useApp } from "../store";
import { StatusPill } from "./StatusRing";
import { Tip } from "./Tooltip";

/** Scene card: thumbnail with status pill + hover actions, narration
 * snippet — everything else lives in the inspector. A failed card shows
 * its recovery options as choices, not an error code. */
export function SceneCard({ scene }: { scene: SceneCardModel }) {
  const { client, currentProject, selectedNode, select, regenerate } = useApp();
  const clip = scene.clip;
  const keyframe = scene.keyframe;
  const primary = keyframe ?? clip;
  const keyframeHash = keyframe?.artifact_hash ?? null;
  const selected = selectedNode === clip.node_id || selectedNode === keyframe?.node_id;
  const narrationText = scene.narration ? String(scene.narration.params.text ?? "") : "";
  const failed = clip.status === "failed";
  const rendering = clip.status === "rendering";

  return (
    <div
      className={`scene-card${selected ? " selected" : ""}${rendering ? " rendering" : ""}`}
      onClick={() => select(primary.node_id)}
      role="button"
      tabIndex={0}
      aria-label={`Scene ${scene.scene_id}, ${clip.status}`}
      onKeyDown={(event) => {
        if (event.key === "Enter") select(primary.node_id);
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
          <span>{failed ? "" : "generating…"}</span>
        )}
        <StatusPill status={clip.status} progress={clip.progress} onThumb />
        {clip.pinned && (
          <span className="pin-badge" title="Pinned — locked from regeneration">
            <Pin size={11} strokeWidth={1.8} />
          </span>
        )}
        <span className="scene-id">{scene.scene_id}</span>
        {!failed && (
          <div className="acts">
            <Tip label="Regenerate" hint="new take" shortcut="R">
              <button
                aria-label="Regenerate"
                onClick={(event) => {
                  event.stopPropagation();
                  void regenerate(clip.node_id);
                }}
              >
                <RotateCw size={12} strokeWidth={2} />
              </button>
            </Tip>
            <Tip label="Edit prompt" hint="opens inspector">
              <button
                aria-label="Edit prompt"
                onClick={(event) => {
                  event.stopPropagation();
                  select(primary.node_id);
                }}
              >
                <Pencil size={11} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        )}
      </div>
      <div className="body">
        <div className="narration">{narrationText || "…"}</div>
      </div>
      {failed && (
        <div className="fail-acts">
          <button
            onClick={(event) => {
              event.stopPropagation();
              void regenerate(clip.node_id);
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <RotateCw size={11} strokeWidth={2} />
              Try again
            </span>
            <small>new seed</small>
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              select(clip.node_id);
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <SlidersHorizontal size={11} strokeWidth={2} />
              Adjust settings
            </span>
            <small>prompt · model · seed</small>
          </button>
        </div>
      )}
    </div>
  );
}
