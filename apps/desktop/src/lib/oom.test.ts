import { describe, expect, it } from "vitest";

import type { Job, ModelRow, NodeState } from "../api/types";
import { modelThatFailed, nextResolutionScale, smallerModelFor, tasksForNode } from "./oom";

const model = (
  id: string,
  task: string,
  vram: number,
  quality: number,
  downloaded = true,
): ModelRow =>
  ({
    id,
    task,
    requirements: { vram_gb: vram, ram_gb: 8, disk_gb: 4, backends: ["comfyui"] },
    quality_score: quality,
    speed_score: 5,
    downloaded,
  }) as unknown as ModelRow;

const job = (nodeId: string, status: string, modelId: string | null, createdAt: number): Job =>
  ({
    id: `j${createdAt}`,
    project_id: "p1",
    status,
    model: modelId,
    created_at: createdAt,
    spec: { node_id: nodeId, kind: "clip" },
  }) as unknown as Job;

describe("the resolution the smaller-render chip drops to", () => {
  it("starts below the ladder the engine already walked", () => {
    // The engine's own rungs are 0.75 then 0.5, so offering 0.75 would ask
    // for a render that already failed inside the job that just gave up.
    expect(nextResolutionScale(undefined)).toBe(0.5);
    expect(nextResolutionScale(1)).toBe(0.5);
  });

  it("steps down again from a node already lowered", () => {
    expect(nextResolutionScale(0.5)).toBe(0.25);
  });

  it("runs out rather than shrinking forever", () => {
    // Below a quarter there is nothing to judge, and a chip that always
    // offers one more step implies the next one might work.
    expect(nextResolutionScale(0.25)).toBeNull();
    expect(nextResolutionScale(0.1)).toBeNull();
  });

  it("treats a nonsense value as unset", () => {
    expect(nextResolutionScale("big")).toBe(0.5);
    expect(nextResolutionScale(0)).toBe(0.5);
  });
});

describe("which tasks can serve a node", () => {
  it("maps the kinds the engine's ComfyUI map covers", () => {
    expect(tasksForNode("s1.clip")).toEqual(["video.i2v", "video.t2v"]);
    expect(tasksForNode("s2.clip2")).toEqual(["video.i2v", "video.t2v"]);
    expect(tasksForNode("s1.keyframe")).toEqual(["image.gen"]);
    expect(tasksForNode("thumbnail")).toEqual(["image.gen"]);
    expect(tasksForNode("music")).toEqual(["music.gen"]);
  });

  it("claims nothing for a node no model choice applies to", () => {
    // Assembly and narration are not ComfyUI kinds; offering a "smaller
    // model" for the timeline would be a control with nothing behind it.
    expect(tasksForNode("timeline")).toEqual([]);
    expect(tasksForNode("s1.narration")).toEqual([]);
    expect(tasksForNode("script")).toEqual([]);
  });
});

describe("the model that ran out of memory", () => {
  it("prefers what the backend reported over what the node asked for", () => {
    // NodeState.model is the REQUEST and is usually null; the job carries
    // what actually loaded, which is the one that exhausted the GPU.
    const node = { model: "wan-14b" } as unknown as NodeState;
    const jobs = [job("s1.clip", "failed", "ltx-13b", 10)];
    expect(modelThatFailed("s1.clip", jobs, node)).toBe("ltx-13b");
  });

  it("takes the newest failure when a node has failed more than once", () => {
    const jobs = [
      job("s1.clip", "failed", "old-model", 10),
      job("s1.clip", "failed", "new-model", 20),
    ];
    expect(modelThatFailed("s1.clip", jobs, undefined)).toBe("new-model");
  });

  it("ignores another node's failures", () => {
    const jobs = [job("s2.clip", "failed", "other-model", 30)];
    expect(modelThatFailed("s1.clip", jobs, undefined)).toBeNull();
  });

  it("falls back to the node's request when no job says otherwise", () => {
    const node = { model: "wan-14b" } as unknown as NodeState;
    expect(modelThatFailed("s1.clip", [], node)).toBe("wan-14b");
  });
});

describe("the smaller model on offer", () => {
  const models = [
    model("big", "video.t2v", 24, 9),
    model("mid", "video.i2v", 12, 7),
    model("mid-worse", "video.t2v", 12, 5),
    model("tiny", "video.t2v", 6, 3),
    model("not-here", "video.t2v", 8, 8, false),
    model("an-image-model", "image.gen", 4, 9),
  ];

  it("picks the best of the ones that are smaller, not the smallest", () => {
    // Dropping from 24GB straight to the 6GB model costs more quality than
    // the failure demands. `mid` fits and is the best that does.
    expect(smallerModelFor("s1.clip", models, "big")?.id).toBe("mid");
  });

  it("will not offer a model that is not downloaded", () => {
    // `not-here` outranks `mid` on quality but would need a multi-GB
    // download first, which is not a one-click answer to a failed render.
    expect(smallerModelFor("s1.clip", models, "big")?.id).not.toBe("not-here");
  });

  it("never offers a model for another task", () => {
    expect(smallerModelFor("s1.clip", models, "big")?.task).not.toBe("image.gen");
    expect(smallerModelFor("s1.keyframe", models, null)?.id).toBe("an-image-model");
  });

  it("says nothing when the failure was already the smallest", () => {
    expect(smallerModelFor("s1.clip", models, "tiny")).toBeNull();
  });

  it("says nothing for a node whose kind has no model choice", () => {
    expect(smallerModelFor("timeline", models, "big")).toBeNull();
  });

  it("breaks a tie the same way on every machine", () => {
    // Layout and any derived ordering use code-unit comparison, never
    // localeCompare — the answer must not depend on the user's locale.
    const tied = [model("b-model", "video.t2v", 12, 7), model("a-model", "video.t2v", 12, 7)];
    expect(smallerModelFor("s1.clip", tied, "big")?.id).toBe("a-model");
  });

  it("still offers the best installed model when the failure is unidentifiable", () => {
    // An external or since-removed model has no manifest row, so there is no
    // "smaller than" to measure — but there is still a real choice to offer.
    expect(smallerModelFor("s1.clip", models, "vanished")?.id).toBe("big");
  });
});
