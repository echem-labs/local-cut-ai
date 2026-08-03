import { t } from "../i18n";

/**
 * One stage of the pipeline as a settled summary line: STAGE · model ·
 * live status, status right-aligned so six rows read as a table. Wizard
 * step 4 first; Home's download strip adopts the same rows in U2 — which
 * is why status is a typed union here, not pre-rendered text.
 */
export type StageStatus =
  | { kind: "external"; note: string }
  | { kind: "installed" }
  | { kind: "downloading"; pct: number }
  | { kind: "queued" };

export function StageSummaryRow({
  stage,
  name,
  id,
  status,
}: {
  stage: string;
  name: string;
  id: string;
  status: StageStatus;
}) {
  return (
    <div className="srow">
      <span className="stage">{stage}</span>
      <div className="model">
        {name}
        <small>{id}</small>
      </div>
      {status.kind === "external" && <div className="st ext">{status.note}</div>}
      {status.kind === "installed" && (
        <div className="st ok">{t("firstRun.statusInstalled")}</div>
      )}
      {status.kind === "queued" && <div className="st dl">{t("firstRun.statusQueued")}</div>}
      {status.kind === "downloading" && (
        <div className="st dl">
          {t("firstRun.statusDownloading", { pct: status.pct })}
          <span
            className="bar"
            role="progressbar"
            aria-valuenow={status.pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${status.pct}%` }} />
          </span>
        </div>
      )}
    </div>
  );
}
