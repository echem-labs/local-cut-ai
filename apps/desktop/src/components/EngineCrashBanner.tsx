/**
 * The engine fell over, and the app says so instead of going quiet.
 *
 * Without this the only symptom was the sidebar's status light and every
 * action failing — the renderer keeps its whole state when the engine dies,
 * so the app looks intact and simply does nothing. Three things have to
 * reach the user: their work is still here, there is one button that brings
 * the engine back, and there is something to paste into a report before the
 * traceback scrolls out of a log they would have to go find.
 *
 * This replaces the plain `engineError` bar rather than joining it: an
 * engine that has not started yet and an engine that died are the same
 * sentence to a user, and only one of them has a button that helps.
 */
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { useApp } from "../store";
import { crashReport } from "../lib/crashReport";
import { Tip } from "./Tooltip";

export function EngineCrashBanner() {
  const { engineCrash, system, restartEngine } = useApp();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!engineCrash) return null;

  const restart = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    const message = await restartEngine();
    setBusy(false);
    if (message) setFailed(t("errors.engineRestartFailed", { detail: message }));
  };

  const copy = (): void => {
    const report = crashReport(engineCrash, { appVersion: __APP_VERSION__, system });
    void navigator.clipboard.writeText(report).then(() => setCopied(true));
  };

  return (
    <div
      className="banner error engine-crash"
      role="alert"
      aria-label={t("errors.engineCrashedAria")}
    >
      <p>
        <strong>{t("errors.engineCrashed")}</strong> {t("errors.engineCrashedDetail")}
      </p>
      {failed && <p className="hint engine-crash-failed">{failed}</p>}
      <div className="engine-crash-actions">
        <button className="btn-outline" onClick={() => void restart()} disabled={busy}>
          {busy ? t("errors.engineRestarting") : t("errors.engineRestart")}
        </button>
        <Tip label={t("errors.engineCopyReport")} hint={t("errors.engineCopyReportHint")}>
          <button className="btn-ghost" onClick={copy}>
            {copied ? t("errors.engineReportCopied") : t("errors.engineCopyReport")}
          </button>
        </Tip>
      </div>
    </div>
  );
}
