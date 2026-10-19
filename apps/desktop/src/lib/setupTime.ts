/**
 * How fast a program setup is going and how long it has left, for the wells
 * and the first-run programs step.
 *
 * The engine sends a speed with every progress event, measured over the last
 * five seconds of the transfer. That is the right figure for "is anything
 * arriving" but the wrong one to divide a time left out of. A download from
 * a CDN that sends in bursts swung between 0 and 5 MB/s within a minute. A
 * time left divided out of it swings as far. So the speed shown is an average of those readings
 * over about the last minute, each weighted by how long it stood, which
 * starts from the first reading rather than from zero and follows a lasting
 * change within a few minutes.
 *
 * The time left is for the whole of what a setup still has to fetch, not the
 * phase it is in: Ollama's download is followed by the model pull, at the
 * speed the download was going.
 */
import type { ProgramId, ProgramInfo, ProgramsReport, SetupPhase } from "../api/types";
import { t } from "../i18n";
import { setupOffer, setupSize } from "./programs";

/** How far back the average reaches, in seconds. A reading this old counts
 * for about a third of a fresh one. */
const SPEED_WINDOW_S = 60;

/** The phases whose progress is bytes moving and so have a speed. */
const TRANSFERS: readonly SetupPhase[] = ["downloading", "unpacking", "pulling"];
/** The ones whose bytes come over the network. */
const NETWORK: readonly SetupPhase[] = ["downloading", "pulling"];

/** The running average for one phase of one setup. */
export interface SetupSpeed {
  phase: SetupPhase;
  /** The readings so far, each times how long it stood, decayed with age. */
  sum: number;
  /** How long they stood, decayed the same way. */
  weight: number;
  /** When the last event came, in ms. */
  at: number;
}

/** The average after one more progress event. A new phase starts it over:
 * an unpack's speed is the disk's, not the network's. The first reading
 * stands for the half second the engine waits between events. */
export function nextSpeed(
  prev: SetupSpeed | undefined,
  phase: SetupPhase,
  reading: number | null,
  at: number,
): SetupSpeed {
  const same = prev !== undefined && prev.phase === phase;
  const base = same ? prev : { phase, sum: 0, weight: 0, at: at - 500 };
  if (reading === null || !TRANSFERS.includes(phase)) return { ...base, at };
  const stood = Math.max(0, (at - base.at) / 1000);
  const decay = Math.exp(-stood / SPEED_WINDOW_S);
  return {
    phase,
    sum: base.sum * decay + reading * stood,
    weight: base.weight * decay + stood,
    at,
  };
}

/** The average, or null before the phase has a reading. */
export function speedOf(speed: SetupSpeed | undefined): number | null {
  return speed && speed.weight > 0 ? speed.sum / speed.weight : null;
}

/** Whether a phase's bytes come over the network, so its speed is the one
 * to price the rest of the downloads at. */
export const isNetworkPhase = (phase: SetupPhase): boolean => NETWORK.includes(phase);

/** The speed of a program's running phase: the average when the store has
 * one for that phase, else the engine's own reading (a setup this window
 * has not seen an event for yet). */
export function phaseSpeedOf(
  program: ProgramInfo,
  speeds: Partial<Record<ProgramId, SetupSpeed>>,
): number | null {
  const job = program.setup.job;
  if (!job) return null;
  const speed = speeds[program.id];
  const average = speed && speed.phase === job.phase ? speedOf(speed) : null;
  return average ?? job.bytes_per_s;
}

/** The speed to price what is still to download at: the latest average
 * from a download or a pull, else what one running now reads. */
export function networkSpeedOf(
  report: ProgramsReport | null,
  speeds: Partial<Record<ProgramId, SetupSpeed>>,
  latest: number | null,
): number | null {
  if (latest !== null) return latest;
  for (const program of report?.programs ?? []) {
    const job = program.setup.job;
    if (job && isNetworkPhase(job.phase)) return phaseSpeedOf(program, speeds);
  }
  return null;
}

/** The model pull a running setup still has ahead of it, in bytes: Ollama's
 * setup pulls the script model once its copy runs. */
function pullToCome(program: ProgramInfo): number {
  const job = program.setup.job;
  if (!job || job.phase === "pulling") return 0;
  return program.setup.pull?.bytes ?? 0;
}

export interface TimeLeft {
  seconds: number;
  /** Whether it covers more than the phase on screen. */
  inAll: boolean;
}

/** How long a running setup has left, all told, at `phaseSpeed` for what
 * its current phase still has to move and `networkSpeed` for the downloads
 * after it. Null when there is no job, or no speed to say it from yet. */
export function setupTimeLeft(
  program: ProgramInfo,
  phaseSpeed: number | null,
  networkSpeed: number | null,
): TimeLeft | null {
  const job = program.setup.job;
  if (!job) return null;
  const pull = pullToCome(program);
  const moving = TRANSFERS.includes(job.phase);
  if (!moving && pull === 0) return null;
  let seconds = 0;
  if (moving) {
    if (!phaseSpeed || phaseSpeed <= 0) return null;
    // A pull's total grows as Ollama names its layers. Until it has named
    // one, the catalog's figure for the model is the better guess.
    const total =
      job.phase === "pulling" && job.total <= 0 ? (program.setup.pull?.bytes ?? 0) : job.total;
    seconds += Math.max(0, total - job.done) / phaseSpeed;
  }
  if (pull > 0) {
    const speed = isNetworkPhase(job.phase) ? phaseSpeed : networkSpeed;
    if (!speed || speed <= 0) return null;
    seconds += pull / speed;
  }
  return { seconds, inAll: pull > 0 };
}

/** What a program waiting its turn will download once it starts: what its
 * well's button offers. */
export function bytesToSetUp(program: ProgramInfo): number {
  const offer = setupOffer(program);
  if (!offer || offer.kind === "start") return 0;
  if (offer.kind === "pull") return offer.size ?? 0;
  return setupSize(program) ?? 0;
}

/** How long the running setup and every one queued behind it have left, in
 * seconds, or null when any of it cannot be priced yet. */
export function queueSecondsLeft(
  running: ProgramInfo | null,
  queued: readonly ProgramInfo[],
  phaseSpeed: number | null,
  networkSpeed: number | null,
): number | null {
  let seconds = 0;
  // Whether anything was priced at all: a setup that is only checking or
  // starting has nothing left to fetch and no time to say for it.
  let priced = false;
  if (running?.setup.job) {
    const left = setupTimeLeft(running, phaseSpeed, networkSpeed);
    if (left === null && TRANSFERS.includes(running.setup.job.phase)) return null;
    if (left !== null) {
      seconds += left.seconds;
      priced = true;
    }
  }
  const waiting = queued.reduce((sum, program) => sum + bytesToSetUp(program), 0);
  if (waiting > 0) {
    if (!networkSpeed || networkSpeed <= 0) return null;
    seconds += waiting / networkSpeed;
    priced = true;
  }
  return priced ? seconds : null;
}

/** A time left in words, in steps that grow with it: whole minutes up to
 * ten, then fives, then tens of minutes past the hour and half hours past
 * two. A reading that moves a little stays on the same words. */
export function timePhrase(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes < 1) return t("programs.setup.time.underMinute");
  if (minutes < 9.5) return t("programs.setup.time.minutes", { minutes: Math.round(minutes) });
  if (minutes < 57.5) {
    return t("programs.setup.time.minutes", { minutes: Math.round(minutes / 5) * 5 });
  }
  const step = minutes < 120 ? 10 : 30;
  const rounded = Math.round(minutes / step) * step;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0
    ? t("programs.setup.time.hours", { hours })
    : t("programs.setup.time.hoursMinutes", { hours, minutes: rest });
}
