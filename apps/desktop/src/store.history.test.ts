import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "./store";

/** Undo/redo, take selection and add-scene: the store must send exactly the
 * wire shapes the engine's patch/history routes define, and refresh the
 * board afterwards so the UI redraws the restored state. */

const PROJECT = { id: "p1", title: "Project", created_at: 0, mode: "prompt", approvals: [] };

const HISTORY = (undo: number, redo: number) => ({
  undo_depth: undo,
  redo_depth: redo,
  undo_top: undo ? { kind: "patch", summary: null, node_id: null } : null,
  redo_top: redo ? { kind: "patch", summary: null, node_id: null } : null,
  savepoints: [],
});

function fakeClient(overrides: Record<string, unknown>) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({ project: PROJECT, board: { scenes: [], aux: {} } }),
    history: vi.fn().mockResolvedValue(HISTORY(0, 0)),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    openProjects: [],
    currentProject: null,
    board: null,
    history: null,
    jobs: [],
  });
});

describe("undo/redo", () => {
  it("undo lands the returned history and refreshes the board", async () => {
    const undo = vi.fn().mockResolvedValue(HISTORY(0, 1));
    // The board refresh re-reads /history; it must agree with what undo
    // returned, exactly as the real engine does.
    const client = fakeClient({ undo, history: vi.fn().mockResolvedValue(HISTORY(0, 1)) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any, history: HISTORY(1, 0) as any });

    const error = await useApp.getState().undoEdit();

    expect(error).toBeNull();
    expect(undo).toHaveBeenCalledWith("p1");
    expect(useApp.getState().history?.redo_depth).toBe(1);
    expect(client.getProject).toHaveBeenCalled(); // board redrawn
  });

  it("a refused undo returns the engine's message instead of throwing", async () => {
    const client = fakeClient({
      undo: vi.fn().mockRejectedValue(new Error("engine 409: nothing to undo")),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    const error = await useApp.getState().undoEdit();
    expect(error).toContain("nothing to undo");
  });
});

describe("selectTake", () => {
  it("sends a select_take op naming the recorded hash", async () => {
    const patch = vi.fn().mockResolvedValue({ dirty: ["s1.clip"] });
    const client = fakeClient({ patch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    const error = await useApp.getState().selectTake("s1.clip", "a".repeat(64));

    expect(error).toBeNull();
    expect(patch).toHaveBeenCalledWith("p1", [
      { op: "select_take", node_id: "s1.clip", take: "a".repeat(64) },
    ]);
  });
});

describe("addScene", () => {
  it("sends add_scene and selects the new scene's keyframe", async () => {
    const patch = vi.fn().mockResolvedValue({ dirty: ["s2.keyframe", "s2.clip", "timeline"] });
    const board = {
      scenes: [{ scene_id: "s1", keyframe: null, clip: { node_id: "s1.clip" }, narration: null }],
      aux: {},
    };
    const client = fakeClient({ patch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any, board: board as any });

    const error = await useApp.getState().addScene();

    expect(error).toBeNull();
    expect(patch).toHaveBeenCalledWith("p1", [{ op: "add_scene", node_id: "" }]);
    expect(useApp.getState().selectedNode).toBe("s2.keyframe");
  });
});

describe("removeScene", () => {
  it("sends remove_scene for the whole scene, not a node at a time", async () => {
    const patch = vi.fn().mockResolvedValue({ dirty: ["timeline"] });
    const client = fakeClient({ patch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    const error = await useApp.getState().removeScene("s2");

    expect(error).toBeNull();
    expect(patch).toHaveBeenCalledWith("p1", [{ op: "remove_scene", node_id: "s2" }]);
  });

  it("drops a selection that lived in the removed scene", async () => {
    const client = fakeClient({ patch: vi.fn().mockResolvedValue({ dirty: [] }) });
    useApp.setState({
      client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentProject: PROJECT as any,
      selectedNode: "s2.keyframe",
    });

    await useApp.getState().removeScene("s2");

    // Otherwise the Inspector stays open on a node that no longer exists.
    expect(useApp.getState().selectedNode).toBeNull();
  });

  it("keeps a selection that belongs to a different scene", async () => {
    const client = fakeClient({ patch: vi.fn().mockResolvedValue({ dirty: [] }) });
    useApp.setState({
      client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentProject: PROJECT as any,
      selectedNode: "s10.keyframe",
    });

    // Prefix matching on the id would take "s1" for "s10" — the scene id is
    // the segment before the dot, never a string the other starts with.
    await useApp.getState().removeScene("s1");

    expect(useApp.getState().selectedNode).toBe("s10.keyframe");
  });

  it("returns the engine's refusal rather than throwing", async () => {
    const patch = vi
      .fn()
      .mockRejectedValue(new Error("engine 422: s1 is the only scene left"));
    const client = fakeClient({ patch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    expect(await useApp.getState().removeScene("s1")).toContain("only scene left");
  });
});

describe("savepoints", () => {
  it("create and restore round-trip through the client", async () => {
    const withSavepoint = {
      ...HISTORY(0, 0),
      savepoints: [{ id: "sp1", label: "before", at: 1 }],
    };
    const createSavepoint = vi.fn().mockResolvedValue(withSavepoint);
    const restoreSavepoint = vi.fn().mockResolvedValue(HISTORY(1, 0));
    const client = fakeClient({
      createSavepoint,
      restoreSavepoint,
      history: vi.fn().mockResolvedValue(HISTORY(1, 0)),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    expect(await useApp.getState().createSavepoint("before")).toBeNull();
    expect(createSavepoint).toHaveBeenCalledWith("p1", "before");
    expect(useApp.getState().history?.savepoints).toHaveLength(1);

    expect(await useApp.getState().restoreSavepoint("sp1")).toBeNull();
    expect(restoreSavepoint).toHaveBeenCalledWith("p1", "sp1");
    expect(useApp.getState().history?.undo_depth).toBe(1);
  });

  it("a new save point survives a poll that was already in flight", async () => {
    // refreshHistory guarded only against ITSELF, so a read issued before
    // the create still satisfied its own generation check and painted the
    // pre-create list back on top. Nothing corrected it afterwards: creating
    // a save point publishes no event and triggers no board refresh, so the
    // dialog went on reading "No save points yet" for one that exists.
    const withSavepoint = {
      ...HISTORY(0, 0),
      savepoints: [{ id: "sp1", label: "before", at: 1 }],
    };
    let landStalePoll = (): void => {};
    const stale = new Promise((resolve) => {
      landStalePoll = () => resolve(HISTORY(0, 0));
    });
    const client = fakeClient({
      createSavepoint: vi.fn().mockResolvedValue(withSavepoint),
      history: vi.fn().mockReturnValue(stale),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useApp.setState({ client, currentProject: PROJECT as any });

    const polling = useApp.getState().refreshHistory(); // in flight, pre-create
    expect(await useApp.getState().createSavepoint("before")).toBeNull();
    landStalePoll(); // the engine's pre-create answer arrives late
    await polling;

    expect(useApp.getState().history?.savepoints).toHaveLength(1);
  });
});
