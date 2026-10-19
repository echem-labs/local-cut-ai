/**
 * Counting models and program setups as one download on one line.
 *
 * The figures are the 2026-10-19 fresh install on a line doing about
 * 3.5 MB/s in all: 25 GB of models (SDXL, LTX, ACE-Step, Kokoro, Whisper)
 * started a minute after "Set up all three", whose FFmpeg, ComfyUI, Ollama
 * and qwen3:8b pull came to another 10.6 GB. Everything was in 2 h 54 min
 * after the first click.
 */
import { describe, expect, it } from "vitest";

import type { ModelRow, ProgramInfo, ProgramJob, ProgramsReport } from "../api/types";
import {
  inFlightBytes,
  lineArrival,
  lineSecondsLeft,
  lineSpeedOf,
  modelBytes,
  setupBytes,
  setupBytesLeft,
  setupsBytes,
  sharedSecondsLeft,
  type LineMeter,
} from "./downloads";

const MB = 1e6;
const GB = 1e9;

function model(id: string, size: number, over: Partial<ModelRow> = {}): ModelRow {
  return {
    id,
    size_bytes: size,
    downloaded: false,
    downloading: true,
    progress: null,
    partial_bytes: 0,
    ...over,
  } as ModelRow;
}

function program(
  id: ProgramInfo["id"],
  download: number,
  job: ProgramJob | null = null,
  pull: number | null = null,
): ProgramInfo {
  return {
    id,
    state: "missing",
    problem: "not_found",
    source: "default",
    location: "",
    setting: "",
    version: null,
    checks: id === "ollama" ? { server: null, model: "qwen3:8b", model_present: null } : {},
    managed: null,
    setup: {
      available: true,
      unavailable_reason: null,
      takes_effect: true,
      version: null,
      url: null,
      download_bytes: download,
      install_bytes: download,
      pull: pull === null ? null : { model: "qwen3:8b", bytes: pull },
      job,
      last: null,
    },
  };
}

const job = (phase: ProgramJob["phase"], done: number, total: number): ProgramJob => ({
  id: "j",
  phase,
  done,
  total,
  bytes_per_s: null,
});

const report = (programs: ProgramInfo[]): ProgramsReport => ({
  platform: "linux-x64",
  programs_dir: "/p",
  programs_bytes: 0,
  disk_free_bytes: 100 * GB,
  programs,
});

/** The run a minute in: FFmpeg done, ComfyUI downloading, Ollama next. */
const RUN = {
  models: [
    model("sdxl-base-1.0", 6.5 * GB),
    model("ltx-video-0.9-i2v", 11 * GB),
    model("ace-step-v1-3.5b", 7.2 * GB),
    model("kokoro-82m", 337 * MB),
    model("faster-whisper-base-en", 141 * MB),
  ],
  programs: report([
    program("ffmpeg", 131 * MB),
    program("comfyui", 3.87 * GB, job("downloading", 0, 3.87 * GB)),
    program("ollama", 1.44 * GB, null, 5.2 * GB),
  ]),
  queue: ["ollama"] as const,
  plans: { ffmpeg: 131 * MB, comfyui: 3.87 * GB, ollama: 1.44 * GB + 5.2 * GB },
};

describe("what a setup still has to fetch", () => {
  it("is the rest of the download and the model pulled after it", () => {
    const ollama = program("ollama", 1.44 * GB, job("downloading", 0.44 * GB, 1.44 * GB), 5.2 * GB);
    expect(setupBytesLeft(ollama, false)).toBe(1 * GB + 5.2 * GB);
  });

  it("is only the pull once the download is in and unpacking", () => {
    const ollama = program("ollama", 1.44 * GB, job("unpacking", 10, 20), 5.2 * GB);
    expect(setupBytesLeft(ollama, false)).toBe(5.2 * GB);
  });

  it("prices the pull at the catalog's size until Ollama names more", () => {
    const named = program("ollama", 1.44 * GB, job("pulling", 1 * GB, 2 * GB), 5 * GB);
    expect(setupBytesLeft(named, false)).toBe(4 * GB);
    const more = program("ollama", 1.44 * GB, job("pulling", 1 * GB, 5.2 * GB), 5 * GB);
    expect(setupBytesLeft(more, false)).toBe(4.2 * GB);
  });

  it("is all of it while the setup waits its turn, and nothing once it is not coming", () => {
    const ollama = program("ollama", 1.44 * GB, null, 5.2 * GB);
    expect(setupBytesLeft(ollama, true)).toBe(1.44 * GB + 5.2 * GB);
    expect(setupBytesLeft(ollama, false)).toBe(0);
  });
});

describe("a setup's place in the total", () => {
  it("stays in the total as all in once it has finished", () => {
    // FFmpeg's 131 MB came down first. Dropping it from both sides once it
    // was done would pull the bar backwards.
    expect(setupBytes(program("ffmpeg", 131 * MB), 131 * MB, false)).toEqual({
      done: 131 * MB,
      total: 131 * MB,
    });
  });

  it("counts a setup this window never started only while it runs", () => {
    expect(setupBytes(program("ffmpeg", 131 * MB), undefined, false)).toBeNull();
    const running = program("ffmpeg", 131 * MB, job("downloading", 31 * MB, 131 * MB));
    expect(setupBytes(running, undefined, false)).toEqual({ done: 31 * MB, total: 131 * MB });
  });
});

describe("the run's totals", () => {
  it("count the programs and the script model beside the models", () => {
    const models = RUN.models.reduce((sum, row) => sum + modelBytes(row).total, 0);
    const setups = setupsBytes(RUN.programs, RUN.queue, RUN.plans);
    // 25 GB of models, as the Ready step said, and 10.6 GB more it did not.
    expect(models / GB).toBeCloseTo(25.2, 1);
    expect(setups.total / GB).toBeCloseTo(10.6, 1);
    expect(setups.done).toBe(131 * MB);
  });

  it("would have said about 2 h 50 min at the line's 3.5 MB/s, against 2 h 54 min taken", () => {
    let meter: LineMeter | null = null;
    for (let second = 0; second <= 60; second += 0.5) {
      meter = lineArrival(meter, 1.75 * MB, second * 1000);
    }
    const left = inFlightBytes(RUN.models, RUN.programs, RUN.queue);
    const seconds = lineSecondsLeft(left.total - left.done, meter)!;
    expect(seconds / 60).toBeGreaterThan(165);
    expect(seconds / 60).toBeLessThan(175);
  });
});

describe("the line's speed", () => {
  it("is not said until the line has been watched for a few seconds", () => {
    // The first estimate is the one most likely to be wrong, and the one a
    // person plans around. Before there is a speed there is no time.
    let meter = lineArrival(null, 5 * MB, 0);
    expect(lineSpeedOf(meter)).toBeNull();
    meter = lineArrival(meter, 1.7 * MB, 500);
    expect(lineSpeedOf(meter)).toBeNull();
    for (let at = 1000; at <= 6000; at += 500) meter = lineArrival(meter, 1.7 * MB, at);
    expect(lineSpeedOf(meter)! / MB).toBeCloseTo(3.4, 1);
  });

  it("adds up every download arriving at once, not one share of the line", () => {
    // A model at 3 MB/s and a program at 0.5 MB/s, events interleaved.
    let meter: LineMeter | null = null;
    for (let at = 0; at <= 20_000; at += 500) {
      meter = lineArrival(meter, 1.5 * MB, at);
      meter = lineArrival(meter, 0.25 * MB, at + 250);
    }
    expect(lineSpeedOf(meter)! / MB).toBeCloseTo(3.5, 1);
  });

  it("starts over after the line has been quiet for a minute", () => {
    let meter: LineMeter | null = null;
    for (let at = 0; at <= 10_000; at += 500) meter = lineArrival(meter, 5 * MB, at);
    meter = lineArrival(meter, 0.1 * MB, 10_000 + 61_000);
    expect(lineSpeedOf(meter)).toBeNull();
  });
});

describe("a setup sharing the line", () => {
  const steady = () => {
    let meter: LineMeter | null = null;
    for (let at = 0; at <= 60_000; at += 500) meter = lineArrival(meter, 1.75 * MB, at);
    return meter;
  };

  it("takes no longer than everything in flight would at the line's speed", () => {
    // ComfyUI's 3.9 GB crawling at 0.1 MB/s beside the models reads as ten
    // hours, but the models end first and hand it the line.
    const own = (3.87 * GB) / (0.1 * MB);
    const everything = 30 * GB;
    expect(sharedSecondsLeft(own, everything, steady())! / 3600).toBeCloseTo(2.38, 1);
  });

  it("keeps its own time when it will be done before the rest", () => {
    expect(sharedSecondsLeft(600, 30 * GB, steady())).toBe(600);
  });

  it("says its own time, or the line's, when only one is known", () => {
    expect(sharedSecondsLeft(600, 30 * GB, null)).toBe(600);
    expect(sharedSecondsLeft(null, 3.5 * MB * 60, steady())).toBeCloseTo(60, 0);
    expect(sharedSecondsLeft(null, 30 * GB, null)).toBeNull();
  });
});
