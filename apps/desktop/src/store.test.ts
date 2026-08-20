import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "./store";

/**
 * FE-3 and FE-5: two races that only exist because responses arrive in
 * whatever order the engine finishes them. Neither is visible by reading a
 * single function — you have to interleave two in-flight requests, which is
 * exactly what a test can do and a reviewer cannot.
 */

/** A promise plus the handle to settle it, so a test can hold a request
 * in flight and decide when (and in what order) it lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PROJECT = (id: string) => ({
  id,
  title: `Project ${id}`,
  created_at: 0,
  updated_at: 0,
  status: "draft",
});

/** Only the methods the paths under test call. Cast in: the real
 * EngineClient is a class with far more surface, and widening this stub to
 * match it would hide which calls actually matter here. */
function fakeClient(overrides: Record<string, unknown>) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn(),
    createProject: vi.fn(),
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
    jobs: [],
  });
});

describe("refreshHome tab prune (FE-3)", () => {
  it("closes tabs for projects that really are gone", async () => {
    const client = fakeClient({ listProjects: vi.fn().mockResolvedValue([PROJECT("keep")]) });
    useApp.setState({ client, openProjects: ["keep", "deleted-elsewhere"] });

    await useApp.getState().refreshHome();

    expect(useApp.getState().openProjects).toEqual(["keep"]);
  });

  it("does not close the tab of a project created during the request", async () => {
    // The snapshot this request returns predates the create, so the new id is
    // absent from it — but absent-from-the-list and deleted are not the same
    // thing, and the prune used to treat them as one.
    const listing = deferred<unknown[]>();
    // Only the FIRST request is held open. createFromPrompt runs its own
    // refreshHome afterwards, and handing that the same pending promise
    // would just deadlock the test rather than model anything.
    let call = 0;
    const client = fakeClient({
      listProjects: vi.fn().mockImplementation(() => {
        call += 1;
        return call === 1
          ? listing.promise
          : Promise.resolve([PROJECT("existing"), PROJECT("brand-new")]);
      }),
      createProject: vi.fn().mockResolvedValue(PROJECT("brand-new")),
      getProject: vi
        .fn()
        .mockResolvedValue({ project: PROJECT("brand-new"), board: { scenes: [], aux: {} } }),
    });
    useApp.setState({ client, openProjects: ["existing"] });

    const inFlight = useApp.getState().refreshHome();

    // The user creates a project while that list request is still open.
    await useApp.getState().createFromPrompt("a beehive", 60, "16:9", "prompt");
    expect(useApp.getState().openProjects).toContain("brand-new");

    // Now the stale snapshot lands, without the new project in it.
    listing.resolve([PROJECT("existing")]);
    await inFlight;

    expect(useApp.getState().openProjects).toContain("brand-new");
    expect(useApp.getState().openProjects).toContain("existing");
  });
});

describe("refreshBoard ordering (FE-5)", () => {
  it("lets a slow earlier response lose to the newer one that already landed", async () => {
    // scheduleRefresh fires on the leading edge and again on the trailing
    // one, so two refreshes for the SAME project are routinely in flight at
    // once. Without a sequence number the slower (earlier) one wins by
    // arriving last, and the board reverts to showing "rendering" for work
    // that had already finished.
    const slowFirst = deferred<unknown>();
    const fastSecond = deferred<unknown>();
    const responses = [slowFirst.promise, fastSecond.promise];

    const client = fakeClient({
      getProject: vi.fn().mockImplementation(() => responses.shift()),
      listJobs: vi.fn().mockResolvedValue([]),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    const first = useApp.getState().refreshBoard();
    const second = useApp.getState().refreshBoard();

    // The NEWER request finishes first and paints the finished board.
    fastSecond.resolve({
      project: PROJECT("p1"),
      board: { scenes: [], aux: {}, marker: "fresh" },
    });
    await second;
    expect((useApp.getState().board as { marker?: string })?.marker).toBe("fresh");

    // Then the older one finally lands, carrying the stale picture.
    slowFirst.resolve({
      project: PROJECT("p1"),
      board: { scenes: [], aux: {}, marker: "stale" },
    });
    await first;

    expect((useApp.getState().board as { marker?: string })?.marker).toBe("fresh");
  });

  it("drops a response for a project the user has since navigated away from", async () => {
    const pending = deferred<unknown>();
    const client = fakeClient({ getProject: vi.fn().mockReturnValue(pending.promise) });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    const inFlight = useApp.getState().refreshBoard();
    useApp.setState({ currentProject: PROJECT("p2") as never, board: null });

    pending.resolve({ project: PROJECT("p1"), board: { scenes: [], aux: {}, marker: "p1" } });
    await inFlight;

    expect(useApp.getState().board).toBeNull();
    expect(useApp.getState().currentProject?.id).toBe("p2");
  });
});

describe("a response that outlives the engine it was asked of", () => {
  /**
   * Pairing a remote engine (or unpairing back to the local one) swaps
   * `client` and blanks what the old engine told us. Every refresher has to
   * re-check the client it started with before it writes, or the OLD engine's
   * answer lands on the NEW one — the model catalog showing weights that are
   * not on this box, the storage pane reporting another machine's disk.
   * refreshHome/refreshBoard already guarded; these two did not.
   */
  const otherEngine = () => useApp.setState({ client: fakeClient({}) });

  it("does not paint the old engine's model catalog", async () => {
    const pending = deferred<unknown>();
    const client = fakeClient({ listModels: vi.fn().mockReturnValue(pending.promise) });
    useApp.setState({ client, models: [] });

    const inFlight = useApp.getState().refreshModels();
    otherEngine(); // the user pairs a GPU box mid-request
    pending.resolve([{ id: "wan2.2", downloaded: true }]);
    await inFlight;

    expect(useApp.getState().models).toEqual([]);
  });

  it("still paints it when the engine has not changed", async () => {
    const client = fakeClient({
      listModels: vi.fn().mockResolvedValue([{ id: "wan2.2", downloaded: true }]),
    });
    useApp.setState({ client, models: [] });

    await useApp.getState().refreshModels();

    expect(useApp.getState().models.map((row) => row.id)).toEqual(["wan2.2"]);
  });

  it("does not report the old engine's disk", async () => {
    const pending = deferred<unknown>();
    const client = fakeClient({ storage: vi.fn().mockReturnValue(pending.promise) });
    useApp.setState({ client, storage: null, storageStale: true });

    const inFlight = useApp.getState().refreshStorage();
    otherEngine();
    pending.resolve({
      projects: [],
      models_bytes: 1,
      cache_bytes: 0,
      disk_free_bytes: 3,
      disk_total_bytes: 9,
    });
    await inFlight;

    expect(useApp.getState().storage).toBeNull();
    // …and the pane is not told the blank it is showing is live.
    expect(useApp.getState().storageStale).toBe(true);
  });

  it("still reports it when the engine has not changed", async () => {
    const client = fakeClient({
      storage: vi.fn().mockResolvedValue({
        projects: [],
        models_bytes: 1,
        cache_bytes: 0,
        disk_free_bytes: 3,
        disk_total_bytes: 9,
      }),
    });
    useApp.setState({ client, storage: null, storageStale: true });

    await useApp.getState().refreshStorage();

    expect(useApp.getState().storage?.disk_free_bytes).toBe(3);
    expect(useApp.getState().storageStale).toBe(false);
  });
});

describe("keeping the flowchart in step with the board", () => {
  const BOARD = { scenes: [], aux: {} };
  const graphOf = (...ids: string[]) => ({
    version: 1,
    nodes: Object.fromEntries(
      ids.map((id) => [
        id,
        { id, kind: "keyframe", params: {}, seed: 0, model: null, pinned: false, frozen_hash: null },
      ]),
    ),
    edges: [],
  });

  it("refetches the graph whenever the board is refreshed", async () => {
    // The canvas fetches once on mount and after its own patches — which left
    // it stale for every OTHER way the graph moves. A first render is the
    // worst of them: the screenplay lands, the graph grows from one node to a
    // scene per beat, the board redraws, and the flowchart keeps showing one.
    const graph = vi.fn().mockResolvedValue(graphOf("script", "s1.keyframe", "s1.clip"));
    const client = fakeClient({
      graph,
      getProject: vi.fn().mockResolvedValue({ project: PROJECT("p1"), board: BOARD }),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never, graph: graphOf("script") });

    await useApp.getState().refreshBoard();

    expect(graph).toHaveBeenCalledWith("p1");
    expect(Object.keys(useApp.getState().graph!.nodes)).toHaveLength(3);
  });

  it("does not ask for a graph nobody is holding", async () => {
    // Only the flowchart ever wants one. The storyboard refreshes on every
    // job event, and paying for a second request there would be pure cost.
    const graph = vi.fn().mockResolvedValue(graphOf("script"));
    const client = fakeClient({
      graph,
      getProject: vi.fn().mockResolvedValue({ project: PROJECT("p1"), board: BOARD }),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never, graph: null });

    await useApp.getState().refreshBoard();

    expect(graph).not.toHaveBeenCalled();
  });

  it("lets the newest graph response win, whatever order they land in", async () => {
    // Now that every board refresh pulls a graph, two are routinely in flight
    // at once — and without a sequence number a slow earlier response repaints
    // a DAG the project has already moved past.
    const first = deferred<ReturnType<typeof graphOf>>();
    const second = deferred<ReturnType<typeof graphOf>>();
    const client = fakeClient({
      graph: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never, graph: graphOf("script") });

    const early = useApp.getState().refreshGraph();
    const late = useApp.getState().refreshGraph();
    second.resolve(graphOf("newest"));
    await late;
    first.resolve(graphOf("stale"));
    await early;

    expect(Object.keys(useApp.getState().graph!.nodes)).toEqual(["newest"]);
  });
});

describe("a graph patch from the canvas", () => {
  it("does not report success for an edit it never sent", async () => {
    // `null` is this function's "it applied", and the canvas reads it that
    // way: `if (error) setHint(error)`. Returning it when there is no client
    // meant a wire drawn against a dropped engine landed visually — the last
    // known graph is deliberately kept on screen — with nothing to say the
    // patch never left. removeNode goes further and clears the selection.
    useApp.setState({ client: null, currentProject: PROJECT("p1") as never });

    const error = await useApp.getState().connectNodes("a", "b", "keyframe");

    expect(error).toBeTruthy();
  });

  it("returns the failure of the refresh that follows the patch", async () => {
    // refreshBoard has no catch of its own, so a patch that landed followed
    // by a refresh that did not used to reject this promise — and every
    // caller invokes it as `void`, making that an unhandled rejection rather
    // than the hint the canvas shows.
    const client = fakeClient({
      patch: vi.fn().mockResolvedValue(undefined),
      getProject: vi.fn().mockRejectedValue(new Error("engine went away")),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    const error = await useApp.getState().disconnectPort("s1.clip", "keyframe");

    expect(error).toBe("engine went away");
  });
});

/**
 * Picking a narration voice.
 *
 * `voice_id` is part of the node's content address, so both directions move
 * it — and only one of them can move it BACK. `set_params` reads a null as
 * "remove the key", so clearing a pick lands on the params a brief-only
 * render already used and hits its cached audio; storing an explicit null
 * would be a third state no earlier render can match, which is the failure
 * the engine's own normalize_params exists to prevent.
 */
describe("setVoice", () => {
  it("sends the picked id", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      patch,
      getProject: vi.fn().mockResolvedValue({ project: PROJECT("p1"), board: { scenes: [] } }),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    expect(await useApp.getState().setVoice("s1.narration", "bf_emma")).toBeNull();
    expect(patch).toHaveBeenCalledWith("p1", [
      { op: "set_params", node_id: "s1.narration", params: { voice_id: "bf_emma" } },
    ]);
  });

  it("clears a pick with null rather than an empty string", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      patch,
      getProject: vi.fn().mockResolvedValue({ project: PROJECT("p1"), board: { scenes: [] } }),
    });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    await useApp.getState().setVoice("s1.narration", null);

    const params = patch.mock.calls[0][1][0].params;
    expect(params).toEqual({ voice_id: null });
    // "" would be stored and would hash differently from absent, so the
    // audio rendered before the pick could never be a cache hit again.
    expect(params.voice_id).not.toBe("");
  });

  it("reports a refusal rather than throwing", async () => {
    const client = fakeClient({ patch: vi.fn().mockRejectedValue(new Error("node is pinned")) });
    useApp.setState({ client, currentProject: PROJECT("p1") as never });

    expect(await useApp.getState().setVoice("s1.narration", "bf_emma")).toBe("node is pinned");
  });
});

/**
 * Clearing the quick-tool history.
 *
 * The loop reuses DELETE /projects/{id} rather than adding a bulk route,
 * which means it also inherits deleteProject's tab bookkeeping — and that is
 * the part with a sharp edge: closing the ACTIVE tab activates its
 * neighbour, and during a clear-all the neighbour is the next session about
 * to be deleted.
 */
describe("deleteToolSessions", () => {
  const session = (id: string) => ({ ...PROJECT(id), mode: "tool:image", approvals: [] });
  const video = (id: string) => ({ ...PROJECT(id), mode: "prompt", approvals: [] });

  it("deletes every session and leaves real projects alone", async () => {
    const deleted: string[] = [];
    const client = fakeClient({
      deleteProject: vi.fn(async (id: string) => {
        deleted.push(id);
      }),
    });
    useApp.setState({ client, projects: [video("v1"), session("t1"), session("t2")] });

    expect(await useApp.getState().deleteToolSessions()).toBeNull();
    expect(deleted.sort()).toEqual(["t1", "t2"]);
    expect(useApp.getState().projects.map((p) => p.id)).toEqual(["v1"]);
  });

  it("closes the doomed tabs up front instead of activating each in turn", async () => {
    const opened: string[] = [];
    const client = fakeClient({
      deleteProject: vi.fn(async () => {}),
      getProject: vi.fn(async (id: string) => {
        opened.push(id);
        return { project: session(id), board: null };
      }),
    });
    useApp.setState({
      client,
      projects: [session("t1"), session("t2"), session("t3")],
      openProjects: ["t1", "t2", "t3"],
      currentProject: session("t1") as never,
    });

    await useApp.getState().deleteToolSessions();
    // No session's board is fetched on the way past — the tabs go in one
    // step and the workspace falls back to Home, rather than flickering
    // through boards for projects that are being erased.
    expect(opened).toEqual([]);
    expect(useApp.getState().openProjects).toEqual([]);
    expect(useApp.getState().currentProject).toBeNull();
  });

  it("keeps going after one failure and reports it", async () => {
    const client = fakeClient({
      deleteProject: vi.fn(async (id: string) => {
        if (id === "t1") throw new Error("engine said no");
      }),
    });
    useApp.setState({ client, projects: [session("t1"), session("t2")] });

    expect(await useApp.getState().deleteToolSessions()).toContain("engine said no");
    // t2 still went, and the one that failed is restored to the list.
    expect(useApp.getState().projects.map((p) => p.id)).toEqual(["t1"]);
  });

  it("reports rather than throws when there is no engine", async () => {
    useApp.setState({ client: null, projects: [session("t1")] });
    expect(await useApp.getState().deleteToolSessions()).toBeTruthy();
  });
});
