/**
 * The three events the store received and did nothing with.
 *
 * `project.compiled`, `project.approved` and `project.asset` were all on the
 * wire — the engine publishes them from `service.py` — and two of them were
 * not even in the `EngineEvent` union, so TypeScript could not have told
 * anyone they were unhandled. The dispatch is a chain of `else if`s over
 * event types, and anything that reaches the end is dropped in silence.
 *
 * What that costs is a stale picture with nothing on screen to say so, and it
 * is worst in exactly the topology this app is built for: the CLI and the MCP
 * server are first-class clients of the same engine (see `automation.py`), so
 * an approval, an upload or a compile can land from another process while the
 * desktop is looking right at the project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineEvent } from "./api/types";

type Subscriber = (event: EngineEvent) => void;

const captured = vi.hoisted(() => ({ subscriber: null as Subscriber | null }));
const calls = vi.hoisted(() => ({ getProject: 0 }));

vi.mock("./api/client", () => ({
  EngineClient: class {
    baseUrl = "http://127.0.0.1:7830";
    subscribe(handler: Subscriber) {
      captured.subscriber = handler;
      return () => {};
    }
    getProject = vi.fn(async () => {
      calls.getProject += 1;
      return {
        project: { id: "p1", title: "t", mode: "auto", approvals: [] },
        board: { scenes: [], aux: {}, assembled_durations: {} },
      };
    });
    listProjects = vi.fn().mockResolvedValue([]);
    listJobs = vi.fn().mockResolvedValue([]);
    history = vi.fn().mockResolvedValue({ undo: 0, redo: 0, undo_label: null, redo_label: null });
    artifactUrl = () => "";
  },
}));

const { useApp } = await import("./store");

async function connected() {
  captured.subscriber = null;
  calls.getProject = 0;
  window.localcut.getEngineConnection = vi.fn().mockResolvedValue({
    connection: { url: "http://127.0.0.1:7830", token: "t" },
    error: null,
    remote: false,
    remotePaired: false,
    keysArmed: true,
  });
  await useApp.getState().connect();
  useApp.setState({
    currentProject: { id: "p1", title: "t", approvals: [] },
  } as never);
  expect(captured.subscriber).not.toBeNull();
  calls.getProject = 0;
  return captured.subscriber!;
}

beforeEach(() => {
  useApp.setState({ client: null, board: null, currentProject: null } as never);
});

describe("events that change the project from outside this window", () => {
  it("refreshes when a compile enqueues work", async () => {
    // `enqueued: 0` is the case that had nothing else to save it: no job
    // event follows a compile that queued nothing, so a re-plan that decided
    // the graph was already satisfied left the board showing whatever it had.
    const send = await connected();
    send({ type: "project.compiled", project_id: "p1", enqueued: 0 } as EngineEvent);
    await vi.waitFor(() => expect(calls.getProject).toBeGreaterThan(0));
  });

  it("refreshes when an approval lands", async () => {
    // `approvals` lives on the project meta and gates the next stage. Approve
    // from the CLI while the workspace is open and the gate stayed shut on
    // screen for a checkpoint the engine had already passed.
    const send = await connected();
    send({ type: "project.approved", project_id: "p1", checkpoint: "script" } as EngineEvent);
    await vi.waitFor(() => expect(calls.getProject).toBeGreaterThan(0));
  });

  it("refreshes when an asset is attached", async () => {
    // An upload adds a node AND its artifact in one move, so the board, the
    // graph and the canvas are all stale at once.
    const send = await connected();
    send({ type: "project.asset", project_id: "p1", node_id: "s1.keyframe" } as EngineEvent);
    await vi.waitFor(() => expect(calls.getProject).toBeGreaterThan(0));
  });

  it("still drops them when they belong to another project", async () => {
    // The scoping rule the whole dispatch depends on: node ids repeat across
    // projects, so an unscoped apply paints this board with another's news.
    const send = await connected();
    send({ type: "project.approved", project_id: "other", checkpoint: "script" } as EngineEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.getProject).toBe(0);
  });
});
