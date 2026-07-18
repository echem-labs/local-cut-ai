import { Download, Pause, X } from "lucide-react";
import { useEffect } from "react";
import { nodeLabel } from "../help/terms";
import { useApp } from "../store";
import { formatSize } from "./ModelLibrary";

// Safety net when the WS is down or a terminal event was missed; WS
// progress events (~0.5s) drive the numbers in between. Same rationale as
// ModelLibrary's poll — the tray may be the only download surface mounted.
const POLL_MS = 4000;

// r=7 in an 18px viewBox → circumference for the progress arc.
const RING_C = 2 * Math.PI * 7;

/** Bottom-right pill: current job + progress ring; local jobs show time,
 * never money. Background model downloads join the pill (click → Settings)
 * so Home is honest about work the engine is doing off-screen. */
export function QueueTray() {
  const { jobs, models, refreshModels, openSettings, startDownload, cancelJob, firstRunDone } =
    useApp();
  const active = jobs.find((job) => job.status === "rendering");
  const queued = jobs.filter((job) => job.status === "queued").length;

  // During first-run the setup screen already shows per-model bars —
  // and Settings isn't reachable yet, so the tray link would dead-end.
  const downloads = firstRunDone ? models.filter((row) => row.downloading) : [];
  // Interrupted downloads (e.g. the app was closed mid-download): partial
  // bytes on disk, nothing running. Resume picks up where they stopped.
  const paused = firstRunDone
    ? models.filter((row) => !row.downloaded && !row.downloading && row.partial_bytes > 0)
    : [];

  const anyDownloading = downloads.length > 0;
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => {
      refreshModels().catch((err) => console.warn("models poll failed:", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshModels]);

  const hasJobs = active !== undefined || queued > 0;
  if (!hasJobs && downloads.length === 0 && paused.length === 0) return null;

  // A row's byte total falls back to its manifest size until the first
  // progress event lands, so the aggregate never jumps from 0.
  let done = 0;
  let total = 0;
  for (const row of downloads) {
    done += row.progress?.done ?? 0;
    total += row.progress && row.progress.total > 0 ? row.progress.total : row.size_bytes;
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const jobProgress = active ? Math.max(0, Math.min(1, active.progress)) : 0;

  return (
    <div className="queue-tray" role="status">
      {hasJobs && (
        <>
          {active ? (
            <>
              <svg className="tray-ring" viewBox="0 0 18 18" aria-hidden="true">
                <circle className="track" cx="9" cy="9" r="7" />
                <circle
                  className="arc"
                  cx="9"
                  cy="9"
                  r="7"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - jobProgress)}
                />
              </svg>
              <span>
                <b>{nodeLabel(active.spec.node_id)}</b> · {Math.round(active.progress * 100)}%
              </span>
              <button
                className="tray-cancel"
                aria-label="Stop this render"
                title="Stop this render"
                onClick={() => void cancelJob(active.id)}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </>
          ) : (
            <span>idle</span>
          )}
          {queued > 0 && <span>+{queued} queued</span>}
          <span className="cost-badge">free · local</span>
        </>
      )}
      {hasJobs && (downloads.length > 0 || paused.length > 0) && <span className="divider" />}
      {downloads.length > 0 && (
        <button
          className="tray-downloads"
          onClick={() => openSettings("models")}
          title="Downloading models — click for details in Settings"
        >
          <Download size={12} strokeWidth={2} />
          {downloads.length} model{downloads.length === 1 ? "" : "s"} · {pct}% ·{" "}
          {formatSize(Math.max(0, total - done))} left
        </button>
      )}
      {paused.length > 0 && (
        <button
          className="tray-downloads"
          onClick={() => {
            for (const row of paused) void startDownload(row.id);
          }}
          title="Interrupted model downloads — resumes from where they stopped"
        >
          <Pause size={12} strokeWidth={2} />
          {paused.length} download{paused.length === 1 ? "" : "s"} paused · Resume (
          {formatSize(paused.reduce((sum, row) => sum + Math.max(0, row.size_bytes - row.partial_bytes), 0))}{" "}
          left)
        </button>
      )}
    </div>
  );
}
