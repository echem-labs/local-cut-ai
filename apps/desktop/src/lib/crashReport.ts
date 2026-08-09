/**
 * What the user pastes into a bug report when the engine falls over.
 *
 * Nothing here uploads, and nothing here is collected in the background —
 * `support.ts` states that policy for the bundle and this is the same
 * promise at a smaller size: a block of text, built when a button is
 * pressed, that goes to the clipboard and nowhere else.
 *
 * The engine's own last words are the point. A version block alone answers
 * "which build" and not "what happened", and the traceback is already gone
 * from the screen by the time anyone thinks to look — the app log holds it,
 * but asking someone to find their app-data folder is where a report stops
 * being written. The lines arrive here already token-redacted, because
 * `mirrorEngineOutput` redacts before anything downstream sees them.
 */
import type { EngineCrash, SystemInfo } from "../api/types";
import { t } from "../i18n";

export interface CrashContext {
  /** The desktop build, from the define in `vite.config.ts`. */
  appVersion: string;
  /** Last known `/system`, which survives the engine that answered it. */
  system: SystemInfo | null;
}

/** The report, as one clipboard-ready block. */
export function crashReport(crash: EngineCrash, context: CrashContext): string {
  const unknown = t("errors.crashReportUnknown");
  const lines = [
    t("errors.crashReportApp", { version: context.appVersion }),
    t("errors.crashReportOs", {
      os: context.system?.hardware.os ?? unknown,
      arch: context.system?.hardware.arch ?? unknown,
    }),
    t("errors.crashReportBackend", { backend: context.system?.backend_mode ?? unknown }),
    // A signal and an exit code are different facts, and "code null" reads
    // as a missing value rather than as "a signal ended it".
    crash.signal
      ? t("errors.crashReportExitSignal", { signal: crash.signal })
      : t("errors.crashReportExitCode", { code: String(crash.code) }),
    t("errors.crashReportWhen", { at: crash.at }),
    "",
    t("errors.crashReportOutput"),
    ...(crash.tail.length > 0 ? crash.tail : [t("errors.crashReportNoOutput")]),
  ];
  return lines.join("\n");
}
