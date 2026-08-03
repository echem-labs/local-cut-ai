/**
 * The recommended slate as a wired rail: a spine joins one dot per stage —
 * the canvas's port-and-wire language, met before the canvas is. Dots stay
 * neutral on purpose: the rail is structure, and the trailing badge
 * already carries a row's status.
 *
 * Purely presentational — the wizard owns selection; U4's canvas work may
 * grow other consumers, so nothing here reads the store.
 */
export interface PipelineRailRow {
  key: string;
  name: string;
  meta: string;
  checked: boolean;
  toggleAria: string;
  onToggle: () => void;
}

export function PipelineRail({ rows }: { rows: PipelineRailRow[] }) {
  return (
    <div className="pipe-rail">
      {rows.map((row) => (
        <div className="pipe-row" key={row.key}>
          <span className="pipe-dot" aria-hidden="true" />
          <input
            type="checkbox"
            checked={row.checked}
            onChange={row.onToggle}
            aria-label={row.toggleAria}
          />
          <div className="grow">
            <div className="name">{row.name}</div>
            <div className="meta">{row.meta}</div>
          </div>
          {/* the checkbox already announces state — this echo is visual */}
          {row.checked && (
            <span className="badge ok" aria-hidden="true">
              ✓
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
