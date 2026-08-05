/**
 * U4's store surface: adding a node.
 *
 * `add_node` has existed engine-side since Phase 1 with no UI at all, which
 * is why the canvas's delete dialog could honestly say nothing could add one
 * back. This is the op reaching the engine in the shape it validates —
 * generated id, empty params, unwired — and the selection landing on the new
 * node so Details opens on the thing that was just made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "./i18n";
import { useApp } from "./store";

const PROJECT = { id: "p1", title: "Bee documentary", created_at: 0, updated_at: 0, mode: "prompt" };

const GRAPH = {
  nodes: {
    script: {
      id: "script",
      kind: "script",
      params: {},
      seed: 0,
      model: null,
      pinned: false,
      frozen_hash: null,
    },
  },
  edges: [],
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({ project: PROJECT, board: { scenes: [], aux: {} } }),
    history: vi.fn().mockResolvedValue({ undo: 0, redo: 0, save_points: [] }),
    graph: vi.fn().mockResolvedValue(GRAPH),
    patch: vi.fn().mockResolvedValue({ dirty: [] }),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  useApp.setState({
    client: fakeClient(),
    currentProject: PROJECT,
    graph: GRAPH,
    selectedNode: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

describe("addNode", () => {
  it("sends one add_node op with a free id, empty params and no wires", async () => {
    const patch = vi.fn().mockResolvedValue({ dirty: [] });
    useApp.setState({ client: fakeClient({ patch }) } as never);

    const error = await useApp.getState().addNode("keyframe");

    expect(error).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
    const [projectId, ops] = patch.mock.calls[0];
    expect(projectId).toBe("p1");
    expect(ops).toEqual([
      {
        op: "add_node",
        node_id: "keyframe-1",
        node: {
          id: "keyframe-1",
          kind: "keyframe",
          params: {},
          seed: 0,
          model: null,
          pinned: false,
          frozen_hash: null,
        },
      },
    ]);
  });

  it("selects the new node, so Details opens on what was just added", async () => {
    await useApp.getState().addNode("music");
    expect(useApp.getState().selectedNode).toBe("music-1");
  });

  it("leaves the selection alone when the engine refuses", async () => {
    useApp.setState({
      client: fakeClient({ patch: vi.fn().mockRejectedValue(new Error("graph is locked")) }),
      selectedNode: "script",
    } as never);

    const error = await useApp.getState().addNode("clip");

    expect(error).toBe("graph is locked");
    // Selecting a node the graph never got would open Details on nothing.
    expect(useApp.getState().selectedNode).toBe("script");
  });

  it("reports rather than throws when there is no engine", async () => {
    useApp.setState({ client: null } as never);
    expect(await useApp.getState().addNode("clip")).toBe(t("errors.engineUnavailable"));
  });
});
