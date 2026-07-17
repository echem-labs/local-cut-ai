import { Fragment, useState } from "react";
import type { NodeState } from "../api/types";
import { useApp } from "../store";
import { StatusChip, StatusRing } from "./StatusRing";

const TRANSITIONS = ["cut", "crossfade", "dip"] as const;
const TRANSITION_GLYPHS: Record<(typeof TRANSITIONS)[number], string> = {
  cut: "|",
  crossfade: "⋈",
  dip: "◐",
};

/** Horizontal cut order under the scene board: one chip per scene, transition
 * buttons on the boundaries, compact export block on the right. Every edit
 * patches the timeline/export node params — scenes stay cached. */
export function TimelineStrip() {
  const {
    board,
    client,
    currentProject,
    selectedNode,
    select,
    applyTimeline,
    applyExport,
    finalize,
  } = useApp();
  const [dragged, setDragged] = useState<string | null>(null);

  if (!board || !currentProject || board.scenes.length === 0) return null;

  const scenes = new Map(board.scenes.map((scene) => [scene.scene_id, scene]));
  const timeline: NodeState | undefined = board.aux.timeline;
  const exportNode: NodeState | undefined = board.aux.export;

  // Timeline order wins; scenes it doesn't know about (or a missing param)
  // fall back to board order.
  const orderParam = timeline?.params.order;
  const known = Array.isArray(orderParam)
    ? (orderParam as string[]).filter((id) => scenes.has(id))
    : [];
  const order = [
    ...known,
    ...board.scenes.map((scene) => scene.scene_id).filter((id) => !known.includes(id)),
  ];
  const transitions = (timeline?.params.transitions ?? {}) as Record<string, string>;
  const captions = String(exportNode?.params.captions ?? "burn");
  const ducking = timeline?.params.ducking !== false; // engine default: on
  const beatAlign = timeline?.params.beat_align === true;
  const allReady = board.scenes.every((scene) =>
    ["draft", "final", "pinned"].includes(scene.clip.status),
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    applyTimeline({ order: next });
  };

  const cycleTransition = (sceneId: string) => {
    const current = transitions[sceneId] ?? "cut";
    const index = TRANSITIONS.indexOf(current as (typeof TRANSITIONS)[number]);
    const next = TRANSITIONS[(index + 1) % TRANSITIONS.length];
    applyTimeline({ transitions: { ...transitions, [sceneId]: next } });
  };

  return (
    <div className="timeline-strip" aria-label="Timeline">
      {order.map((sceneId, index) => {
        const scene = scenes.get(sceneId);
        if (!scene) return null;
        const clip = scene.clip;
        const duration = Number(clip.params.duration_s);
        const boundary = index > 0 ? order[index - 1] : null;
        const boundaryKind = boundary ? (transitions[boundary] ?? "cut") : "cut";
        return (
          <Fragment key={sceneId}>
            {boundary && (
              <button
                className="tl-transition"
                title={`${boundaryKind} — click to change`}
                aria-label={`Transition after ${boundary}: ${boundaryKind}`}
                onClick={() => cycleTransition(boundary)}
              >
                {TRANSITION_GLYPHS[boundaryKind as (typeof TRANSITIONS)[number]] ?? "|"}
              </button>
            )}
            <div
              className={`tl-chip ${selectedNode === clip.node_id ? "selected" : ""} ${
                dragged === sceneId ? "dragging" : ""
              }`}
              role="button"
              tabIndex={0}
              aria-label={`Scene ${sceneId}, position ${index + 1} of ${order.length}`}
              onClick={() => select(clip.node_id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") select(clip.node_id);
              }}
              draggable
              onDragStart={() => setDragged(sceneId)}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged && dragged !== sceneId) move(order.indexOf(dragged), index);
                setDragged(null);
              }}
            >
              <button
                className="move"
                aria-label={`Move ${sceneId} left`}
                disabled={index === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  move(index, index - 1);
                }}
              >
                ◀
              </button>
              <StatusRing status={clip.status} progress={clip.progress} />
              <span className="id">{sceneId}</span>
              {Number.isFinite(duration) && <span className="dur">~{duration}s</span>}
              <button
                className="move"
                aria-label={`Move ${sceneId} right`}
                disabled={index === order.length - 1}
                onClick={(event) => {
                  event.stopPropagation();
                  move(index, index + 1);
                }}
              >
                ▶
              </button>
            </div>
          </Fragment>
        );
      })}

      <div className="tl-export">
        {timeline && (
          <div className="seg-toggle" role="group" aria-label="Audio">
            <button
              className={ducking ? "active" : ""}
              title="Dip the music under narration"
              aria-pressed={ducking}
              onClick={() => applyTimeline({ ducking: !ducking })}
            >
              Duck music
            </button>
            <button
              className={beatAlign ? "active" : ""}
              title="Snap scene cuts to the music's beat"
              aria-pressed={beatAlign}
              onClick={() => applyTimeline({ beat_align: !beatAlign })}
            >
              On-beat cuts
            </button>
          </div>
        )}
        {exportNode && (
          <>
            <div className="seg-toggle" role="group" aria-label="Captions">
              <button
                className={captions === "burn" ? "active" : ""}
                onClick={() => applyExport({ captions: "burn" })}
              >
                Burn-in
              </button>
              <button
                className={captions === "sidecar" ? "active" : ""}
                onClick={() => applyExport({ captions: "sidecar" })}
              >
                Sidecar
              </button>
            </div>
            <StatusChip status={exportNode.status} />
            {exportNode.artifact_hash && client && (
              <a
                className="btn-ghost"
                style={{ textDecoration: "none" }}
                title="Download export"
                aria-label="Download export"
                href={client.artifactUrl(currentProject.id, exportNode.artifact_hash)}
                download
              >
                ⬇
              </a>
            )}
          </>
        )}
        <button
          className={allReady ? "btn-primary" : "btn-ghost"}
          onClick={() => void finalize()}
        >
          Finalize
        </button>
      </div>
    </div>
  );
}
