/**
 * Live progress patched into the board in place, with no HTTP refetch.
 *
 * The patch runs on every `job.progress` tick — several per second during a
 * render — so anything it drops from the board is gone for the whole render
 * and comes back only on the debounced refetch, which the next tick undoes
 * again. That made it a uniquely bad place to rebuild the object field by
 * field: `assembled_durations` was not in the list, and every duration the UI
 * shows reads through it.
 *
 * Driven through the real websocket path (the patch is a closure inside the
 * store factory) by mocking EngineClient and capturing the subscriber.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, EngineEvent, NodeState } from "./api/types";

type Subscriber = (event: EngineEvent) => void;

const captured = vi.hoisted(() => ({ subscriber: null as Subscriber | null }));

vi.mock("./api/client", () => ({
  EngineClient: class {
    baseUrl = "http://127.0.0.1:7830";
    subscribe(handler: Subscriber) {
      captured.subscriber = handler;
      return () => {};
    }
    listProjects = vi.fn().mockResolvedValue([]);
    listJobs = vi.fn().mockResolvedValue([]);
    artifactUrl = () => "";
  },
}));

const { useApp } = await import("./store");

const node = (id: string, progress = 0): NodeState => ({
  node_id: id,
  status: "rendering",
  progress,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const BOARD: Board = {
  scenes: [
    {
      scene_id: "s1",
      keyframe: node("s1.keyframe"),
      clip: node("s1.clip"),
      narration: node("s1.narration"),
      clip_takes: [node("s1.clip2"), null],
    },
  ],
  aux: { timeline: node("timeline") },
  // The field the rebuild dropped: the per-scene seconds of the ASSEMBLED
  // cut, which every duration in the UI reads through lib/order.ts.
  assembled_durations: { s1: 65.4 },
};

/** Connect the store so the websocket subscriber exists, then seed a board. */
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
  useApp.setState({
    board: BOARD,
    currentProject: { id: "p1", title: "t", approvals: [] },
  } as never);
  expect(captured.subscriber).not.toBeNull();
  return captured.subscriber!;
}

const tick = (send: Subscriber, nodeId: string, progress: number) =>
  send({
    type: "job.progress",
    job_id: "j1",
    node_id: nodeId,
    progress,
    project_id: "p1",
  } as EngineEvent);

beforeEach(() => {
  useApp.setState({ client: null, board: null, currentProject: null } as never);
});

describe("a progress tick", () => {
  it("keeps the assembled durations", async () => {
    // The regression: a 65s cut silently reverted to the planned per-clip sum
    // on the first tick, moving the timeline strip, the monitor clock, the
    // playhead and every seek — then back again on the next refetch.
    const send = await connected();
    tick(send, "s1.clip", 0.5);

    expect(useApp.getState().board?.assembled_durations).toEqual({ s1: 65.4 });
  });

  it("still applies the progress it was sent", async () => {
    const send = await connected();
    tick(send, "s1.clip", 0.5);

    expect(useApp.getState().board?.scenes[0]!.clip.progress).toBe(0.5);
  });

  it("moves a split scene's takes, not just its first clip", async () => {
    // Sequential takes render like any other node; without this their rings
    // only moved on the debounced refetch.
    const send = await connected();
    tick(send, "s1.clip2", 0.75);

    const takes = useApp.getState().board?.scenes[0]!.clip_takes;
    expect(takes?.[0]?.progress).toBe(0.75);
    expect(takes?.[1]).toBeNull(); // a missing take stays missing
  });

  it("moves an aux node", async () => {
    const send = await connected();
    tick(send, "timeline", 0.25);

    expect(useApp.getState().board?.aux.timeline!.progress).toBe(0.25);
  });

  it("leaves other nodes alone", async () => {
    const send = await connected();
    tick(send, "s1.clip", 0.5);

    const scene = useApp.getState().board!.scenes[0]!;
    expect(scene.keyframe!.progress).toBe(0);
    expect(scene.narration!.progress).toBe(0);
  });

  it("ignores an event for a project that is not on screen", async () => {
    // The websocket is a global stream and node ids repeat across projects,
    // so an unscoped apply would patch this board with another's progress.
    const send = await connected();
    send({
      type: "job.progress",
      job_id: "j1",
      node_id: "s1.clip",
      progress: 0.9,
      project_id: "another-project",
    } as EngineEvent);

    expect(useApp.getState().board?.scenes[0]!.clip.progress).toBe(0);
  });

  it("still moves the engine-wide job list for an off-screen project", async () => {
    // Job ids are engine-global, so the scope guard that protects the board
    // must not starve `allJobs`: the queue tray reads it, and without this
    // an off-project render ring froze at whatever the last refetch saw.
    const send = await connected();
    useApp.setState({
      allJobs: [
        { id: "j-other", project_id: "another-project", status: "rendering", progress: 0.1 },
        { id: "j-mine", project_id: "p1", status: "rendering", progress: 0.2 },
      ],
    } as never);
    send({
      type: "job.progress",
      job_id: "j-other",
      node_id: "s1.clip",
      progress: 0.9,
      project_id: "another-project",
    } as EngineEvent);

    const all = useApp.getState().allJobs;
    expect(all.find((job) => job.id === "j-other")?.progress).toBe(0.9);
    expect(all.find((job) => job.id === "j-mine")?.progress).toBe(0.2);
  });

  it("keeps the engine-wide list in step for the on-screen project too", async () => {
    const send = await connected();
    useApp.setState({
      allJobs: [{ id: "j1", project_id: "p1", status: "rendering", progress: 0 }],
    } as never);
    tick(send, "s1.clip", 0.5);

    expect(useApp.getState().allJobs[0]?.progress).toBe(0.5);
  });
});
