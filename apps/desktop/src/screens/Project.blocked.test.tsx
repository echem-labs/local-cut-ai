import { render, screen } from "@testing-library/react";

import { describe, expect, it } from "vitest";

import type { Board, NodeState, NodeStatus } from "../api/types";
import { isDone, isSettled } from "../lib/status";
import { useApp } from "../store";
import { Project } from "./Project";

/**
 * `blocked` is settled but not done, and the header is where the difference
 * shows.
 *
 * "+ Add scene" mints a scene whose prompt and narration come later, so the
 * engine reports that scene AND its whole downstream cone — clip, timeline,
 * export — as `blocked`: never enqueued, waiting on a person. Adding it to
 * SETTLED is right (a gate that waits for it waits forever) but SETTLED also
 * fed every completion report on this screen, so the pipeline ticked
 * "✓ Export" for a video that cannot be assembled and offered "Create final
 * video", which enqueues nothing and refreshes a board that has not changed.
 */

const node = (node_id: string, status: NodeStatus): NodeState => ({
  node_id,
  status,
  progress: 0,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

/** One written scene, one blank one — and the cone the blank one blocks. */
const boardWithABlankScene: Board = {
  scenes: [
    {
      scene_id: "s1",
      keyframe: node("s1.keyframe", "draft"),
      clip: node("s1.clip", "draft"),
      narration: node("s1.narration", "draft"),
    },
    {
      scene_id: "s2",
      keyframe: node("s2.keyframe", "blocked"),
      clip: node("s2.clip", "blocked"),
      narration: node("s2.narration", "blocked"),
    },
  ],
  aux: {
    script: node("script", "draft"),
    // The voiceover is downstream of every narration, so the blank scene
    // blocks it too — and the audio stage aggregates rather than calling
    // stageOf, so it needs its own case.
    voiceover: node("voiceover", "blocked"),
    timeline: node("timeline", "blocked"),
    export: node("export", "blocked"),
  },
  assembled_durations: {},
} as unknown as Board;

const mount = (board: Board) => {
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", mode: "auto", approvals: [] },
    board,
    jobs: [],
    allJobs: [],
  } as never);
  render(<Project />);
};

describe("the two questions a settled status answers", () => {
  it("counts blocked as settled but not as done", () => {
    expect(isSettled("blocked")).toBe(true);
    expect(isDone("blocked")).toBe(false);
    // skipped is the status that must answer both the same way: nothing is
    // coming AND the storyboard really is finished, because the scene is
    // conditioned on an uploaded image.
    expect(isSettled("skipped")).toBe(true);
    expect(isDone("skipped")).toBe(true);
  });
});

describe("a project with a scene nobody has written", () => {
  it("does not tick the pipeline stages a blocked node holds back", () => {
    mount(boardWithABlankScene);

    const pipeline = screen.getByRole("status", { name: /progress/i });
    const stage = (label: RegExp) =>
      Array.from(pipeline.children).find((el) => label.test(el.textContent ?? ""));

    // The written scene's own stages still read honestly...
    expect(stage(/script/i)?.className).toContain("done");
    // ...and every stage the blank scene holds back reads as OFF, the muted
    // dash `cancelled` gets. Asserting the state, not just "not done": with
    // `work` as the fallback arm of these ternaries, a blocked node traded a
    // green tick for an accent dot that pulses forever (`.pipeline .st.work
    // i` carries an infinite animation) — a different lie about the same
    // node. Nothing is happening here and there is no result.
    expect(stage(/storyboard/i)?.className).toContain("off");
    expect(stage(/export/i)?.className).toContain("off");
    expect(stage(/audio/i)?.className).toContain("off");
    for (const label of [/storyboard/i, /export/i, /audio/i]) {
      expect(stage(label)?.className).not.toContain("done");
      expect(stage(label)?.className).not.toContain("work");
    }
    // "1 of 2", not "2 of 2": a scene with no prompt is not a video that is ready.
    expect(stage(/videos/i)?.textContent).toMatch(/1\s*\/\s*2|1 of 2/i);
  });

  it("still shows work in flight as work", () => {
    // The `off` arm must not swallow a stage that IS running: the blank
    // scene's keyframe is rendering rather than blocked.
    mount({
      ...boardWithABlankScene,
      scenes: [
        boardWithABlankScene.scenes[0],
        { ...boardWithABlankScene.scenes[1], keyframe: node("s2.keyframe", "rendering") },
      ],
    });

    const pipeline = screen.getByRole("status", { name: /progress/i });
    const storyboard = Array.from(pipeline.children).find((el) =>
      /storyboard/i.test(el.textContent ?? ""),
    );
    expect(storyboard?.className).toContain("work");
  });

  it("does not pulse a stage whose node failed for good", () => {
    // The `work` arm is the fallback, so it also swallowed the two statuses
    // that are neither settled nor running: a failed keyframe and a
    // cancelled one both read as "in progress", with `.pipeline .st.work i`
    // animating forever and the `!` glyph the stage defines unreachable.
    // Same lie as the green tick, and the same lie the `off` arm removed for
    // `blocked` -- `stageOf` has said `fail`/`off` for these all along.
    mount({
      ...boardWithABlankScene,
      scenes: [
        boardWithABlankScene.scenes[0],
        { ...boardWithABlankScene.scenes[1], keyframe: node("s2.keyframe", "failed") },
      ],
      aux: { ...boardWithABlankScene.aux, voiceover: node("voiceover", "cancelled") },
    });

    const pipeline = screen.getByRole("status", { name: /progress/i });
    const stage = (label: RegExp) =>
      Array.from(pipeline.children).find((el) => label.test(el.textContent ?? ""));

    expect(stage(/storyboard/i)?.className).toContain("fail");
    expect(stage(/storyboard/i)?.className).not.toContain("work");
    // Nothing is coming from a cancelled job either, and nothing was made.
    expect(stage(/audio/i)?.className).toContain("off");
    expect(stage(/audio/i)?.className).not.toContain("work");
  });

  it("does not offer to create the final video", () => {
    mount(boardWithABlankScene);
    expect(screen.queryByRole("button", { name: /create final video/i })).toBeNull();
  });

  it("offers it again once every scene is written", () => {
    mount({
      ...boardWithABlankScene,
      scenes: boardWithABlankScene.scenes.map((scene) => ({
        ...scene,
        keyframe: node(`${scene.scene_id}.keyframe`, "draft"),
        clip: node(`${scene.scene_id}.clip`, "draft"),
        narration: node(`${scene.scene_id}.narration`, "draft"),
      })),
    });
    expect(screen.getByRole("button", { name: /create final video/i })).toBeInTheDocument();
  });
});
