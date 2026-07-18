import { useEffect } from "react";
import { useApp } from "../store";
import { formatSize } from "./ModelLibrary";

// Safety net when the WS is down or a terminal event was missed; WS
// progress events (~0.5s) drive the numbers in between. Same rationale as
// ModelLibrary's poll — the tray may be the only download surface mounted.
const POLL_MS = 4000;

/** Bottom-right pill: current job + progress; local jobs show time, never
 * money. Background model downloads join the pill (click → Settings) so
 * Home is honest about work the engine is doing off-screen. */
export function QueueTray() {
  const { jobs, models, refreshModels, openSettings, firstRunDone } = useApp();
  const active = jobs.find((job) => job.status === "rendering");
  const queued = jobs.filter((job) => job.status === "queued").length;

  // During first-run the setup screen already shows per-model bars —
  // and Settings isn't reachable yet, so the tray link would dead-end.
  const downloads = firstRunDone ? models.filter((row) => row.downloading) : [];

  const anyDownloading = downloads.length > 0;
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => {
      refreshModels().catch((err) => console.warn("models poll failed:", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshModels]);

  const hasJobs = active !== undefined || queued > 0;
  if (!hasJobs && downloads.length === 0) return null;

  // A row's byte total falls back to its manifest size until the first
  // progress event lands, so the aggregate never jumps from 0.
  let done = 0;
  let total = 0;
  for (const row of downloads) {
    done += row.progress?.done ?? 0;
    total += row.progress && row.progress.total > 0 ? row.progress.total : row.size_bytes;
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="queue-tray" role="status">
      {hasJobs && (
        <>
          {active ? (
            <>
              <span
                className="status-ring rendering"
                style={{ background: "var(--status-generating)" }}
              />
              <span>
                {active.spec.node_id} · {Math.round(active.progress * 100)}%
              </span>
            </>
          ) : (
            <span>idle</span>
          )}
          {queued > 0 && <span>+{queued} queued</span>}
          <span className="cost-badge">free · local</span>
        </>
      )}
      {downloads.length > 0 && (
        <button
          className="tray-downloads"
          onClick={openSettings}
          title="Downloading models — click for details in Settings"
        >
          ⬇ {downloads.length} model{downloads.length === 1 ? "" : "s"} · {pct}% ·{" "}
          {formatSize(Math.max(0, total - done))} left
        </button>
      )}
    </div>
  );
}
