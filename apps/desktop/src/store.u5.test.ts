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

/** The store's `scheduleRefresh` debounce (REFRESH_DEBOUNCE_MS), mirrored
 * because it is not exported. It fires on the LEADING edge and arms a
 * trailing timer, and that timer is module state shared by every test in
 * this file — so a refresh armed by one test lands inside the next one. Both
 * `connected()` and the scoping assertion below wait past it rather than
 * racing it. */
const DEBOUNCE_MS = 150;
const settle = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 60));

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

// The seed hook installs itself at module load, and only when the preload
// bridge says the shell was launched for a rig. Set before the store is
// imported or `window.__localcutSeed` never exists, and the freeze the last
// test in this file asserts on would be unreachable from the suite entirely
// — which is how it came to be missing from three branches.
window.localcut.seedHookEnabled = true;

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
  // Drain any trailing refresh the previous test armed before this one
  // starts counting, or its arrival is charged to whatever runs next.
  await settle();
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

  it("keeps what a failure suggested, per node", async () => {
    // The engine computes these three codes at publish time and persists
    // nothing: they are not on the Job row and not on the board's NodeState,
    // which carries only `error`. If the store drops the event, the advice
    // is gone for good — and scheduler.py's own comment says "the UI renders
    // this as choices, not an error code".
    const send = await connected();
    send({
      type: "job.failed",
      job_id: "j1",
      node_id: "s1.clip",
      error: "out of memory after 2 fallback attempts",
      suggestions: ["lower_resolution", "smaller_model", "cloud"],
      project_id: "p1",
    } as EngineEvent);
    expect(useApp.getState().nodeFailures["s1.clip"]?.suggestions).toEqual([
      "lower_resolution",
      "smaller_model",
      "cloud",
    ]);
  });

  it("keeps the rung a retry dropped to", async () => {
    const send = await connected();
    send({
      type: "job.retrying",
      job_id: "j1",
      node_id: "s1.clip",
      attempt: 1,
      fallback: { resolution_scale: 0.75 },
      project_id: "p1",
    } as EngineEvent);
    expect(useApp.getState().nodeRetries["s1.clip"]).toEqual({
      attempt: 1,
      fallback: { resolution_scale: 0.75 },
    });
  });

  it("forgets both when the node starts over", async () => {
    // A new attempt makes the previous verdict stale. Left in place, the
    // node renders green while still carrying "out of memory" advice, and
    // the chips would act on a job that no longer exists.
    const send = await connected();
    send({
      type: "job.failed",
      job_id: "j1",
      node_id: "s1.clip",
      error: "out of memory",
      suggestions: ["lower_resolution"],
      project_id: "p1",
    } as EngineEvent);
    send({
      type: "job.retrying",
      job_id: "j1",
      node_id: "s1.clip",
      attempt: 1,
      fallback: { resolution_scale: 0.75 },
      project_id: "p1",
    } as EngineEvent);
    send({ type: "job.started", job_id: "j2", node_id: "s1.clip", project_id: "p1" } as EngineEvent);

    expect(useApp.getState().nodeFailures["s1.clip"]).toBeUndefined();
    expect(useApp.getState().nodeRetries["s1.clip"]).toBeUndefined();
  });

  it("forgets a retry once the job lands", async () => {
    const send = await connected();
    send({
      type: "job.retrying",
      job_id: "j1",
      node_id: "s1.clip",
      attempt: 2,
      fallback: { resolution_scale: 0.5, offload: "aggressive" },
      project_id: "p1",
    } as EngineEvent);
    send({
      type: "job.done",
      job_id: "j1",
      node_id: "s1.clip",
      artifact: "abc",
      project_id: "p1",
    } as EngineEvent);
    expect(useApp.getState().nodeRetries["s1.clip"]).toBeUndefined();
  });

  it("leaves a posed failure alone while the seed hook holds the app still", async () => {
    // The freeze is what lets a rig photograph a state the app cannot be
    // driven into, and `nodeFailures` is the whole reason U5 needed one: it
    // lives only on this websocket. But the rig's own engine renders a real
    // project with a real `s1.clip`, and that clip's `job.done` carries the
    // same node id as the pose — so the engine's traffic deleted the posed
    // failure out from under the frame being photographed, mid-gate.
    //
    // `refreshBoard` and the download bars already bail on the freeze; these
    // three branches are the ones that did not.
    const send = await connected();
    useApp.setState({
      nodeFailures: { "s1.clip": { error: "posed", suggestions: ["cloud"] } },
      nodeRetries: { "s1.clip": { attempt: 2, fallback: { resolution_scale: 0.5 } } },
    } as never);
    window.__localcutSeed?.({ freeze: true });

    send({
      type: "job.done",
      job_id: "real",
      node_id: "s1.clip",
      artifact: "abc",
      project_id: "p1",
    } as EngineEvent);
    send({
      type: "job.failed",
      job_id: "real",
      node_id: "s1.clip",
      error: "the engine's own news",
      project_id: "p1",
    } as EngineEvent);

    expect(useApp.getState().nodeFailures["s1.clip"]?.error).toBe("posed");
    expect(useApp.getState().nodeRetries["s1.clip"]?.attempt).toBe(2);
    window.__localcutSeed?.({ freeze: false });
  });

  it("still drops them when they belong to another project", async () => {
    // The scoping rule the whole dispatch depends on: node ids repeat across
    // projects, so an unscoped apply paints this board with another's news.
    const send = await connected();
    send({ type: "project.approved", project_id: "other", checkpoint: "script" } as EngineEvent);
    // Past the debounce, so a refresh this event wrongly triggered has had
    // its leading AND trailing edge to show up.
    await settle();
    expect(calls.getProject).toBe(0);
  });
});
