/**
 * A log file, because a support bundle needs something to put in it.
 *
 * The main process already narrates itself — engine spawn and teardown,
 * port reclaims, keychain decisions, renderer load failures — but only to
 * `console`, which in a packaged app goes to a stdout nobody is attached
 * to. On Windows that output is simply gone. So the one artifact that
 * explains a failed launch has, until now, existed exclusively in the
 * terminal of whoever ran the app from source.
 *
 * This tees the same lines to `<userData>/logs/localcut.log`. Tees, rather
 * than redirects: `npm run dev` must keep printing to the terminal, and the
 * rig reads console output to decide a launch went wrong.
 *
 * What is NOT here: the engine's own logging, which the engine writes for
 * itself, and any log shipping. Nothing leaves the machine unless a person
 * exports a bundle and chooses where to save it.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

/** Rotate past this, keeping one previous file — so the worst case on disk
 * (and in a bundle) is bounded at twice this, and a long-running session
 * cannot quietly fill a drive. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Current file first: whoever opens a bundle wants the session that just
 * failed, not the one before it. */
export const LOG_NAMES = ["localcut.log", "localcut.log.1"] as const;

type Level = "log" | "warn" | "error";

/** Set once a write has failed. A read-only or full disk must not turn
 * every subsequent console call into another failing write — and must never
 * be reported *through* console, which is the very thing being wrapped. */
let sink: string | null = null;
let broken = false;

const stamp = (level: Level, args: unknown[]): string => {
  const text = args
    .map((arg) => (typeof arg === "string" ? arg : safeInspect(arg)))
    .join(" ")
    .trimEnd();
  return `${new Date().toISOString()} [${level}] ${text}\n`;
};

/** Errors carry their message on a non-enumerable property, so JSON.stringify
 * renders the one thing worth logging as `{}`. */
function safeInspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    // No file yet (the common case on the first line), or a rename the OS
    // refused. Neither is worth losing the line that prompted it.
  }
}

function write(line: string): void {
  if (!sink || broken) return;
  try {
    rotate(sink);
    appendFileSync(sink, line, "utf8");
  } catch {
    broken = true;
  }
}

/**
 * Start teeing console output into `dir`. Returns the file being written,
 * or null if the directory could not be created — in which case the app
 * carries on with console alone, since losing the log is not worth losing
 * the app.
 */
export function installLogSink(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  sink = path.join(dir, LOG_NAMES[0]);
  broken = false;

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      write(stamp(level, args));
    };
  }
  return sink;
}

/**
 * The log files, for the bundle. Missing ones are skipped rather than
 * carried as empty entries: a zip holding `localcut.log.1` with nothing in
 * it invites a reader to conclude the previous session logged nothing.
 */
export function readLogFiles(dir: string): { name: string; data: Buffer }[] {
  const files: { name: string; data: Buffer }[] = [];
  for (const name of LOG_NAMES) {
    try {
      files.push({ name, data: readFileSync(path.join(dir, name)) });
    } catch {
      // Not there. Nothing to say about it.
    }
  }
  return files;
}
