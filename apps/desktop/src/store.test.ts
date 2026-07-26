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
