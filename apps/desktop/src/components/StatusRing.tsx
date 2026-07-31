import type { NodeStatus } from "../api/types";
import { t } from "../i18n";

const COLORS: Record<NodeStatus, string> = {
  queued: "var(--text-tertiary)",
  rendering: "var(--status-generating)",
  draft: "var(--status-draft)",
  final: "var(--status-final)",
  failed: "var(--status-failed)",
  cancelled: "var(--text-tertiary)",
  pinned: "var(--status-pinned)",
  // The same muted tone as cancelled: nothing is wrong, and nothing is coming.
  skipped: "var(--text-tertiary)",
  // Not muted and not red: nothing is broken, but this one is asking for
  // something. The draft tone reads as "unfinished", which is what it is.
  blocked: "var(--status-draft)",
};

/** The status word in the reserved colors, translated. */
function statusLabel(status: NodeStatus): string {
  return t(`status.${status}`);
}

export function StatusRing({ status, progress }: { status: NodeStatus; progress: number }) {
  const label =
    status === "rendering"
      ? t("status.renderingLong", { pct: Math.round(progress * 100) })
      : statusLabel(status);
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

/** Status pill: dot + word in the reserved colors — the board reads as a
 * status map. Rendering shows live percent. */
export function StatusPill({
  status,
  progress = 0,
  onThumb = false,
}: {
  status: NodeStatus;
  progress?: number;
  onThumb?: boolean;
}) {
  const text =
    status === "rendering" && progress > 0
      ? t("status.renderingPct", { pct: Math.round(progress * 100) })
      : statusLabel(status);
  return (
    <span
      className={`status-pill${onThumb ? " on-thumb" : ""}`}
      style={{ color: COLORS[status], ...(onThumb ? {} : { background: "var(--surface-2)" }) }}
      role="img"
      aria-label={text}
    >
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function StatusChip({ status }: { status: NodeStatus }) {
  return (
    <span className="status-chip" style={{ color: COLORS[status], background: "var(--surface-2)" }}>
      {statusLabel(status)}
    </span>
  );
}
