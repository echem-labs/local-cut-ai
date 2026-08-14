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

/**
 * How long a restart may take before the wait needs explaining.
 *
 * Long enough that the ordinary restart — a second or two — says nothing, and
 * short enough to arrive well before anyone concludes the button is dead.
 */
const SLOW_RESTART_MS = 5_000;

export function EngineCrashBanner() {
  const { engineCrash, system, restartEngine } = useApp();
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // A restart that lands in the minute after a crash cannot be quick: the
  // engine's port is still reserved by the kernel (see electron/engine.ts,
  // REBIND_TIMEOUT_MS) and the app spends that minute retrying. Said out loud
  // because a disabled button and no other movement for sixty seconds is
  // indistinguishable from one that does nothing — which is what people
  // reported, and why they force-quit instead of waiting the wait out.
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_RESTART_MS);
    return () => clearTimeout(timer);
  }, [busy]);

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
      {slow && (
        // role="status": it appears while the user is watching the button they
        // just pressed, so it has to reach a screen reader without stealing
        // focus the way the alert around it already did once.
        <p className="hint engine-crash-slow" role="status">
          {t("errors.engineRestartSlow")}
        </p>
      )}
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
