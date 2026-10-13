/**
 * How long a scene runs, before and after assembly.
 *
 * A clip's `duration_s` is the length of ONE take. A scene whose narration
 * outruns what a video model renders in one go is split into sequential
 * takes (templates.py `MAX_CLIP_S`), and assembly then stretches the scene to
 * its narration, so on a real 60 s project the cards read 7.5 s, 6.7 s and
 * 5 s for scenes the timeline and the export ran 21, 23 and 19 s.
 */
import { describe, expect, it } from "vitest";

import type { Board, NodeState, SceneCardModel } from "../api/types";
import { spokenSeconds } from "./formats";
import { sceneDurations, sceneLength } from "./order";

const node = (id: string, params: Record<string, unknown>): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: null,
  params,
  seed: 0,
  model: null,
  pinned: false,
});

const WORDS = Array.from({ length: 63 }, (_, i) => `word${i}`).join(" ");

/** Three 7.5 s takes, with or without a line to speak over them. */
const split = (narration: string | null): SceneCardModel => ({
  scene_id: "s1",
  keyframe: node("s1.keyframe", {}),
  clip: node("s1.clip", { duration_s: 7.5, take: 1 }),
  clip_takes: [
    node("s1.clip2", { duration_s: 7.5, take: 2 }),
    node("s1.clip3", { duration_s: 7.5, take: 3 }),
  ],
  narration: narration === null ? null : node("s1.narration", { text: narration }),
});

const board = (scene: SceneCardModel, assembled?: Record<string, number>): Board => ({
  scenes: [scene],
  aux: {},
  ...(assembled ? { assembled_durations: assembled } : {}),
});

describe("a scene's length", () => {
  it("is the assembled cut's once there is one", () => {
    const scene = split(WORDS);
    expect(sceneDurations(board(scene, { s1: 21.04 }), [scene])).toEqual([21.04]);
    expect(sceneLength(board(scene, { s1: 21.04 }), scene)).toEqual({
      seconds: 21.04,
      estimate: false,
    });
  });

  // Assembly's own rule (ffmpeg.py): a narrated scene lasts as long as its
  // line takes to speak, plus the pad. Not one take, and not the takes'
  // sum either, which is a plan the narration overrides.
  it("is the narration's spoken time before assembly", () => {
    const scene = split(WORDS);
    expect(sceneDurations(board(scene), [scene])).toEqual([spokenSeconds(WORDS)]);
    expect(sceneLength(board(scene), scene)).toEqual({
      seconds: spokenSeconds(WORDS),
      estimate: true,
    });
  });

  // A silent scene assembles to its clip material, and a split scene's
  // material is every take.
  it("counts every take of a scene with nothing to say", () => {
    const silent = split(null);
    expect(sceneDurations(board(silent), [silent])).toEqual([22.5]);
    // A scene added from the board has a narration node with no words yet.
    const unwritten = split("   ");
    expect(sceneDurations(board(unwritten), [unwritten])).toEqual([22.5]);
  });

  it("does not let another scene's assembly stand in for this one", () => {
    const scene = split(null);
    expect(sceneDurations(board(scene, { s2: 30 }), [scene])).toEqual([22.5]);
  });
});
