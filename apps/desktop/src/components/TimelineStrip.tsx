import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { movedOrder, orderedScenes } from "../lib/order";
import { formatTime, usePlayback } from "../lib/playback";
import { useApp } from "../store";

const TRANSITIONS = [
  { id: "cut", label: "Cut", hint: "instant switch" },
  { id: "crossfade", label: "Crossfade", hint: "one fades into the next" },
  { id: "dip", label: "Dip", hint: "fades to black between" },
] as const;

/** A real scene timeline (review 3): transport that plays the assembled
 * draft, blocks whose width is proportional to duration, diamond
 * transition nodes with preview popovers, and a zoom — nothing interactive
 * ever lives past the scroll fold. Trim/captions/audio options live in the
 * header's overflow menu, not here. */
export function TimelineStrip() {
  const { board, client, currentProject, selectedNode, select, applyTimeline } = useApp();
  const { playing, sceneId, elapsed, play, pause } = usePlayback();
  const [dragged, setDragged] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(18);
  const [openTransition, setOpenTransition] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the transition popover on outside click.
  useEffect(() => {
    if (!openTransition) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenTransition(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openTransition]);

  if (!board || !currentProject || board.scenes.length === 0) return null;

  const scenes = orderedScenes(board);
  const order = scenes.map((scene) => scene.scene_id);
  const timeline = board.aux.timeline;
  const transitions = (timeline?.params.transitions ?? {}) as Record<string, string>;

  const durations = scenes.map((scene) => {
    const value = Number(scene.clip.params.duration_s);
    return Number.isFinite(value) && value > 0 ? value : 4;
  });
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const DIAMOND_W = 15; // diamond + margins — keeps playhead math honest
  const blockWidths = durations.map((d) => Math.max(56, Math.round(d * pxPerSec)));

  // Map the global elapsed time onto pixel space through the real block
  // widths (min-width + diamonds would put a naive elapsed*px off target).
  let playheadPx: number | null = null;
  if (sceneId !== null) {
    let remaining = elapsed;
    let px = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (remaining <= durations[i] || i === scenes.length - 1) {
        px += Math.min(1, Math.max(0, remaining / durations[i])) * blockWidths[i];
        playheadPx = px;
        break;
      }
      remaining -= durations[i];
      px += blockWidths[i] + DIAMOND_W;
    }
  }

  const shownIndex = sceneId ? order.indexOf(sceneId) : -1;

  const move = (from: number, to: number) => {
    const next = movedOrder(order, from, to);
    if (next) applyTimeline({ order: next });
  };

  const toggle = () => {
    if (playing) {
      pause();
      return;
    }
    const startId =
      sceneId ??
      (selectedNode?.includes(".") ? selectedNode.split(".")[0] : null) ??
      order[0];
    const target = order.includes(startId) ? startId : order[0];
    select(`${target}.clip`);
    play(target, true);
  };

  const step = (delta: number) => {
    const from = shownIndex >= 0 ? shownIndex : 0;
    const next = Math.min(order.length - 1, Math.max(0, from + delta));
    select(`${order[next]}.clip`);
    play(order[next], true);
  };

  return (
    <div className="timeline-dock" ref={rootRef} aria-label="Timeline">
      <div className="tl-bar">
        <div className="tl-transport">
          <button aria-label="Previous scene" onClick={() => step(-1)}>
            <SkipBack size={13} strokeWidth={2} />
          </button>
          <button
            className="tl-play"
            aria-label={playing ? "Pause" : "Play the draft preview"}
            title={playing ? "Pause (Space)" : "Play the draft preview (Space)"}
            onClick={toggle}
          >
            {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}
          </button>
          <button aria-label="Next scene" onClick={() => step(1)}>
            <SkipForward size={13} strokeWidth={2} />
          </button>
          <span className="tl-time">
            {formatTime(elapsed)} / {formatTime(totalDuration)}
          </span>
          <span className="hint">draft preview · hard cuts</span>
        </div>
        <label className="tl-zoom">
          zoom
          <input
            type="range"
            min={10}
            max={36}
            value={pxPerSec}
            aria-label="Timeline zoom"
            onChange={(event) => setPxPerSec(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="tl-scroll">
        <div className="tl-blocks" style={{ position: "relative" }}>
          {playheadPx !== null && (
            <div className="tl-playhead" style={{ left: playheadPx }} aria-hidden="true" />
          )}
          {scenes.map((scene, index) => {
            const clip = scene.clip;
            const stillHash = scene.keyframe?.artifact_hash ?? null;
            const thumbUrl =
              stillHash && client ? client.artifactUrl(currentProject.id, stillHash) : null;
            const boundary = index > 0 ? order[index - 1] : null;
            const boundaryKind = boundary ? (transitions[boundary] ?? "cut") : "cut";
            const sceneNo = scene.scene_id.replace(/^s/, "");
            return (
              <Fragment key={scene.scene_id}>
                {boundary && (
                  <span className="tl-joint">
                    <button
                      className={`tl-diamond${boundaryKind !== "cut" ? " on" : ""}`}
                      title={`Scene ${boundary.replace(/^s/, "")} → ${sceneNo}: ${boundaryKind}. Click to change.`}
                      aria-label={`Transition into scene ${sceneNo}: ${boundaryKind}`}
                      onClick={() =>
                        setOpenTransition(openTransition === boundary ? null : boundary)
                      }
                    />
                    {openTransition === boundary && (
                      <div className="transition-pop" role="menu">
                        {TRANSITIONS.map((option) => (
                          <button
                            key={option.id}
                            role="menuitemradio"
                            aria-checked={boundaryKind === option.id}
                            className={boundaryKind === option.id ? "selected" : ""}
                            onClick={() => {
                              applyTimeline({
                                transitions: { ...transitions, [boundary]: option.id },
                              });
                              setOpenTransition(null);
                            }}
                          >
                            <span className={`tp-demo tp-${option.id}`} aria-hidden="true">
                              <i />
                              <i />
                            </span>
                            <span className="grow">
                              {option.label}
                              <small>{option.hint}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                <div
                  className={`tl-block${selectedNode === clip.node_id ? " selected" : ""}${
                    dragged === scene.scene_id ? " dragging" : ""
                  }`}
                  style={{
                    width: blockWidths[index],
                    backgroundImage: thumbUrl ? `url("${thumbUrl}")` : undefined,
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Scene ${sceneNo}, ${durations[index]}s, ${clip.status}`}
                  onClick={() => {
                    select(clip.node_id);
                    if (playing) play(scene.scene_id, true); // seek while playing
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") select(clip.node_id);
                  }}
                  draggable
                  onDragStart={() => setDragged(scene.scene_id)}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragged && dragged !== scene.scene_id) {
                      const from = order.indexOf(dragged);
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientX > rect.left + rect.width / 2;
                      let to = after ? index + 1 : index;
                      if (from < to) to -= 1;
                      move(from, to);
                    }
                    setDragged(null);
                  }}
                >
                  <span className="n">{sceneNo}</span>
                  <span className="dur">{durations[index]}s</span>
                  <span className={`tick ${clip.status}`} aria-hidden="true" />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
