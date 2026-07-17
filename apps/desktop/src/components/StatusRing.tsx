import type { NodeStatus } from "../api/types";

const COLORS: Record<NodeStatus, string> = {
  queued: "var(--text-tertiary)",
  rendering: "var(--status-generating)",
  draft: "var(--status-draft)",
  final: "var(--status-final)",
  failed: "var(--status-failed)",
  cancelled: "var(--text-tertiary)",
  pinned: "var(--status-pinned)",
};

export function StatusRing({ status, progress }: { status: NodeStatus; progress: number }) {
  const label =
    status === "rendering"
      ? `rendering, ${Math.round(progress * 100)}%`
      : status;
  return (
    <span
      className={`status-ring ${status}`}
      style={{ background: COLORS[status] }}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

export function StatusChip({ status }: { status: NodeStatus }) {
  return (
    <span className="status-chip" style={{ color: COLORS[status], background: "var(--surface-2)" }}>
      {status}
    </span>
  );
}
