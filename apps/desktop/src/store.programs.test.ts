/**
 * Program setups as the store sees them: a job that moves with the /ws
 * progress events, an outcome that lands from the event itself, and the
 * re-reads a setup that changed the machine has to cause.
 *
 * The refetches are the point. /system is read once per connection and the
 * readiness report only on model events, so without them a freshly set up
 * FFmpeg left the gate, the banner and Settings saying it was missing until
 * the app reconnected.
 *
 * Driven through the real websocket path by mocking EngineClient and
 * capturing the subscriber, like store.progress.test.ts.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { EngineEvent, ProgramInfo, ProgramsReport } from "./api/types";

type Subscriber = (event: EngineEvent) => void;
type Call = Mock<(...args: unknown[]) => Promise<unknown>>;

const engine = vi.hoisted(() => ({
  subscriber: null as Subscriber | null,
  programs: null as unknown as Call,
  system: null as unknown as Call,
  readiness: null as unknown as Call,
  setupProgram: null as unknown as Call,
  removeProgram: null as unknown as Call,
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    EngineClient: class {
      baseUrl = "http://127.0.0.1:7830";
      subscribe(handler: Subscriber) {
        engine.subscriber = handler;
        return () => {};
      }
      listProjects = vi.fn().mockResolvedValue([]);
      listJobs = vi.fn().mockResolvedValue([]);
      listModels = vi.fn().mockResolvedValue([]);
      systemEtas = vi.fn().mockResolvedValue({ etas: {} });
      health = vi.fn().mockResolvedValue({ engine_version: "0", api_version: 1 });
      projectReadiness = vi.fn().mockResolvedValue({ rows: [] });
      programs = (...args: unknown[]) => engine.programs(...args);
      system = (...args: unknown[]) => engine.system(...args);
      readiness = (...args: unknown[]) => engine.readiness(...args);
      setupProgram = (...args: unknown[]) => engine.setupProgram(...args);
      removeProgram = (...args: unknown[]) => engine.removeProgram(...args);
      cancelProgramSetup = vi.fn().mockResolvedValue({ ok: true });
    },
  };
});

const { useApp } = await import("./store");
const { EngineError } = await import("./api/client");

const MB = 2 ** 20;

function ffmpeg(over: Partial<ProgramInfo> = {}): ProgramInfo {
  return {
    id: "ffmpeg",
    state: "missing",
    problem: "not_found",
    source: "path",
    location: "ffmpeg",
    setting: "LOCALCUT_FFMPEG_BIN",
    version: null,
    checks: { draws_text: null },
    managed: null,
    setup: {
      available: true,
      unavailable_reason: null,
      takes_effect: true,
      version: "8.1.3",
      url: "https://example.test/ffmpeg.tar.xz",
      download_bytes: 130 * MB,
      install_bytes: 270 * MB,
      job: null,
      last: null,
    },
    ...over,
  };
}

const report = (rows: ProgramInfo[]): ProgramsReport => ({
  platform: "linux-x64",
  programs_dir: "/home/me/.localcut/programs",
  programs_bytes: 0,
  disk_free_bytes: 10_000 * MB,
  programs: rows,
});

const running = (done: number) =>
  ffmpeg({
    setup: {
      ...ffmpeg().setup,
      job: { id: "j1", phase: "downloading", done, total: 130 * MB, bytes_per_s: 4 * MB },
    },
  });

/** Connect, let the connection's own reads settle, then clear the counts so
 * a test sees only what its events caused. */
async function connected(initial: ProgramsReport) {
  engine.subscriber = null;
  engine.programs = vi.fn().mockResolvedValue(initial);
  engine.system = vi
    .fn()
    .mockResolvedValue({ hardware: {}, recommendations: [], backend_mode: "local" });
  engine.readiness = vi.fn().mockResolvedValue({ rows: [] });
  engine.setupProgram = vi.fn().mockResolvedValue({ status: "started", job: "j1" });
  engine.removeProgram = vi.fn().mockResolvedValue({ ok: true, freed_bytes: 270 * MB });
  window.localcut.getEngineConnection = vi.fn().mockResolvedValue({
    connection: { url: "http://127.0.0.1:7830", token: "t" },
    error: null,
    remote: false,
    remotePaired: false,
    keysArmed: true,
  });
  await useApp.getState().connect();
  await vi.waitFor(() => expect(useApp.getState().programs).not.toBeNull());
  engine.programs.mockClear();
  engine.system.mockClear();
  engine.readiness.mockClear();
  expect(engine.subscriber).not.toBeNull();
  return engine.subscriber!;
}

const row = () => useApp.getState().programs!.programs.find((program) => program.id === "ffmpeg")!;

beforeEach(() => {
  useApp.setState({ client: null, programs: null, programsError: null } as never);
});

describe("a setup's progress", () => {
  it("moves the job in place, without asking the engine again", async () => {
    const send = await connected(report([running(10 * MB)]));
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "downloading",
      done: 68 * MB,
      total: 130 * MB,
      bytes_per_s: 3 * MB,
    });
    expect(row().setup.job).toEqual({
      id: "j1",
      phase: "downloading",
      done: 68 * MB,
      total: 130 * MB,
      bytes_per_s: 3 * MB,
    });
    expect(engine.programs).not.toHaveBeenCalled();
  });

  it("follows the phases as each is announced", async () => {
    const send = await connected(report([running(130 * MB)]));
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "checking",
      done: 0,
      total: 0,
      bytes_per_s: null,
    });
    expect(row().setup.job?.phase).toBe("checking");
  });

  it("reads the rest of a setup something else started", async () => {
    // The CLI on a GPU box, or a second window: the first this app hears of
    // it is a tick for a row with no job.
    const send = await connected(report([ffmpeg()]));
    engine.programs.mockResolvedValue(report([running(5 * MB)]));
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "downloading",
      done: 5 * MB,
      total: 130 * MB,
      bytes_per_s: null,
    });
    expect(row().setup.job?.done).toBe(5 * MB);
    await vi.waitFor(() => expect(engine.programs).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(row().setup.job?.id).toBe("j1"));
  });
});

describe("a setup that ends", () => {
  it("re-reads the programs, /system and readiness once FFmpeg is set up", async () => {
    const send = await connected(report([running(130 * MB)]));
    const managed = ffmpeg({
      state: "ready",
      problem: null,
      source: "managed",
      version: "8.1.3",
      checks: { draws_text: true },
    });
    engine.programs.mockResolvedValue(report([managed]));
    const epoch = useApp.getState().readinessEpoch;

    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "8.1.3",
      location: "/home/me/.localcut/programs/ffmpeg/ffmpeg",
      in_use: true,
      draws_text: true,
    });

    // The bar goes with the event, before any read comes back.
    expect(row().setup.job).toBeNull();
    expect(row().setup.last?.outcome).toBe("done");
    expect(useApp.getState().readinessEpoch).toBe(epoch + 1);
    await vi.waitFor(() => expect(engine.programs).toHaveBeenCalled());
    expect(engine.system).toHaveBeenCalled();
    expect(engine.readiness).toHaveBeenCalled();
    await vi.waitFor(() => expect(row().state).toBe("ready"));
  });

  it("does the same when LocalCut's copy is removed", async () => {
    const send = await connected(report([ffmpeg({ state: "ready", source: "managed" })]));
    engine.programs.mockResolvedValue(report([ffmpeg()]));
    send({ type: "program.removed", program: "ffmpeg", freed_bytes: 270 * MB });
    await vi.waitFor(() => expect(engine.programs).toHaveBeenCalled());
    expect(engine.system).toHaveBeenCalled();
    expect(engine.readiness).toHaveBeenCalled();
    await vi.waitFor(() => expect(row().state).toBe("missing"));
  });

  it("keeps why a failed setup stopped, and re-reads only the programs", async () => {
    const send = await connected(report([running(40 * MB)]));
    send({
      type: "program.setup.failed",
      program: "ffmpeg",
      reason: "checksum_mismatch",
      error: "the download's SHA-256 is abc",
    });
    expect(row().setup.job).toBeNull();
    expect(row().setup.last).toEqual({
      job: "j1",
      outcome: "failed",
      reason: "checksum_mismatch",
      error: "the download's SHA-256 is abc",
    });
    await vi.waitFor(() => expect(engine.programs).toHaveBeenCalled());
    // Nothing on the machine changed, so nothing that describes it is asked.
    expect(engine.system).not.toHaveBeenCalled();
  });

  it("drops a read that left before the setup ended", async () => {
    // The read that started a beat before `done` describes the setup as
    // still running. Landing after the event, it would put the bar back up
    // for a program that is already in place.
    const send = await connected(report([running(100 * MB)]));
    let answerStale: (value: ProgramsReport) => void = () => {};
    engine.programs.mockImplementationOnce(
      () => new Promise<ProgramsReport>((resolve) => (answerStale = resolve)),
    );
    const stale = useApp.getState().refreshPrograms();
    const ready = ffmpeg({ state: "ready", source: "managed", checks: { draws_text: true } });
    engine.programs.mockResolvedValue(report([ready]));
    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "8.1.3",
      location: "/x/ffmpeg",
      in_use: true,
      draws_text: true,
    });
    await vi.waitFor(() => expect(row().state).toBe("ready"));
    answerStale(report([running(110 * MB)]));
    await stale;
    expect(row().setup.job).toBeNull();
    expect(row().state).toBe("ready");
  });
});

describe("starting a setup", () => {
  it("puts the job on the row with the click", async () => {
    await connected(report([ffmpeg()]));
    expect(await useApp.getState().setupProgram("ffmpeg")).toBeNull();
    expect(engine.setupProgram).toHaveBeenCalledWith("ffmpeg");
    expect(row().setup.job).toMatchObject({ id: "j1", phase: "downloading", done: 0 });
  });

  it("says how much room it needs when the disk cannot hold it", async () => {
    await connected(report([ffmpeg()]));
    engine.setupProgram.mockRejectedValue(new EngineError(507, "engine 507: needs bytes"));
    const message = await useApp.getState().setupProgram("ffmpeg");
    // Download and unpacked copy at once: 130 MB + 270 MB, in the app's
    // own units rather than the engine's byte count.
    expect(message).toContain("400 MB");
    expect(message).toContain("/home/me/.localcut/programs");
    expect(message).not.toContain("engine 507");
  });

  it("takes a setup already running elsewhere as the answer, not a refusal", async () => {
    await connected(report([ffmpeg()]));
    engine.setupProgram.mockRejectedValue(new EngineError(409, "engine 409: already being set up"));
    engine.programs.mockResolvedValue(report([running(20 * MB)]));
    expect(await useApp.getState().setupProgram("ffmpeg")).toBeNull();
    expect(row().setup.job?.done).toBe(20 * MB);
  });
});

describe("setting up several at once", () => {
  const big = (id: "ollama" | "comfyui", size: number): ProgramInfo => ({
    ...ffmpeg({ id }),
    setup: { ...ffmpeg().setup, download_bytes: size },
  });

  it("runs them one at a time, smallest first, and keeps the rest queued", async () => {
    const send = await connected(
      report([ffmpeg(), big("comfyui", 1900 * MB), big("ollama", 1400 * MB)]),
    );
    engine.setupProgram.mockImplementation(async (id: unknown) => ({
      status: "started",
      job: `job-${String(id)}`,
    }));
    const all = useApp.getState().setupPrograms(["comfyui", "ollama", "ffmpeg"]);

    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(1));
    expect(engine.setupProgram).toHaveBeenLastCalledWith("ffmpeg");
    expect(useApp.getState().programQueue).toEqual(["ollama", "comfyui"]);

    // FFmpeg lands; Ollama, the next smallest, starts, and not before.
    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "8.1.3",
      location: "/x/ffmpeg",
      in_use: true,
      draws_text: true,
    });
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(2));
    expect(engine.setupProgram).toHaveBeenLastCalledWith("ollama");
    expect(useApp.getState().programQueue).toEqual(["comfyui"]);

    // One that fails does not stop the queue.
    send({ type: "program.setup.failed", program: "ollama", reason: "download_failed", error: "x" });
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(3));
    expect(engine.setupProgram).toHaveBeenLastCalledWith("comfyui");
    send({ type: "program.setup.cancelled", program: "comfyui" });
    expect(await all).toBeNull();
    expect(useApp.getState().programQueue).toEqual([]);
  });
});
