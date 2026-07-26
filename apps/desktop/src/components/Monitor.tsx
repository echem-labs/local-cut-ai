import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { t } from "../i18n";
import { orderedScenes, sceneDurations } from "../lib/order";
import { formatTime, usePlayback } from "../lib/playback";
import { useApp } from "../store";

/** The monitor — the one playback surface (review 3). Shows the loaded
 * scene's clip; falls back to its still image when the clip can't play
 * (draft not rendered yet, or a mock artifact), in which case sequence
 * playback advances on a timer so the draft preview still sweeps the cut.
 * Space is handled at the workspace level, not here. */
export function Monitor({ variant = "inline" }: { variant?: "inline" | "panel" }) {
  const { board, client, currentProject, selectedNode } = useApp();
  const { playing, sceneId, sequence, elapsed, seekOffset, seekNonce, play, pause, stop, tick, seek } =
    usePlayback();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoBroken, setVideoBroken] = useState(false);

  const scenes = useMemo(() => (board ? orderedScenes(board) : []), [board]);
  const durations = useMemo(
    () => (board ? sceneDurations(board, scenes) : []),
    [board, scenes],
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
      void video.play().catch((err: unknown) => {
        // play() rejects with AbortError whenever a pause() or a new load
        // interrupts it — which is the NORMAL result of scrubbing, switching
        // scenes, or a board refresh swapping the src. Treating that as a
        // broken clip permanently fell back to the still image and stuck
        // there, because videoBroken only resets when clipUrl changes.
        // NotAllowedError is autoplay policy, also not a broken file.
        const name = err instanceof DOMException ? err.name : "";
        if (name === "AbortError" || name === "NotAllowedError") return;
        setVideoBroken(true);
      });
    } else {
      video.pause();
    }
  }, [playing, sceneId, shown?.scene_id, videoBroken, clipUrl]);

  // A seek jumps the <video> to the requested in-scene offset — works
  // while paused too (the displayed frame updates).
  useEffect(() => {
    if (seekNonce === 0) return;
    const video = videoRef.current;
    if (!video || videoBroken) return;
    const apply = () => {
      // seekOffset is in TIMELINE seconds within this scene's slot; convert
      // it back to media time so the same scale applies in both directions.
      const slot = durations[shownIndex] ?? video.duration ?? 0;
      const source = video.duration || slot;
      const media = slot > 0 && source > 0 ? (seekOffset / slot) * source : seekOffset;
      video.currentTime = Math.max(0, Math.min(media, source || seekOffset));
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
    return () => video.removeEventListener("loadedmetadata", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce]);

  // Fallback playback: no playable video → advance on the scene's duration
  // so the assembled-draft preview still works against still images. The
  // timer resumes from the store's elapsed, so pause/resume and seeks keep
  // their place instead of restarting the scene.
  useEffect(() => {
    if (!playing || sceneId === null || shownIndex < 0) return;
    const usingVideo = Boolean(clipUrl) && !videoBroken;
    if (usingVideo) return;
    const duration = durations[shownIndex];
    // Resume from elapsed only when it falls inside this scene's window —
    // a card click carries the previous playback's global elapsed.
    const within = usePlayback.getState().elapsed - offsetBefore;
    const base = within >= 0 && within < duration ? within : 0;
    const started = performance.now();
    const timer = setInterval(() => {
      const inScene = base + (performance.now() - started) / 1000;
      if (inScene >= duration) {
        clearInterval(timer);
        advance();
      } else {
        tick(offsetBefore + inScene, totalDuration);
      }
    }, 120);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, sceneId, shownIndex, videoBroken, clipUrl, seekNonce]);

  if (!shown) return null;

  const progress = totalDuration > 0 ? Math.min(1, elapsed / totalDuration) : 0;

  const toggle = () => {
    if (playing) pause();
    else if (shown) play(shown.scene_id, sceneId !== null ? sequence : false);
  };

  // Jump anywhere in the assembled cut: find the scene containing t and
  // seek its clip to the in-scene offset.
  const seekGlobal = (t: number) => {
    const clamped = Math.max(0, Math.min(totalDuration - 0.01, t));
    let before = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (clamped < before + durations[i] || i === scenes.length - 1) {
        seek(scenes[i].scene_id, clamped - before);
        tick(clamped, totalDuration);
        return;
      }
      before += durations[i];
    }
  };

  const scrubTo = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekGlobal(frac * totalDuration);
  };

  return (
    <div className={`monitor${variant === "panel" ? " in-panel" : ""}`} aria-label={t("monitor.aria")}>
      <div className="monitor-screen" onClick={toggle} role="button" tabIndex={-1}>
        {clipUrl && !videoBroken ? (
          <video
            ref={videoRef}
            src={clipUrl}
            muted={false}
            playsInline
            onError={() => setVideoBroken(true)}
            onTimeUpdate={(event) => {
              // The monitor plays the RAW per-scene clip, but the timeline is
              // measured in assembled durations — narration stretches a scene
              // at assembly, so the clip is usually shorter than the segment
              // it becomes. Reporting raw media time meant the playhead never
              // reached the end of the scene's slot, the readout never reached
              // the total, and the tail of the timeline could not be seeked.
              // Scale the clip's own progress across the slot it occupies.
              const media = event.currentTarget;
              const slot = durations[shownIndex] ?? media.duration ?? 0;
              const source = media.duration || slot;
              const fraction = source > 0 ? Math.min(1, media.currentTime / source) : 0;
              tick(offsetBefore + fraction * slot, totalDuration);
            }}
            onEnded={advance}
          />
        ) : stillUrl ? (
          <img src={stillUrl} alt={t("monitor.stillAlt", { n: shown.scene_id.replace(/^s/, "") })} />
        ) : (
          <div className="monitor-slate">
            <span>{shown.scene_id.replace(/^s/, "")}</span>
          </div>
        )}
        <button
          className={`monitor-play${playing ? " playing" : ""}`}
          aria-label={playing ? t("monitor.pause") : t("monitor.play")}
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
              ? t("monitor.renderingNote")
              : t("monitor.draftNote")}
          </span>
        )}
      </div>
      <div className="monitor-bar">
        <div
          className="monitor-scrub"
          role="slider"
          tabIndex={0}
          aria-label={t("monitor.scrubAria")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          onPointerDown={(event) => {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* inactive pointer (synthetic events) — click-seek still works */
            }
            scrubTo(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons & 1) scrubTo(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              seekGlobal(elapsed + (event.key === "ArrowRight" ? 1 : -1));
            }
          }}
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
