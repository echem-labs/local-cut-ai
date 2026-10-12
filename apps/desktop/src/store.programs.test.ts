/**
 * A program setup, as the store hears it.
 *
 * The POST only starts it; everything after arrives over /ws as
 * `program.setup.*` events, the way model downloads do. What has to hold:
 * the running state follows the events, an outcome is kept with its
 * reason, and the end of a setup refetches what it changed (readiness, and
 * the engine's own ffmpeg facts) so the warnings it fixed clear without a
 * restart.
 *
 * Driven through the real websocket path by mocking EngineClient and
 * capturing the subscriber, as store.progress.test.ts does.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { EngineEvent, ReadinessRow } from "./api/types";
import { t } from "./i18n";

type Subscriber = (event: EngineEvent) => void;
type Call = Mock<(...args: unknown[]) => unknown>;

// Swapped per test in beforeEach; the mocked client below forwards to
// whichever is current, since vi.mock's factory runs once per file.
const engine = vi.hoisted(() => ({
  subscriber: null as Subscriber | null,
  readiness: null as unknown as Call,
  system: null as unknown as Call,
  startProgramSetup: null as unknown as Call,
  cancelProgramSetup: null as unknown as Call,
}));

vi.mock("./api/client", () => ({
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
    health = vi.fn().mockResolvedValue({ ok: true, engine_version: "x", api_version: 1 });
    readiness = (...args: unknown[]) => engine.readiness(...args);
    system = (...args: unknown[]) => engine.system(...args);
    startProgramSetup = (...args: unknown[]) => engine.startProgramSetup(...args);
    cancelProgramSetup = (...args: unknown[]) => engine.cancelProgramSetup(...args);
    artifactUrl = () => "";
  },
  EngineTimeoutError: class extends Error {},
}));

const { useApp } = await import("./store");

const noFfmpeg: ReadinessRow = {
  kind: "export",
  model: null,
  backend: null,
  verdict: "will_fail",
  reason: "no_ffmpeg",
  data: {},
  fix: { type: "setup_program", program: "ffmpeg", size_bytes: 170_611_883 },
};

const SYSTEM = { backend_mode: "local", ffmpeg_drawtext: null };

async function connected(): Promise<Subscriber> {
  engine.subscriber = null;
  window.localcut.getEngineConnection = vi.fn().mockResolvedValue({
    connection: { url: "http://127.0.0.1:7830", token: "t" },
    error: null,
    remote: false,
    remotePaired: false,
    keysArmed: true,
  });
  await useApp.getState().connect();
  expect(engine.subscriber).not.toBeNull();
  return engine.subscriber!;
}

beforeEach(() => {
  engine.readiness = vi.fn().mockResolvedValue({ rows: [noFfmpeg] });
  engine.system = vi.fn().mockResolvedValue(SYSTEM);
  engine.startProgramSetup = vi.fn().mockResolvedValue({ status: "started", job: "3f9c2a7d1e04" });
  engine.cancelProgramSetup = vi.fn().mockResolvedValue({ ok: true });
  useApp.setState({
    client: null,
    currentProject: null,
    readiness: null,
    system: null,
    programSetups: {},
  } as never);
});

describe("program setup events", () => {
  it("follow a running setup's phase, bytes and speed", async () => {
    const send = await connected();
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "downloading",
      done: 68_157_440,
      total: 170_611_883,
      bytes_per_s: 3_407_872,
    });
    expect(useApp.getState().programSetups.ffmpeg).toEqual({
      status: "running",
      phase: "downloading",
      done: 68_157_440,
      total: 170_611_883,
      bytesPerS: 3_407_872,
    });
  });

  it("refetch readiness and the engine's ffmpeg facts when it lands", async () => {
    // The fix for the machine this was found on: with LocalCut's copy in
    // place, timeline and export turned ready without an engine restart.
    // The banner reads readiness, and the drawtext warnings read /system,
    // so both have to be asked again or the warnings outlive the problem.
    const send = await connected();
    await vi.waitFor(() => expect(useApp.getState().readiness).toEqual([noFfmpeg]));
    engine.readiness.mockResolvedValue({ rows: [] });
    engine.system.mockResolvedValue({ ...SYSTEM, ffmpeg_drawtext: true });

    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "8.1.3",
      location: "C:/data/programs/ffmpeg/ffmpeg.exe",
      in_use: true,
      draws_text: true,
    });

    expect(useApp.getState().programSetups.ffmpeg).toEqual({
      status: "done",
      version: "8.1.3",
      drawsText: true,
    });
    await vi.waitFor(() => expect(useApp.getState().readiness).toEqual([]));
    await vi.waitFor(() =>
      expect((useApp.getState().system as { ffmpeg_drawtext: boolean }).ffmpeg_drawtext).toBe(
        true,
      ),
    );
  });

  it("keep a failure's reason", async () => {
    const send = await connected();
    send({
      type: "program.setup.failed",
      program: "ffmpeg",
      reason: "download_failed",
      error: "connection reset",
    });
    expect(useApp.getState().programSetups.ffmpeg).toEqual({
      status: "failed",
      reason: "download_failed",
      error: "connection reset",
    });
  });

  it("forget a cancelled setup, so the offer comes back as it was", async () => {
    const send = await connected();
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "unpacking",
      done: 1,
      total: 2,
      bytes_per_s: null,
    });
    expect(useApp.getState().programSetups.ffmpeg).toMatchObject({ status: "running" });
    send({ type: "program.setup.cancelled", program: "ffmpeg" });
    expect(useApp.getState().programSetups.ffmpeg).toBeUndefined();
  });

  it("forget LocalCut's copy once it is removed, and ask readiness again", async () => {
    const send = await connected();
    await vi.waitFor(() => expect(engine.readiness).toHaveBeenCalledTimes(1));
    useApp.setState({
      programSetups: { ffmpeg: { status: "done", version: "8.1.3", drawsText: true } },
    } as never);
    send({ type: "program.removed", program: "ffmpeg", freed_bytes: 283_956_127 });
    expect(useApp.getState().programSetups.ffmpeg).toBeUndefined();
    await vi.waitFor(() => expect(engine.readiness).toHaveBeenCalledTimes(2));
  });
});

describe("starting and cancelling a setup", () => {
  it("POSTs, reports success as null, and shows it starting", async () => {
    await connected();
    expect(await useApp.getState().startProgramSetup("ffmpeg")).toBeNull();
    expect(engine.startProgramSetup).toHaveBeenCalledWith("ffmpeg");
    expect(useApp.getState().programSetups.ffmpeg).toMatchObject({
      status: "running",
      phase: null,
    });
  });

  it("does not wind back a progress tick that beat the POST's answer", async () => {
    // The task starts before the route returns, so the first event can
    // arrive over the socket before the HTTP response does.
    const send = await connected();
    let answer: (value: unknown) => void = () => {};
    engine.startProgramSetup.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const started = useApp.getState().startProgramSetup("ffmpeg");
    send({
      type: "program.setup.progress",
      program: "ffmpeg",
      phase: "downloading",
      done: 1_048_576,
      total: 170_611_883,
      bytes_per_s: null,
    });
    answer({ status: "started", job: "3f9c2a7d1e04" });
    await started;
    expect(useApp.getState().programSetups.ffmpeg).toMatchObject({
      phase: "downloading",
      done: 1_048_576,
    });
  });

  it("returns the engine's refusal, and starts nothing", async () => {
    await connected();
    engine.startProgramSetup.mockRejectedValue(
      new Error("engine 409: ffmpeg is already being set up"),
    );
    expect(await useApp.getState().startProgramSetup("ffmpeg")).toBe(
      "engine 409: ffmpeg is already being set up",
    );
    expect(useApp.getState().programSetups.ffmpeg).toBeUndefined();
  });

  it("treats a copy that is already in place as done, and asks readiness again", async () => {
    await connected();
    await vi.waitFor(() => expect(engine.readiness).toHaveBeenCalledTimes(1));
    engine.startProgramSetup.mockResolvedValue({ status: "installed" });
    expect(await useApp.getState().startProgramSetup("ffmpeg")).toBeNull();
    expect(useApp.getState().programSetups.ffmpeg).toMatchObject({ status: "done" });
    await vi.waitFor(() => expect(engine.readiness).toHaveBeenCalledTimes(2));
  });

  it("says there is no engine rather than reporting success", async () => {
    expect(await useApp.getState().startProgramSetup("ffmpeg")).toBe(
      t("errors.engineUnavailable"),
    );
    expect(await useApp.getState().cancelProgramSetup("ffmpeg")).toBe(
      t("errors.engineUnavailable"),
    );
  });

  it("cancels with a DELETE, and returns a refusal", async () => {
    await connected();
    expect(await useApp.getState().cancelProgramSetup("ffmpeg")).toBeNull();
    expect(engine.cancelProgramSetup).toHaveBeenCalledWith("ffmpeg");
    engine.cancelProgramSetup.mockRejectedValue(
      new Error("engine 409: ffmpeg is being moved into place and will finish"),
    );
    expect(await useApp.getState().cancelProgramSetup("ffmpeg")).toBe(
      "engine 409: ffmpeg is being moved into place and will finish",
    );
  });
});
