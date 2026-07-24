/** The composer's per-project edit log, persisted in localStorage.
 *
 * It lives here rather than in the component so the store can drop a
 * deleted project's log without importing the component (which imports the
 * store). Every accessor swallows storage errors: a full or disabled
 * origin store must degrade to "no history", never break the composer. */

export interface LogEntry {
  at: number;
  instruction: string;
  summary: string;
  dirty: string[];
  warnings: string[];
}

/** Kept short: the log is a convenience, not a record. */
export const MAX_LOG_ENTRIES = 40;

const logKey = (projectId: string) => `localcut.editlog.${projectId}`;

export function loadLog(projectId: string): LogEntry[] {
  try {
    const raw = localStorage.getItem(logKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_LOG_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function saveLog(projectId: string, entries: LogEntry[]): void {
  try {
    localStorage.setItem(logKey(projectId), JSON.stringify(entries));
  } catch {
    /* storage full — the log just won't survive a restart */
  }
}

/** Drop a deleted project's log. These keys are per-project and were never
 * cleaned up, so they accumulated for the life of the install; once the
 * origin quota is reached EVERY setItem starts throwing, and the app's other
 * persisted state (rail tabs, panel layout, render-time stats) degrades
 * silently in its own catch block — the workspace quietly stops surviving a
 * restart, with no error anywhere. */
export function forgetEditLog(projectId: string): void {
  try {
    localStorage.removeItem(logKey(projectId));
  } catch {
    /* storage unavailable — nothing to reclaim */
  }
}
