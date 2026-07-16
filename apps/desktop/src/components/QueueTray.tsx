import { useApp } from "../store";

/** Bottom-right pill: current job + progress; local jobs show time, never
 * money. */
export function QueueTray() {
  const { jobs } = useApp();
  const active = jobs.find((job) => job.status === "rendering");
  const queued = jobs.filter((job) => job.status === "queued").length;

  if (!active && queued === 0) return null;

  return (
    <div className="queue-tray" role="status">
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
    </div>
  );
}
