/**
 * A program the engine sets up or removes changes what will render: with
 * LocalCut's own FFmpeg gone, the timeline and the export have nothing to
 * assemble with. The readiness report Home and the workspace banner read is
 * the store's cached copy, so these events have to refetch it, the way a
 * finished model download already does.
 *
 * Driven through the real websocket path by mocking EngineClient and
 * capturing the subscriber, as store.progress.test.ts does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineEvent } from "./api/types";

type Subscriber = (event: EngineEvent) => void;

const captured = vi.hoisted(() => ({
  subscriber: null as Subscriber | null,
  readiness: vi.fn(),
}));

vi.mock("./api/client", () => ({
  EngineClient: class {
    baseUrl = "http://127.0.0.1:7830";
    subscribe(handler: Subscriber) {
      captured.subscriber = handler;
      return () => {};
    }
    listProjects = vi.fn().mockResolvedValue([]);
    listJobs = vi.fn().mockResolvedValue([]);
    readiness = captured.readiness;
    artifactUrl = () => "";
  },
}));

const { useApp } = await import("./store");

/** Connect the store so the websocket subscriber exists. */
async function connected() {
  captured.subscriber = null;
  window.localcut.getEngineConnection = vi.fn().mockResolvedValue({
    connection: { url: "http://127.0.0.1:7830", token: "t" },
    error: null,
    remote: false,
    remotePaired: false,
    keysArmed: true,
  });
  await useApp.getState().connect();
  expect(captured.subscriber).not.toBeNull();
  // Connecting fetches a report of its own; only what the event causes counts.
  captured.readiness.mockClear();
  return captured.subscriber!;
}

beforeEach(() => {
  useApp.setState({ client: null, currentProject: null } as never);
  captured.readiness.mockReset();
  captured.readiness.mockResolvedValue({ rows: [] });
});

describe("a program event", () => {
  it("refetches readiness when a setup finishes", async () => {
    const send = await connected();
    send({
      type: "program.setup.done",
      program: "ffmpeg",
      version: "n7.1",
      location: "programs/ffmpeg",
      in_use: true,
      draws_text: true,
    });
    await vi.waitFor(() => expect(captured.readiness).toHaveBeenCalled());
  });

  it("refetches readiness when a program is removed", async () => {
    const send = await connected();
    send({ type: "program.removed", program: "ffmpeg", freed_bytes: 180_000_000 });
    await vi.waitFor(() => expect(captured.readiness).toHaveBeenCalled());
  });
});
