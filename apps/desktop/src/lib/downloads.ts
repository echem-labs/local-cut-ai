/**
 * Everything still coming down to the engine, model weights and program
 * setups together, and how long it has left at the speed the connection is
 * giving all of it.
 *
 * They share one line. On a fresh install the models step starts every
 * model at once while "Set up all three" fetches FFmpeg, ComfyUI, Ollama and
 * the script model Ollama pulls, and each of them gets a share of the same
 * few MB/s. A total of either half on its own, timed at what that half
 * happens to be getting, is wrong about both: the models came to 25 GB of
 * 35 and said "about 109 min left" for a download that took most of three
 * hours, and a program whose share is 0.1 MB/s while the models run gets the
 * whole line the moment they end.
 *
 * So the bytes are counted together and the time is the bytes left over the
 * line's speed: every byte that arrives, from any of them, over about the
 * last minute. Until that has been seen for a few seconds there is no speed,
 * and the screens say they are still working the time out rather than
 * guess one.
 */
import type { ModelRow, ProgramId, ProgramInfo, ProgramsReport } from "../api/types";
import { bytesToSetUp } from "./setupTime";

/** Bytes in, of bytes in all. */
export interface Bytes {
  done: number;
  total: number;
}

export const NO_BYTES: Bytes = { done: 0, total: 0 };

export const addBytes = (a: Bytes, b: Bytes): Bytes => ({
  done: a.done + b.done,
  total: a.total + b.total,
});

export const bytesLeft = (bytes: Bytes): number => Math.max(0, bytes.total - bytes.done);

/** A model's bytes. Its total falls back to the catalog's size until the
 * first progress event names the real one. */
export function modelBytes(row: ModelRow): Bytes {
  const total = Math.max(row.size_bytes, row.progress?.total ?? 0);
  if (row.downloaded) return { done: total, total };
  return { done: Math.min(total, row.progress?.done ?? 0), total };
}

/** What a program setup still has to fetch over the network: the rest of
 * its download, then the model Ollama's setup pulls, which the catalog
 * prices until Ollama names its layers. Unpacking and checking move no
 * network bytes. A setup waiting its turn has all of it still to fetch. */
export function setupBytesLeft(program: ProgramInfo, queued: boolean): number {
  const job = program.setup.job;
  if (!job) return queued ? bytesToSetUp(program) : 0;
  const pull = program.setup.pull?.bytes ?? 0;
  if (job.phase === "downloading") return Math.max(0, job.total - job.done) + pull;
  if (job.phase === "pulling") return Math.max(0, Math.max(job.total, pull) - job.done);
  return pull;
}

/** A program setup's bytes, or null when it is not coming down: not
 * running, not waiting its turn and not started by this window.
 *
 * `planned` is what the setup was to fetch when this window started it. The
 * store keeps it, so a setup that has finished stays in the total as all
 * in, the way a downloaded model does, rather than taking its bytes out of
 * both sides of the count. One started elsewhere (the CLI, another window)
 * counts what it has fetched in the phase on screen. */
export function setupBytes(
  program: ProgramInfo,
  planned: number | undefined,
  queued: boolean,
): Bytes | null {
  const left = setupBytesLeft(program, queued);
  const job = program.setup.job;
  if (planned === undefined) {
    if (!job && !queued) return null;
    const fetched = job && (job.phase === "downloading" || job.phase === "pulling") ? job.done : 0;
    return { done: fetched, total: fetched + left };
  }
  const total = Math.max(planned, left);
  return { done: total - left, total };
}

/** Every program setup that is coming down or came down from this window,
 * summed. */
export function setupsBytes(
  report: ProgramsReport | null,
  queue: readonly ProgramId[],
  plans: Partial<Record<ProgramId, number>>,
): Bytes {
  let sum = NO_BYTES;
  for (const program of report?.programs ?? []) {
    const bytes = setupBytes(program, plans[program.id], queue.includes(program.id));
    if (bytes) sum = addBytes(sum, bytes);
  }
  return sum;
}

/** What is in flight right now: the models downloading and the setups
 * running or waiting their turn. The share of the line the programs get
 * depends on it. */
export function inFlightBytes(
  models: readonly ModelRow[],
  report: ProgramsReport | null,
  queue: readonly ProgramId[],
  plans: Partial<Record<ProgramId, number>> = {},
): Bytes {
  let sum = NO_BYTES;
  for (const row of models) if (row.downloading) sum = addBytes(sum, modelBytes(row));
  for (const program of report?.programs ?? []) {
    const queued = queue.includes(program.id);
    if (!program.setup.job && !queued) continue;
    const bytes = setupBytes(program, plans[program.id], queued);
    if (bytes) sum = addBytes(sum, bytes);
  }
  return sum;
}

/** How many downloads are in flight: models and program setups. */
export function inFlightCount(
  models: readonly ModelRow[],
  report: ProgramsReport | null,
  queue: readonly ProgramId[],
): number {
  const setups = (report?.programs ?? []).filter(
    (program) => program.setup.job || queue.includes(program.id),
  ).length;
  return models.filter((row) => row.downloading).length + setups;
}

/** How fast bytes are arriving on the line, all downloads together. */
export interface LineMeter {
  /** The bytes that arrived, decayed with age. */
  bytes: number;
  /** The time they arrived over, decayed the same way. */
  seconds: number;
  /** When the last arrival was counted, in ms. */
  at: number;
}

/** How far back the speed reaches, in seconds. It is also how long the line
 * can go quiet before the next arrival starts the reading over: a speed from
 * before a pause says nothing about the downloads after it. */
const LINE_WINDOW_S = 60;

/** How long the line has to have been watched before its speed is said.
 * The engine's own readings for a setup are over five seconds. */
const LINE_MEASURED_S = 5;

/** The meter after `bytes` more arrived at `at`. Every download's progress
 * events feed one meter, so it reads the line rather than one share of it.
 * The first arrival, and the first after a quiet minute, only starts the
 * clock: what came before it came over time nobody watched. */
export function lineArrival(prev: LineMeter | null, bytes: number, at: number): LineMeter {
  if (!prev || at - prev.at > LINE_WINDOW_S * 1000) return { bytes: 0, seconds: 0, at };
  const stood = Math.max(0, (at - prev.at) / 1000);
  const decay = Math.exp(-stood / LINE_WINDOW_S);
  return {
    bytes: prev.bytes * decay + Math.max(0, bytes),
    seconds: prev.seconds * decay + stood,
    at,
  };
}

/** The line's speed in bytes a second, or null until it has been watched
 * long enough to say. */
export function lineSpeedOf(meter: LineMeter | null): number | null {
  return meter && meter.seconds >= LINE_MEASURED_S ? meter.bytes / meter.seconds : null;
}

/** How long `left` bytes take at the line's speed, or null before it has
 * one. */
export function lineSecondsLeft(left: number, meter: LineMeter | null): number | null {
  const speed = lineSpeedOf(meter);
  return speed !== null && speed > 0 ? left / speed : null;
}

/** How long program setups have left when other downloads share the line.
 * A setup's own speed is only its share: it speeds up when the rest end.
 * It cannot finish later than everything in flight would at the line's
 * speed, though, so the earlier of the two is the answer, and either one
 * alone is when the other is not known. */
export function sharedSecondsLeft(
  own: number | null,
  everythingLeft: number,
  meter: LineMeter | null,
): number | null {
  const together = lineSecondsLeft(everythingLeft, meter);
  if (own === null) return together;
  return together === null ? own : Math.min(own, together);
}
