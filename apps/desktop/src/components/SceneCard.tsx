import { Pencil, Pin, RotateCw, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { SceneCardModel } from "../api/types";
import { useApp } from "../store";
import { StatusPill } from "./StatusRing";
import { Tip } from "./Tooltip";

/** Average luminance of a loaded <img>, 0–1, or null when the canvas is
 * tainted (cross-origin without CORS) — dark detection is best-effort. */
function luminanceOf(img: HTMLImageElement): number | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 5;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 5);
    const { data } = ctx.getImageData(0, 0, 8, 5);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4) / 255;
  } catch {
    return null;
  }
}

/** Scene card — the thumb has a designed treatment for every state
 * (review 3): queued = numbered slate, rendering = shimmer + live %,
 * draft/final = artifact + duration badge, failed = dimmed frame under
 * recovery choices, near-black artifacts get a number slate overlay so the
 * board never reads as a void. Draggable to reorder the cut. */
export function SceneCard({
  scene,
  dragging = false,
  onDragStart,
  onDragEnd,
  onDropSide,
}: {
  scene: SceneCardModel;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Called on drop with true when dropped on the right half (insert after). */
  onDropSide?: (after: boolean) => void;
}) {
  const { client, currentProject, selectedNode, select, regenerate, togglePin } = useApp();
  const [dark, setDark] = useState(false);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  const clip = scene.clip;
  const keyframe = scene.keyframe;
  const primary = keyframe ?? clip;
  const keyframeHash = keyframe?.artifact_hash ?? null;
  const selected = selectedNode === clip.node_id || selectedNode === keyframe?.node_id;
  const narrationText = scene.narration ? String(scene.narration.params.text ?? "") : "";
  const failed = clip.status === "failed";
  const rendering = clip.status === "rendering";
  const sceneNo = scene.scene_id.replace(/^s/, "");
  const duration = Number(clip.params.duration_s);
  const hasThumb = keyframeHash && client && currentProject;

  return (
    <div
      className={[
        "scene-card",
        selected ? "selected" : "",
        rendering ? "rendering" : "",
        dragging ? "dragging" : "",
        dropSide ? `drop-${dropSide}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => select(primary.node_id)}
      role="button"
      tabIndex={0}
      aria-label={`Scene ${sceneNo}, ${clip.status}`}
      onKeyDown={(event) => {
        if (event.key === "Enter") select(primary.node_id);
        if (event.key.toLowerCase() === "r" && !clip.pinned) void regenerate(clip.node_id);
        if (event.key.toLowerCase() === "p") void togglePin(clip.node_id, !clip.pinned);
      }}
      draggable={Boolean(onDragStart)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragEnd={() => {
        setDropSide(null);
        onDragEnd?.();
      }}
      onDragOver={(event) => {
        if (!onDropSide) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropSide(event.clientX > rect.left + rect.width / 2 ? "after" : "before");
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        event.preventDefault();
        if (onDropSide) {
          const rect = event.currentTarget.getBoundingClientRect();
          onDropSide(event.clientX > rect.left + rect.width / 2);
        }
        setDropSide(null);
      }}
    >
      <div className="thumb">
        {hasThumb ? (
          <img
            src={client.artifactUrl(currentProject.id, keyframeHash)}
            alt={`Scene ${sceneNo} still image`}
            className={failed ? "dim" : ""}
            crossOrigin="anonymous"
            onLoad={(event) => {
              const lum = luminanceOf(event.currentTarget);
              setDark(lum !== null && lum < 0.05);
            }}
          />
        ) : (
          <div className="thumb-slate" aria-hidden="true">
            <span className="num">{sceneNo}</span>
          </div>
        )}
        {/* near-black artifact: keep the frame but overlay a soft number
            slate so the card still reads as content */}
        {hasThumb && dark && !failed && (
          <div className="thumb-slate ghost" aria-hidden="true">
            <span className="num">{sceneNo}</span>
          </div>
        )}
        <StatusPill status={clip.status} progress={clip.progress} onThumb />
        {rendering && clip.progress > 0 && (
          <span className="thumb-progress">{Math.round(clip.progress * 100)}%</span>
        )}
        {clip.pinned && (
          <span className="pin-badge" title="Pinned — kept exactly as it is">
            <Pin size={11} strokeWidth={1.8} />
          </span>
        )}
        {!rendering && Number.isFinite(duration) && (
          <span className="dur-badge">{duration}s</span>
        )}
        {!failed && (
          <div className="acts">
            <Tip label="Regenerate" hint="new take" shortcut="R">
              <button
                aria-label="Regenerate"
                disabled={clip.pinned}
                onClick={(event) => {
                  event.stopPropagation();
                  void regenerate(clip.node_id);
                }}
              >
                <RotateCw size={12} strokeWidth={2} />
              </button>
            </Tip>
            <Tip label={clip.pinned ? "Unpin" : "Pin"} hint="keep as is" shortcut="P">
              <button
                aria-label={clip.pinned ? "Unpin scene" : "Pin scene"}
                aria-pressed={clip.pinned}
                className={clip.pinned ? "on" : ""}
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePin(clip.node_id, !clip.pinned);
                }}
              >
                <Pin size={11} strokeWidth={2} />
              </button>
            </Tip>
            <Tip label="Edit scene" hint="opens details">
              <button
                aria-label="Edit scene"
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
        <div className="scene-line">
          <span className="scene-name">Scene {sceneNo}</span>
          {Number.isFinite(duration) && <span className="scene-dur">{duration}s</span>}
        </div>
        <div className="narration">
          {rendering
            ? `Rendering video${clip.progress > 0 ? ` · ${Math.round(clip.progress * 100)}%` : "…"}`
            : failed
              ? "This scene didn't render."
              : narrationText || "…"}
        </div>
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
            <small>new take</small>
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              select(clip.node_id);
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <SlidersHorizontal size={11} strokeWidth={2} />
              Adjust the scene
            </span>
            <small>prompt · settings</small>
          </button>
        </div>
      )}
    </div>
  );
}
