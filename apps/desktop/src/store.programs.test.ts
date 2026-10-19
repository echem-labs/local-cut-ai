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
  pullModel: null as unknown as Call,
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
      pullModel = (...args: unknown[]) => engine.pullModel(...args);
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
  engine.pullModel = vi
    .fn()
    .mockResolvedValue({ status: "started", job: "p1", model: "qwen3:8b" });
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

describe("a setup's speed", () => {
  const tick = (phase: "downloading" | "checking", done: number, bytes_per_s: number | null) => ({
    type: "program.setup.progress" as const,
    program: "ffmpeg" as const,
    phase,
    done,
    total: 130 * MB,
    bytes_per_s,
  });

  it("is averaged over the readings and kept for the downloads still to come", async () => {
    const send = await connected(report([running(10 * MB)]));
    const start = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      // Half a minute at 4 MB/s, then one reading of 100 KB/s.
      for (let at = 1; at <= 60; at++) {
        clock.mockReturnValue(start + at * 500);
        send(tick("downloading", 10 * MB + at * 2 * MB, 4 * MB));
      }
      clock.mockReturnValue(start + 61 * 500);
      send(tick("downloading", 130 * MB, 100 * 1024));
      const { speedOf } = await import("./lib/setupTime");
      const average = speedOf(useApp.getState().setupSpeeds.ffmpeg);
      expect(average).toBeGreaterThan(3.5 * MB);
      expect(useApp.getState().networkSpeed).toBe(average);
      // The engine's own reading is still what the job carries.
      expect(row().setup.job?.bytes_per_s).toBe(100 * 1024);

      // A phase that moves no bytes has no speed and leaves the download's.
      clock.mockReturnValue(start + 62 * 500);
      send(tick("checking", 0, null));
      expect(speedOf(useApp.getState().setupSpeeds.ffmpeg)).toBeNull();
      expect(useApp.getState().networkSpeed).toBe(average);

      send({
        type: "program.setup.done",
        program: "ffmpeg",
        version: "8.1.3",
        location: "/x/ffmpeg",
        in_use: true,
        draws_text: true,
      });
      expect(useApp.getState().setupSpeeds.ffmpeg).toBeUndefined();
      expect(useApp.getState().networkSpeed).toBe(average);
    } finally {
      clock.mockRestore();
    }
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

  it("asks for another build by name and counts that build's bytes", async () => {
    const GB = 2 ** 30;
    const comfyui: ProgramInfo = {
      ...ffmpeg(),
      id: "comfyui",
      location: "http://127.0.0.1:8188",
      setting: "LOCALCUT_COMFYUI_URL",
      checks: {},
      setup: {
        ...ffmpeg().setup,
        download_bytes: 2 * GB,
        install_bytes: 4 * GB,
        gpu: "nvidia",
        build: null,
        builds: [{ build: "older_drivers", download_bytes: GB, install_bytes: 5 * GB }],
      },
    };
    await connected(report([ffmpeg(), comfyui]));
    expect(await useApp.getState().setupProgram("comfyui", "older_drivers")).toBeNull();
    expect(engine.setupProgram).toHaveBeenCalledWith("comfyui", "older_drivers");
    const job = useApp.getState().programs!.programs.find((p) => p.id === "comfyui")!.setup.job;
    expect(job).toMatchObject({ total: GB, build: "older_drivers" });

    engine.setupProgram.mockRejectedValue(new EngineError(507, "engine 507: needs bytes"));
    const message = await useApp.getState().setupProgram("comfyui", "older_drivers");
    expect(message).toContain("6.0 GB");
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

  it("keeps the next one waiting when a read from before its start lands late", async () => {
    // FFmpeg's `done` re-reads the programs. That read can still be on its
    // way when ComfyUI's setup starts, and it describes ComfyUI with no job.
    const send = await connected(
      report([ffmpeg(), big("comfyui", 1900 * MB), big("ollama", 2400 * MB)]),
    );
    engine.setupProgram.mockImplementation(async (id: unknown) => ({
      status: "started",
      job: `job-${String(id)}`,
    }));
    const all = useApp.getState().setupPrograms(["ffmpeg", "comfyui", "ollama"]);
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(1));

    let answerStale: (value: ProgramsReport) => void = () => {};
    engine.programs.mockImplementationOnce(
      () => new Promise<ProgramsReport>((resolve) => (answerStale = resolve)),
    );
    const ready = ffmpeg({ state: "ready", source: "managed", checks: { draws_text: true } });
    const comfyuiRunning = (): ProgramInfo => {
      const idle = big("comfyui", 1900 * MB);
      return {
        ...idle,
        setup: {
          ...idle.setup,
          job: {
            id: "job-comfyui",
            phase: "downloading",
            done: 0,
            total: 1900 * MB,
            bytes_per_s: null,
          },
        },
      };
    };
    engine.programs.mockResolvedValue(
      report([ready, comfyuiRunning(), big("ollama", 2400 * MB)]),
    );
    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "8.1.3",
      location: "/x/ffmpeg",
      in_use: true,
      draws_text: true,
    });
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(2));
    expect(engine.setupProgram).toHaveBeenLastCalledWith("comfyui");

    answerStale(report([ready, big("comfyui", 1900 * MB), big("ollama", 2400 * MB)]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const comfyui = useApp.getState().programs!.programs.find((p) => p.id === "comfyui")!;
    expect(comfyui.setup.job).toMatchObject({ id: "job-comfyui" });
    expect(engine.setupProgram).toHaveBeenCalledTimes(2);
    expect(useApp.getState().programQueue).toEqual(["ollama"]);
    expect(row().state).toBe("ready");

    send({ type: "program.setup.cancelled", program: "comfyui" });
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledTimes(3));
    expect(engine.setupProgram).toHaveBeenLastCalledWith("ollama");
    send({ type: "program.setup.cancelled", program: "ollama" });
    expect(await all).toBeNull();
  });
});

/** An Ollama of the user's own, running without the script model. */
const ollamaWithout = (): ProgramInfo => ({
  ...ffmpeg({ id: "ollama" }),
  state: "ready",
  problem: null,
  source: "default",
  location: "http://127.0.0.1:11434/v1",
  checks: { server: "ollama", model: "qwen3:8b", model_present: false },
  setup: { ...ffmpeg().setup, takes_effect: false, pull: null },
});

const ollamaRow = () =>
  useApp.getState().programs!.programs.find((program) => program.id === "ollama")!;

describe("LocalCut's own server", () => {
  it("re-reads everything that says where scripts go when its copy starts or stops", async () => {
    const send = await connected(report([ffmpeg()]));
    const epoch = useApp.getState().readinessEpoch;
    send({ type: "program.server", program: "ollama", state: "starting", reason: null });
    await vi.waitFor(() => expect(engine.programs).toHaveBeenCalledTimes(1));
    // Starting changes nothing yet; running does.
    expect(engine.readiness).not.toHaveBeenCalled();
    send({ type: "program.server", program: "ollama", state: "running", reason: null });
    await vi.waitFor(() => expect(engine.readiness).toHaveBeenCalled());
    expect(engine.system).toHaveBeenCalled();
    expect(useApp.getState().readinessEpoch).toBe(epoch + 1);
  });

  it("puts a pull on the row with the click, and moves it with the events", async () => {
    const send = await connected(report([ffmpeg(), ollamaWithout()]));
    expect(await useApp.getState().pullModel("ollama", "qwen3:8b")).toBeNull();
    expect(engine.pullModel).toHaveBeenCalledWith("ollama", "qwen3:8b");
    expect(ollamaRow().setup.job).toMatchObject({ id: "p1", phase: "pulling", done: 0 });
    send({
      type: "program.setup.progress",
      program: "ollama",
      phase: "pulling",
      done: 2048 * MB,
      total: 4096 * MB,
      bytes_per_s: 20 * MB,
    });
    expect(ollamaRow().setup.job).toMatchObject({ id: "p1", done: 2048 * MB, total: 4096 * MB });
  });

  it("pulls into a running Ollama while it sets FFmpeg up, as one button asked", async () => {
    const send = await connected(report([ffmpeg(), ollamaWithout()]));
    const all = useApp.getState().setupPrograms(["ffmpeg", "ollama"]);
    // The pull has no size the catalog knows, so it goes first.
    await vi.waitFor(() => expect(engine.pullModel).toHaveBeenCalledWith("ollama", "qwen3:8b"));
    expect(engine.setupProgram).not.toHaveBeenCalled();
    send({
      type: "program.setup.done",
      program: "ollama",
      version: null,
      location: "http://127.0.0.1:11434/v1",
      in_use: false,
      draws_text: null,
      model: "qwen3:8b",
    });
    await vi.waitFor(() => expect(engine.setupProgram).toHaveBeenCalledWith("ffmpeg"));
    send({ type: "program.setup.cancelled", program: "ffmpeg" });
    expect(await all).toBeNull();
  });
});
