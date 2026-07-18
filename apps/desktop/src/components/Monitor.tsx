import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { orderedScenes } from "../lib/order";
import { formatTime, usePlayback } from "../lib/playback";
import { useApp } from "../store";

/** The monitor — the one playback surface (review 3). Shows the loaded
 * scene's clip; falls back to its still image when the clip can't play
 * (draft not rendered yet, or a mock artifact), in which case sequence
 * playback advances on a timer so the draft preview still sweeps the cut.
 * Space is handled at the workspace level, not here. */
export function Monitor({ variant = "inline" }: { variant?: "inline" | "panel" }) {
  const { board, client, currentProject, selectedNode } = useApp();
  const { playing, sceneId, sequence, elapsed, total, play, pause, stop, tick } = usePlayback();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoBroken, setVideoBroken] = useState(false);

  const scenes = useMemo(() => (board ? orderedScenes(board) : []), [board]);
  const durations = useMemo(
    () =>
      scenes.map((scene) => {
        const value = Number(scene.clip.params.duration_s);
        return Number.isFinite(value) && value > 0 ? value : 4;
      }),
    [scenes],
  );
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);

  // The monitor shows the playback scene, else the selected scene; a
  // standalone panel falls back to the first scene so it's never empty.
  const selectedSceneId = selectedNode?.includes(".") ? selectedNode.split(".")[0] : null;
  const shownId =
    sceneId ?? selectedSceneId ?? (variant === "panel" ? (scenes[0]?.scene_id ?? null) : null);
  const shownIndex = scenes.findIndex((scene) => scene.scene_id === shownId);
  const shown = shownIndex >= 0 ? scenes[shownIndex] : null;
  const offsetBefore = durations.slice(0, Math.max(0, shownIndex)).reduce((s, d) => s + d, 0);

  const clipHash = shown?.clip.artifact_hash ?? null;
  const stillHash = shown?.keyframe?.artifact_hash ?? null;
  const clipUrl =
    clipHash && client && currentProject ? client.artifactUrl(currentProject.id, clipHash) : null;
  const stillUrl =
    stillHash && client && currentProject
      ? client.artifactUrl(currentProject.id, stillHash)
      : null;

  // New scene → new source; reset the broken flag so each clip gets a try.
  useEffect(() => {
    setVideoBroken(false);
  }, [clipUrl]);

  const advance = () => {
    if (!sequence) {
      pause();
      return;
    }
    const next = shownIndex + 1;
    if (next < scenes.length) play(scenes[next].scene_id, true);
    else stop();
  };

  // Drive the <video> from the store.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || videoBroken) return;
    if (playing && sceneId === shown?.scene_id) {
      void video.play().catch(() => setVideoBroken(true));
    } else {
      video.pause();
    }
  }, [playing, sceneId, shown?.scene_id, videoBroken, clipUrl]);

  // Fallback playback: no playable video → advance on the scene's duration
  // so the assembled-draft preview still works against still images.
  useEffect(() => {
    if (!playing || sceneId === null || shownIndex < 0) return;
    const usingVideo = Boolean(clipUrl) && !videoBroken;
    if (usingVideo) return;
    const duration = durations[shownIndex];
    const started = performance.now();
    const timer = setInterval(() => {
      const inScene = (performance.now() - started) / 1000;
      if (inScene >= duration) {
        clearInterval(timer);
        advance();
      } else {
        tick(offsetBefore + inScene, totalDuration);
      }
    }, 120);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, sceneId, shownIndex, videoBroken, clipUrl]);

  if (!shown) return null;

  const progress = totalDuration > 0 ? Math.min(1, elapsed / totalDuration) : 0;

  const toggle = () => {
    if (playing) pause();
    else if (shown) play(shown.scene_id, sceneId !== null ? sequence : false);
  };

  return (
    <div className={`monitor${variant === "panel" ? " in-panel" : ""}`} aria-label="Preview monitor">
      <div className="monitor-screen" onClick={toggle} role="button" tabIndex={-1}>
        {clipUrl && !videoBroken ? (
          <video
            ref={videoRef}
            src={clipUrl}
            muted={false}
            playsInline
            onError={() => setVideoBroken(true)}
            onTimeUpdate={(event) =>
              tick(offsetBefore + event.currentTarget.currentTime, totalDuration)
            }
            onEnded={advance}
          />
        ) : stillUrl ? (
          <img src={stillUrl} alt={`Scene ${shown.scene_id.replace(/^s/, "")} still image`} />
        ) : (
          <div className="monitor-slate">
            <span>{shown.scene_id.replace(/^s/, "")}</span>
          </div>
        )}
        <button
          className={`monitor-play${playing ? " playing" : ""}`}
          aria-label={playing ? "Pause" : "Play"}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}
        </button>
        {(!clipUrl || videoBroken) && (
          <span className="monitor-note">
            {shown.clip.status === "rendering"
              ? "rendering — showing the still"
              : "draft preview · still image"}
          </span>
        )}
      </div>
      <div className="monitor-bar">
        <div
          className="monitor-scrub"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="monitor-time">
          {formatTime(elapsed)} / {formatTime(totalDuration)}
        </span>
      </div>
    </div>
  );
}
