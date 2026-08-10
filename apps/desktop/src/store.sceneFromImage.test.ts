/**
 * Building a scene out of a dropped picture is ONE patch.
 *
 * It was two — `add_scene`, then a `connect` wiring the uploaded asset onto
 * the new clip's keyframe port — and the split cost twice.
 *
 * The engine enqueues at the end of every patch. After the first one the
 * generated `{sid}.keyframe` still feeds the clip, so it is queued and
 * rendered in full; the second patch then displaces it. `orphaned_nodes`
 * exists in the compiler to stop precisely that waste and could not, because
 * the node was not orphaned yet. Every drop paid for a picture nobody sees.
 *
 * And two patches can half-succeed. A failed second one left a scene with no
 * image and both fields filled, in front of a dialog that stayed open — so
 * the obvious retry appended a SECOND scene rather than repairing the first.
 *
 * `src` on the op is what makes it one: the engine wires the asset while it
 * builds the subgraph.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "./store";

const patch = vi.fn(async (_id: string, _ops: unknown[]) => ({ dirty: ["s2.keyframe", "s2.clip"] }));

function fakeEngine() {
  useApp.setState({
    client: { patch } as never,
    currentProject: { id: "p1", title: "t" } as never,
    board: { scenes: [{ scene_id: "s1" }], aux: {} } as never,
    refreshBoard: async () => {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({ dirty: ["s2.keyframe", "s2.clip"] });
  fakeEngine();
});

describe("adding a scene from a dropped image", () => {
  it("sends one patch carrying the words AND the picture", async () => {
    const error = await useApp
      .getState()
      .addSceneFromImage("asset-abc", { narration: "The city wakes.", prompt: "a slow push in" });

    expect(error).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![1]).toEqual([
      {
        op: "add_scene",
        node_id: "",
        src: "asset-abc",
        params: { narration: "The city wakes.", prompt: "a slow push in" },
      },
    ]);
  });

  it("never follows up with a separate connect", async () => {
    // The follow-up is what rendered a keyframe the scene then threw away:
    // the first patch enqueues while the generated node still feeds the clip.
    await useApp
      .getState()
      .addSceneFromImage("asset-abc", { narration: "n", prompt: "p" });

    const ops = patch.mock.calls.flatMap((call) => call[1] as { op: string }[]);
    expect(ops.map((op) => op.op)).toEqual(["add_scene"]);
  });

  it("selects the clip, not the keyframe this op just orphaned", async () => {
    // `addScene` selects the keyframe so the Inspector opens on the prompt
    // still to be written. Here it has just been written, and `src` leaves
    // that node feeding nothing — so selecting it would open the panel on a
    // tile marked "not needed" the instant the scene was made, and highlight
    // no card, since the card matches on the still and the clip.
    await useApp
      .getState()
      .addSceneFromImage("asset-abc", { narration: "n", prompt: "p" });

    expect(useApp.getState().selectedNode).toBe("s2.clip");
  });

  it("reports a refusal rather than throwing", async () => {
    patch.mockRejectedValueOnce(new Error("nope"));

    const error = await useApp
      .getState()
      .addSceneFromImage("asset-abc", { narration: "n", prompt: "p" });

    expect(error).toBe("nope");
  });

  it("still lands the scene when the new id cannot be picked out", async () => {
    // Selection is a convenience. The scene and its picture are already on
    // the graph by the time this runs, so failing to spot the id is nothing
    // to report — reporting it invited the retry that duplicated the scene.
    patch.mockResolvedValueOnce({ dirty: [] });

    const error = await useApp
      .getState()
      .addSceneFromImage("asset-abc", { narration: "n", prompt: "p" });

    expect(error).toBeNull();
  });
});
