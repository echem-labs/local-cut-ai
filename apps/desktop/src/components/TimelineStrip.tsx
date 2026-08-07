import { ChevronFirst, ChevronLast, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { m, t } from "../i18n";
import { movedOrder, orderedScenes, sceneDurations } from "../lib/order";
import { formatTime, parseTime, usePlayback } from "../lib/playback";
import { useOutsideClick } from "../lib/useOutsideClick";
import { useApp } from "../store";
import { AudioLanes } from "./AudioLanes";
import { PanelHelp } from "./Help";

// Stable transition ids only — engine wire contract. Display label/hint
// live in timeline.json and resolve when the popover renders.
const TRANSITIONS = [{ id: "cut" }, { id: "crossfade" }, { id: "dip" }] as const;

/** A real scene timeline (review 3): transport that plays the assembled
 * draft, blocks whose width is proportional to duration, diamond
 * transition nodes with preview popovers, and a zoom — nothing interactive
 * ever lives past the scroll fold. Trim/captions/audio options live in the
 * header's overflow menu, not here. */
export function TimelineStrip() {
  const { board, client, currentProject, selectedNode, select, applyTimeline } = useApp();
  const { playing, sceneId, elapsed, play, pause, seek, tick } = usePlayback();
  const [dragged, setDragged] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(18);
  // Transition popover: which boundary is open + its fixed-position coords
  // (measured from the diamond so panel overflow can never clip it).
  const [openTransition, setOpenTransition] = useState<{
    boundary: string;
    left: number;
    bottom: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Typed timestamp in the time box (null = showing live elapsed). The ref
  // mirrors the state so commit-on-Enter followed by the blur it triggers
  // can't seek twice.
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const timeDraftRef = useRef<string | null>(null);
  const setDraft = (value: string | null) => {
    timeDraftRef.current = value;
    setTimeDraft(value);
  };

  useOutsideClick(rootRef, openTransition !== null, () => setOpenTransition(null));

  // The popover's coords were measured at open — close on anything that
  // moves its anchor (window resize, timeline scroll).
  useEffect(() => {
    if (!openTransition) return;
    const close = () => setOpenTransition(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [openTransition]);

  if (!board || !currentProject || board.scenes.length === 0) return null;

  const scenes = orderedScenes(board);
  const order = scenes.map((scene) => scene.scene_id);
  const timeline = board.aux.timeline;
  const transitions = (timeline?.params.transitions ?? {}) as Record<string, string>;

  const durations = sceneDurations(board, scenes);
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const DIAMOND_W = 15; // diamond + margins — keeps playhead math honest
  const blockWidths = durations.map((d) => Math.max(64, Math.round(d * pxPerSec)));
  const totalWidth =
    blockWidths.reduce((sum, w) => sum + w, 0) + DIAMOND_W * Math.max(0, scenes.length - 1);

  // Map a global time onto pixel space through the real block widths
  // (min-width + diamonds would put a naive t*px off target). Shared by
  // the playhead and the ruler so they can never disagree.
  const timeToPx = (t: number): number => {
    let remaining = t;
    let px = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (remaining <= durations[i] || i === scenes.length - 1) {
        return px + Math.min(1, Math.max(0, remaining / durations[i])) * blockWidths[i];
      }
      remaining -= durations[i];
      px += blockWidths[i] + DIAMOND_W;
    }
    return px;
  };
  // The playhead always reflects the current position — 0 before anything
  // has played, live during playback, parked where playback left off.
  const playheadPx = timeToPx(elapsed);

  // Inverse of timeToPx: which moment in the cut a ruler pixel points at
  // (diamond gaps snap to the boundary they sit on).
  const pxToTime = (px: number): number => {
    let acc = 0;
    let tBefore = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (px <= acc + blockWidths[i] || i === scenes.length - 1) {
        const frac = Math.max(0, Math.min(1, (px - acc) / blockWidths[i]));
        return tBefore + frac * durations[i];
      }
      acc += blockWidths[i] + DIAMOND_W;
      tBefore += durations[i];
    }
    return totalDuration;
  };

  // Ruler graduation follows the zoom: labels every 10s (5s zoomed in),
  // minor ticks every second when there's room for them.
  const tickStep = pxPerSec >= 24 ? 5 : 10;
  const minorStep = pxPerSec >= 16 ? 1 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= totalDuration; t += tickStep) ticks.push(t);
  const minorTicks: number[] = [];
  for (let t = minorStep; t <= totalDuration; t += minorStep) {
    if (t % tickStep !== 0) minorTicks.push(t);
  }

  // Jump anywhere in the cut: land in the scene containing t, seeking its
  // clip to the in-scene offset. Works while paused (the frame updates).
  const seekGlobal = (t: number) => {
    const clamped = Math.max(0, Math.min(totalDuration - 0.01, t));
    let before = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (clamped < before + durations[i] || i === scenes.length - 1) {
        select(scenes[i].clip.node_id);
        seek(scenes[i].scene_id, clamped - before);
        tick(clamped, totalDuration);
        return;
      }
      before += durations[i];
    }
  };

  const scrubRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    seekGlobal(pxToTime(event.clientX - rect.left));
  };

  // Commit whatever's typed in the time box; unparseable input just reverts.
  const commitTime = () => {
    const draft = timeDraftRef.current;
    setDraft(null);
    if (draft === null) return;
    const parsed = parseTime(draft);
    if (parsed !== null) seekGlobal(parsed);
  };

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
    // Move the playhead; only start playback if already playing (like a block
    // click) — prev/next while paused must not force the draft to start.
    if (playing) play(order[next], true);
    else seek(order[next], 0);
    // seek() sets the scene and the in-scene offset but NOT `elapsed`, which
    // is what the time readout and the playhead marker both render. Without
    // this the transport jumped to another scene while the clock and the
    // playhead stayed where they were, disagreeing with the picture.
    tick(
      durations.slice(0, next).reduce((sum, value) => sum + value, 0),
      totalDuration,
    );
  };

  return (
    <div className="timeline-dock" ref={rootRef} aria-label={t("workspace.panels.timeline")}>
      <div className="tl-bar">
        <div className="tl-transport">
          <button aria-label={t("timeline.goToStart")} title={t("timeline.goToStart")} onClick={() => seekGlobal(0)}>
            <ChevronFirst size={14} strokeWidth={2} />
          </button>
          <button aria-label={t("timeline.prevScene")} onClick={() => step(-1)}>
            <SkipBack size={13} strokeWidth={2} />
          </button>
          <button
            className="tl-play"
            aria-label={playing ? t("timeline.pause") : t("timeline.play")}
            title={playing ? t("timeline.pauseTitle") : t("timeline.playTitle")}
            onClick={toggle}
          >
            {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}
          </button>
          <button aria-label={t("timeline.nextScene")} onClick={() => step(1)}>
            <SkipForward size={13} strokeWidth={2} />
          </button>
          <button
            aria-label={t("timeline.goToEnd")}
            title={t("timeline.goToEnd")}
            onClick={() => seekGlobal(totalDuration)}
          >
            <ChevronLast size={14} strokeWidth={2} />
          </button>
          <span className="tl-time">
            <input
              value={timeDraft ?? formatTime(elapsed)}
              aria-label={t("timeline.timeAria")}
              title={t("timeline.timeTitle")}
              onFocus={(event) => {
                setDraft(formatTime(elapsed));
                event.currentTarget.select();
              }}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitTime}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur(); // blur commits
                if (event.key === "Escape") {
                  setDraft(null);
                  event.currentTarget.blur();
                }
              }}
            />
            <span aria-hidden="true">/ {formatTime(totalDuration)}</span>
          </span>
          <span className="hint">{t("timeline.draftHint")}</span>
        </div>
        <label className="tl-zoom">
          {t("timeline.zoom")}
          <input
            type="range"
            min={10}
            max={36}
            value={pxPerSec}
            aria-label={t("timeline.zoomAria")}
            onChange={(event) => setPxPerSec(Number(event.target.value))}
          />
        </label>
        <PanelHelp panel="timeline" />
      </div>

      <div className="tl-scroll">
        {/* the ruler is also the seek bar: click or drag to jump the cut */}
        <div
          className="tl-ruler"
          style={{ width: totalWidth }}
          role="slider"
          tabIndex={0}
          aria-label={t("timeline.seekAria")}
          aria-valuemin={0}
          aria-valuemax={Math.round(totalDuration)}
          aria-valuenow={Math.round(elapsed)}
          title={t("timeline.seekTitle")}
          onPointerDown={(event) => {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* inactive pointer (synthetic events) — click-seek still works */
            }
            scrubRuler(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons & 1) scrubRuler(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              seekGlobal(elapsed + (event.key === "ArrowRight" ? 1 : -1));
            }
          }}
        >
          {minorTicks.map((t) => (
            <span key={`m${t}`} className="minor" style={{ left: timeToPx(t) }} />
          ))}
          {ticks.map((sec) => (
            <span key={sec} style={{ left: timeToPx(sec) }}>
              {t("timeline.seconds", { n: sec })}
            </span>
          ))}
        </div>
        <div className="tl-blocks" style={{ position: "relative" }}>
          <div className="tl-playhead" style={{ left: playheadPx }} aria-hidden="true" />
          {scenes.map((scene, index) => {
            const clip = scene.clip;
            const stillHash = scene.keyframe?.artifact_hash ?? null;
            const thumbUrl =
              stillHash && client ? client.artifactUrl(currentProject.id, stillHash) : null;
            const boundary = index > 0 ? order[index - 1] : null;
            const boundaryKind = boundary ? (transitions[boundary] ?? "cut") : "cut";
            const kindLabel =
              (m().timeline.transitions as Record<string, { label: string }>)[boundaryKind]
                ?.label ?? boundaryKind;
            const sceneNo = scene.scene_id.replace(/^s/, "");
            return (
              <Fragment key={scene.scene_id}>
                {boundary && (
                  <span className="tl-joint">
                    <button
                      className={`tl-diamond${boundaryKind !== "cut" ? " on" : ""}`}
                      title={t("timeline.diamondTitle", {
                        a: boundary.replace(/^s/, ""),
                        b: sceneNo,
                        kind: kindLabel,
                      })}
                      aria-label={t("timeline.diamondAria", { n: sceneNo, kind: kindLabel })}
                      onClick={(event) => {
                        if (openTransition?.boundary === boundary) {
                          setOpenTransition(null);
                          return;
                        }
                        // Fixed-position above the diamond — the timeline
                        // panel's overflow can never cut it off.
                        const rect = event.currentTarget.getBoundingClientRect();
                        const left = Math.max(
                          8,
                          Math.min(
                            rect.left + rect.width / 2 - 90,
                            window.innerWidth - 188,
                          ),
                        );
                        setOpenTransition({
                          boundary,
                          left,
                          bottom: window.innerHeight - rect.top + 8,
                        });
                      }}
                    />
                    {openTransition?.boundary === boundary && (
                      <div
                        className="transition-pop"
                        role="menu"
                        style={{ left: openTransition.left, bottom: openTransition.bottom }}
                      >
                        {TRANSITIONS.map((option) => {
                          const info = m().timeline.transitions[option.id];
                          return (
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
                                {info.label}
                                <small>{info.hint}</small>
                              </span>
                            </button>
                          );
                        })}
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
                  aria-label={t("timeline.blockAria", {
                    n: sceneNo,
                    d: durations[index],
                    // Through the catalog, like every other status surface:
                    // the raw id is a wire value ("skipped" reads "not
                    // needed" everywhere else) and never translates.
                    status: t(`status.${clip.status}`),
                  })}
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
                  <span className="dur">{t("timeline.seconds", { n: durations[index] })}</span>
                  <span className={`tick ${clip.status}`} aria-hidden="true" />
                </div>
              </Fragment>
            );
          })}
        </div>
        {/* Under the pictures, at the same scale and inside the same scroll
            — the lanes have to travel with the blocks they describe. */}
        <AudioLanes
          scenes={scenes.map((scene) => ({
            sceneId: scene.scene_id,
            narration: scene.narration ?? null,
          }))}
          widths={blockWidths}
          music={board.aux.music}
          totalWidth={totalWidth}
        />
      </div>
    </div>
  );
}
