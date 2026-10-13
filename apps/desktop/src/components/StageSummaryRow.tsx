import { t } from "../i18n";

/**
 * One stage of the pipeline as a settled summary line: a light, the stage,
 * the model with what runs it under it, and the live status, right-aligned
 * so the rows read as a table. Wizard's last step first; Home's download
 * strip shows the same rows, which is why status is a typed union here, not
 * pre-rendered text.
 */
export type StageStatus =
  | { kind: "external"; note: string }
  | { kind: "installed" }
  | { kind: "downloading"; pct: number }
  | { kind: "settingUp"; pct: number }
  | { kind: "queued" }
  /** Something the stage needs is not there: `fail` when its jobs fail,
   * `ph` when they make a stand-in. */
  | { kind: "missing"; note: string; light: "fail" | "ph" };

const DOT: Record<StageStatus["kind"], string> = {
  external: "ext",
  installed: "ok",
  downloading: "busy",
  settingUp: "busy",
  queued: "wait",
  missing: "fail",
};

export function StageSummaryRow({
  stage,
  name,
  runner,
  status,
}: {
  stage: string;
  name: string;
  /** What runs the model ("in ComfyUI", "built in"), or who set the
   * program up. Empty when the app cannot say. */
  runner: string;
  status: StageStatus;
}) {
  const light = status.kind === "missing" ? status.light : DOT[status.kind];
  const pct = status.kind === "downloading" || status.kind === "settingUp" ? status.pct : null;
  return (
    <div className="srow">
      <span className={`pdot ${light}`} aria-hidden="true" />
      <span className="stage">{stage}</span>
      <div className="model">
        {name}
        {runner && <small>{runner}</small>}
      </div>
      {status.kind === "external" && <div className="st ext">{status.note}</div>}
      {status.kind === "installed" && (
        <div className="st ok">{t("firstRun.statusInstalled")}</div>
      )}
      {status.kind === "queued" && <div className="st dl">{t("firstRun.statusQueued")}</div>}
      {status.kind === "missing" && <div className="st fail">{status.note}</div>}
      {pct !== null && (
        <div className="st dl">
          {status.kind === "settingUp"
            ? t("firstRun.statusSettingUp", { pct })
            : t("firstRun.statusDownloading", { pct })}
          <span
            className="bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${pct}%` }} />
          </span>
        </div>
      )}
    </div>
  );
}
