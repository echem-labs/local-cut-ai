/**
 * U3's store surface: the quick-tool depth that has to reach the engine
 * intact. Three properties pinned here:
 *
 * - A start frame conditions the NEW session in one patch — connect then
 *   remove — so the clip renders from the user's image and no orphan
 *   keyframe renders a frame nothing consumes.
 * - "Add to project" moves bytes through HTTP both ways (artifact fetch →
 *   asset upload), never a path — the engine may be on another machine.
 * - A cloned voice reaches the session's node only through the consented
 *   upload + voice_ref wire, the same pair the workspace uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "./i18n";
import { useApp } from "./store";

const PROJECT = { id: "p1", title: "a hummingbird", created_at: 0, updated_at: 0, mode: "tool:clip" };

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listJobs: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({ project: PROJECT, board: { scenes: [], aux: {} } }),
    history: vi.fn().mockResolvedValue({ undo: 0, redo: 0, save_points: [] }),
    createTool: vi.fn().mockResolvedValue(PROJECT),
    uploadAsset: vi.fn().mockResolvedValue({ node_id: "asset-abc123", hash: "h1", name: "n" }),
    patch: vi.fn().mockResolvedValue({ dirty: ["clip"] }),
    regenerate: vi.fn().mockResolvedValue(undefined),
    artifactUrl: vi.fn(
      (pid: string, hash: string) => `http://engine/projects/${pid}/artifacts/${hash}`,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    jobs: [],
    currentProject: null,
    board: null,
    openProjects: [],
    actionError: null,
  } as never);
});

describe("createTool with a start frame", () => {
  it("uploads into the new session, wires the clip and removes the keyframe in one patch", async () => {
    const client = fakeClient();
    useApp.setState({ client } as never);
    const frame = new File(["png-bytes"], "hero.png", { type: "image/png" });

    await useApp.getState().createTool("clip", { prompt: "a hummingbird" }, frame);

    expect(client.uploadAsset).toHaveBeenCalledWith("p1", frame);
    expect(client.patch).toHaveBeenCalledWith("p1", [
      { op: "connect", node_id: "clip", src: "asset-abc123", port: "keyframe" },
      { op: "remove_node", node_id: "keyframe" },
    ]);
    // Order is the property: connect frees the keyframe of its consumer
    // before the removal, so the engine never sees a wired node vanish.
    const upload = client.uploadAsset.mock.invocationCallOrder[0];
    const patch = client.patch.mock.invocationCallOrder[0];
    expect(upload).toBeLessThan(patch);
  });

  it("does not condition when no frame was picked", async () => {
    const client = fakeClient();
    useApp.setState({ client } as never);
    await useApp.getState().createTool("clip", { prompt: "a hummingbird" });
    expect(client.uploadAsset).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("reports a conditioning failure instead of swallowing it", async () => {
    const client = fakeClient({
      uploadAsset: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    useApp.setState({ client } as never);
    await useApp
      .getState()
      .createTool("clip", { prompt: "x" }, new File(["y"], "y.png", { type: "image/png" }));
    expect(useApp.getState().actionError).toMatchObject({ scope: "tool" });
  });
});

describe("addToProject", () => {
  const session = () =>
    useApp.setState({
      client: fakeClient(),
      currentProject: { ...PROJECT, mode: "tool:music" },
      board: {
        scenes: [],
        aux: {
          music: {
            node_id: "music",
            status: "draft",
            progress: 1,
            error: null,
            artifact_hash: "c".repeat(64),
            params: {},
            seed: 0,
            model: null,
            pinned: false,
          },
        },
      },
    } as never);

  it("fetches the artifact over HTTP and uploads it into the target", async () => {
    session();
    const blob = new Blob(["riff"], { type: "audio/wav" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => blob,
      headers: new Headers({ "content-disposition": 'inline; filename="a hummingbird.wav"' }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await useApp.getState().addToProject("p2");

    expect(result).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain(`/projects/p1/artifacts/${"c".repeat(64)}`);
    const client = useApp.getState().client as unknown as { uploadAsset: ReturnType<typeof vi.fn> };
    const [target, file] = client.uploadAsset.mock.calls[0];
    expect(target).toBe("p2");
    // The engine's own name for the artifact — no consent flag: a music
    // bed is a plain asset now, not a voice sample.
    expect((file as File).name).toBe("a hummingbird.wav");
    expect(client.uploadAsset.mock.calls[0][2]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns a message, not an exception, when the engine refuses", async () => {
    session();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("engine gone")));
    expect(await useApp.getState().addToProject("p2")).toBe("engine gone");
    vi.unstubAllGlobals();
  });

  it("refuses with a message when there is nothing to add", async () => {
    useApp.setState({ client: fakeClient(), currentProject: null } as never);
    expect(await useApp.getState().addToProject("p2")).toBe(t("errors.engineUnavailable"));
  });
});

describe("applySessionVoiceClone", () => {
  it("uploads with the affirmation and wires voice_ref on the session node", async () => {
    const client = fakeClient();
    useApp.setState({
      client,
      currentProject: { ...PROJECT, mode: "tool:voiceover" },
      board: { scenes: [], aux: {} },
    } as never);
    const sample = new File(["riff"], "me.wav", { type: "audio/wav" });

    expect(await useApp.getState().applySessionVoiceClone(sample)).toBeNull();

    expect(client.uploadAsset).toHaveBeenCalledWith("p1", sample, { consent: true });
    expect(client.patch).toHaveBeenCalledWith("p1", [
      { op: "set_model", node_id: "voiceover", model: "local:chatterbox" },
      { op: "connect", node_id: "voiceover", src: "asset-abc123", port: "voice_ref" },
    ]);
  });

  it("hands back the engine's refusal as a message", async () => {
    const client = fakeClient({
      patch: vi.fn().mockRejectedValue(new Error("voice_ref accepts only a consented sample")),
    });
    useApp.setState({
      client,
      currentProject: { ...PROJECT, mode: "tool:voiceover" },
    } as never);
    const result = await useApp
      .getState()
      .applySessionVoiceClone(new File(["riff"], "me.wav", { type: "audio/wav" }));
    expect(result).toContain("consented");
  });
});
