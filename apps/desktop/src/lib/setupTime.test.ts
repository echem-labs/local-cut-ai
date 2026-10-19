/**
 * How long a program setup has left, said so it does not jump around.
 *
 * The engine measures a download's speed over its last five seconds. Over
 * a CDN that sends in bursts, that reading went from 0 to 5 MB/s and back
 * within a minute of one real FFmpeg download. A time left divided straight
 * out of it would read "less than a minute", then "about 23 min", 40
 * seconds apart. The setup is also more than its current phase: Ollama's
 * 1.3 GB download is followed by a 5 GB model pull.
 */
import { describe, expect, it } from "vitest";

import type { ProgramInfo, ProgramJob } from "../api/types";
import { formatSpeed } from "./size";
import {
  nextSpeed,
  queueSecondsLeft,
  setupTimeLeft,
  speedOf,
  timePhrase,
  type SetupSpeed,
} from "./setupTime";

const MB = 2 ** 20;
const GB = 2 ** 30;

function program(
  id: ProgramInfo["id"],
  job: Partial<ProgramJob> | null,
  setup: Partial<ProgramInfo["setup"]> = {},
): ProgramInfo {
  return {
    id,
    state: "missing",
    problem: "not_found",
    source: "path",
    location: id,
    setting: "",
    version: null,
    checks: {},
    managed: null,
    setup: {
      available: true,
      unavailable_reason: null,
      takes_effect: true,
      version: "1",
      url: "https://example.test/a",
      download_bytes: 130 * MB,
      install_bytes: 270 * MB,
      job: job
        ? { id: "j", phase: "downloading", done: 0, total: 130 * MB, bytes_per_s: null, ...job }
        : null,
      last: null,
      ...setup,
    },
  } as ProgramInfo;
}

/** Feeds readings in, half a second apart as the engine sends them. */
function feed(readings: (number | null)[], phase: ProgramJob["phase"] = "downloading") {
  let speed: SetupSpeed | undefined;
  const seen: number[] = [];
  readings.forEach((reading, index) => {
    speed = nextSpeed(speed, phase, reading, index * 500);
    const now = speedOf(speed);
    if (now !== null) seen.push(now);
  });
  return { speed, seen };
}

describe("the speed a setup shows", () => {
  it("starts from the engine's first reading rather than from nothing", () => {
    const { seen } = feed([null, 3 * MB]);
    expect(seen).toEqual([3 * MB]);
  });

  it("holds steady through a download that arrives in bursts", () => {
    // Five seconds at 4.9 MB/s, then five at 50 KB/s, for four minutes: the
    // shape of the FFmpeg download that read 0 to 5 MB/s within a minute.
    const readings: number[] = [];
    for (let block = 0; block < 48; block++) {
      for (let tick = 0; tick < 10; tick++) readings.push(block % 2 === 0 ? 4.9 * MB : 0.05 * MB);
    }
    const { seen } = feed(readings);
    // After its first minute, one reading 20 seconds after another never
    // differs by more than a quarter, where the raw readings differ 98 times.
    const settled = seen.slice(120);
    for (let at = 40; at < settled.length; at++) {
      const ratio = settled[at]! / settled[at - 40]!;
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.33);
    }
    // And it is the download's average, not either extreme.
    expect(settled.at(-1)!).toBeGreaterThan(1.5 * MB);
    expect(settled.at(-1)!).toBeLessThan(3.5 * MB);
  });

  it("follows a lasting change within a few minutes", () => {
    const { seen } = feed([...Array(240).fill(4 * MB), ...Array(360).fill(1 * MB)]);
    expect(seen.at(-1)!).toBeLessThan(1.2 * MB);
  });

  it("starts over when the phase changes", () => {
    let speed = nextSpeed(undefined, "downloading", 3 * MB, 0);
    speed = nextSpeed(speed, "downloading", 3 * MB, 500);
    speed = nextSpeed(speed, "unpacking", null, 1000);
    expect(speedOf(speed)).toBeNull();
    speed = nextSpeed(speed, "unpacking", 90 * MB, 1500);
    expect(speedOf(speed)).toBe(90 * MB);
  });

  it("is said in kilobytes when it is under a megabyte a second", () => {
    expect(formatSpeed(150 * 1024)).toBe("150 KB/s");
    expect(formatSpeed(3.1 * MB)).toBe("3.1 MB/s");
    expect(formatSpeed(95 * MB)).toBe("95 MB/s");
  });
});

describe("the time a setup has left", () => {
  it("is FFmpeg's download at the speed shown", () => {
    const ffmpeg = program("ffmpeg", { done: 10 * MB, total: 130 * MB });
    expect(setupTimeLeft(ffmpeg, 2 * MB, 2 * MB)).toEqual({ seconds: 60, inAll: false });
  });

  it("is nothing to say before there is a speed", () => {
    expect(setupTimeLeft(program("ffmpeg", { done: 0 }), null, null)).toBeNull();
  });

  it("counts Ollama's model pull after its own download", () => {
    const ollama = program(
      "ollama",
      { done: 300 * MB, total: 1300 * MB },
      { download_bytes: 1300 * MB, pull: { model: "qwen3:8b", bytes: 5 * GB } },
    );
    const left = setupTimeLeft(ollama, 4 * MB, 4 * MB)!;
    expect(left.inAll).toBe(true);
    expect(left.seconds).toBeCloseTo((1000 * MB + 5 * GB) / (4 * MB));
  });

  it("prices the pull still to come at the last download speed while Ollama starts", () => {
    const ollama = program(
      "ollama",
      { phase: "starting", done: 0, total: 0 },
      { pull: { model: "qwen3:8b", bytes: 5 * GB } },
    );
    expect(setupTimeLeft(ollama, null, 4 * MB)).toEqual({
      seconds: (5 * GB) / (4 * MB),
      inAll: true,
    });
  });

  it("uses the catalog's size for a pull until Ollama names its layers", () => {
    const pull = { model: "qwen3:8b", bytes: 5 * GB };
    const naming = program("ollama", { phase: "pulling", done: 0, total: 0 }, { pull });
    expect(setupTimeLeft(naming, 4 * MB, 4 * MB)!.seconds).toBeCloseTo((5 * GB) / (4 * MB));
    const named = program("ollama", { phase: "pulling", done: 1 * GB, total: 4.9 * GB }, { pull });
    const left = setupTimeLeft(named, 4 * MB, 4 * MB)!;
    expect(left.seconds).toBeCloseTo((3.9 * GB) / (4 * MB));
    expect(left.inAll).toBe(false);
  });

  it("adds every program still waiting its turn, at the download speed", () => {
    const ffmpeg = program("ffmpeg", { done: 70 * MB, total: 130 * MB });
    const ollama = program("ollama", null, {
      download_bytes: 1300 * MB,
      pull: { model: "qwen3:8b", bytes: 5 * GB },
    });
    const seconds = queueSecondsLeft(ffmpeg, [ollama], 2 * MB, 2 * MB);
    expect(seconds).toBeCloseTo((60 * MB + 1300 * MB + 5 * GB) / (2 * MB));
    expect(queueSecondsLeft(ffmpeg, [ollama], 2 * MB, null)).toBeNull();
  });
});

describe("the time, in words", () => {
  it("moves in steps that grow with it, so it does not flicker", () => {
    expect(timePhrase(40)).toBe("less than a minute");
    expect(timePhrase(7.4 * 60)).toBe("about 7 min");
    expect(timePhrase(23 * 60)).toBe("about 25 min");
    expect(timePhrase(21 * 60)).toBe("about 20 min");
    expect(timePhrase(58 * 60)).toBe("about 1 h");
    expect(timePhrase(83 * 60)).toBe("about 1 h 20 min");
    expect(timePhrase(185 * 60)).toBe("about 3 h");
  });
});
