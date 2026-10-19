/**
 * Where a render estimate is allowed to come from.
 *
 * The rule this module has always followed is "no invented numbers" — an
 * estimate is shown only when something was actually measured. What changed
 * in U5 is WHO measured it. Until now the only source was this window
 * watching progress tick by, cached in `localStorage` so a new session had
 * something to say. That cache is keyed by nothing: point the desktop at a
 * remote engine on a GPU box and the CTA quotes timings measured on the
 * laptop, which is the topology the whole HTTP-only boundary exists to
 * support.
 *
 * The engine has known its own timings all along (`/system/etas`: medians
 * per node kind and quality, over completed jobs from every project on that
 * machine). It is a strict superset of what this window can observe — you
 * cannot watch a render the engine did not run — and it is measured on the
 * machine that will do the work. So it wins, and the session samples become
 * the fallback for an engine that has not rendered anything yet.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Board, NodeState } from "../api/types";
import { finalCostFactor, finalizeEta, setEngineEtas } from "./eta";

const node = (id: string, status = "draft"): NodeState =>
  ({
    node_id: id,
    status,
    progress: 0,
    error: null,
    artifact_hash: null,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

/** Two scenes, neither clip rendered at final quality yet. */
const board = (scenes = 2): Board =>
  ({
    scenes: Array.from({ length: scenes }, (_, i) => ({
      scene_id: `s${i + 1}`,
      keyframe: node(`s${i + 1}.keyframe`),
      clip: node(`s${i + 1}.clip`),
      narration: node(`s${i + 1}.narration`),
    })),
    aux: {},
    assembled_durations: {},
  }) as unknown as Board;

beforeEach(() => setEngineEtas(null));

describe("the finalize estimate", () => {
  it("says nothing when nothing has been measured", () => {
    // The oldest rule in this file, and the one worth keeping: a fresh
    // install with no history gets no number rather than a guess.
    expect(finalizeEta(board())).toBeNull();
  });

  it("uses the engine's measured FINAL median, with no quality factor", () => {
    // 60s per clip, measured at the quality the CTA is about to request.
    // Two clips plus the assembly tail. The ladder's draft->final factor
    // must not be applied on top of a real final-quality sample.
    setEngineEtas({
      clip: { final: { seconds: 60, samples: 4 }, draft: { seconds: 20, samples: 9 } },
    });
    // 2 x 60 = 120s, plus the tail; well past the 90s minutes threshold.
    expect(finalizeEta(board())).toBe("~3 min");
  });

  it("scales a draft median when the engine has never rendered a final", () => {
    // The common case: you have watched drafts, never pressed the CTA. A
    // final clip has 38 steps to the draft's 25 over a frame 1.5 times as
    // wide and as tall, which costs 4.19 times the draft here.
    setEngineEtas({ clip: { draft: { seconds: 60, samples: 5 } } });
    // 2 x 60 x 4.19 = 503s + 30s tail = 533s -> 9 min.
    expect(finalizeEta(board())).toBe("~9 min");
  });

  it("prices a final clip by its steps and its frame, not its steps alone", () => {
    // The 2026-10-19 run on an 8 GB RTX 3080 Laptop GPU: LTX drafts at
    // 768x448 and 25 steps took a median 105 s, finals at 1152x672 and 38
    // steps took 440 s. A factor of the steps alone (1.5) said 158 s.
    expect(finalCostFactor("clip") * 105).toBeGreaterThan(430);
    expect(finalCostFactor("clip") * 105).toBeLessThan(450);
  });

  it("prices a final keyframe and music by their extra steps alone", () => {
    // Their frame and their length stay as drafted. The run's keyframes went
    // from 18-22 s to 29-32 s.
    expect(finalCostFactor("keyframe")).toBeCloseTo(1.5, 2);
    expect(finalCostFactor("music")).toBeCloseTo(40 / 27, 2);
  });

  it("counts the keyframes and the music the final pass renders again", () => {
    setEngineEtas({
      clip: { final: { seconds: 60, samples: 4 } },
      keyframe: { draft: { seconds: 20, samples: 8 } },
      music: { final: { seconds: 25, samples: 1 } },
    });
    const b = board();
    b.aux = { music: node("music") };
    // 2 x 60 + 2 x 20 x 1.5 + 25 + 30 tail = 235s -> 4 min.
    expect(finalizeEta(b)).toBe("~4 min");
  });

  it("does not count a keyframe the scene does not render", () => {
    // A scene built from the user's own picture has no keyframe coming.
    setEngineEtas({
      clip: { final: { seconds: 60, samples: 4 } },
      keyframe: { final: { seconds: 120, samples: 4 } },
    });
    const b = board();
    b.scenes[0].keyframe = node("s1.keyframe", "skipped");
    b.scenes[1].keyframe = null;
    // 2 x 60 + 30 tail = 150s -> 3 min, with no keyframe in it.
    expect(finalizeEta(b)).toBe("~3 min");
  });

  it("would have said about an hour for the run that took 64 minutes", () => {
    // Create final video on 2026-10-19, eight scenes, with the medians the
    // drafts left: clips 105 s, keyframes 20 s, music 21 s, and 33 s for the
    // timeline, captions and export together. The button said ~23 min and
    // the pass took 63 min 54 s.
    setEngineEtas({
      clip: { draft: { seconds: 105, samples: 8 } },
      keyframe: { draft: { seconds: 20, samples: 11 } },
      music: { draft: { seconds: 21, samples: 1 } },
      timeline: { draft: { seconds: 8, samples: 2 } },
      captions: { draft: { seconds: 6, samples: 2 } },
      export: { draft: { seconds: 19, samples: 2 } },
    });
    const b = board(8);
    b.aux = { music: node("music"), captions: node("captions") };
    expect(finalizeEta(b)).toBe("~64 min");
  });

  it("measures the assembly tail too, when the engine knows it", () => {
    // The tail was a hardcoded 30s for the timeline + export pair. The
    // engine has medians for both kinds, so on a machine where assembly is
    // slow the estimate stops being optimistic by a fixed amount.
    setEngineEtas({
      clip: { final: { seconds: 60, samples: 4 } },
      timeline: { final: { seconds: 45, samples: 3 } },
      export: { final: { seconds: 75, samples: 3 } },
    });
    // 2 x 60 + 45 + 75 = 240s -> 4 min, not the 3 the 30s default gives.
    expect(finalizeEta(board())).toBe("~4 min");
  });

  it("does not count a clip that is already final, or a pinned one", () => {
    setEngineEtas({ clip: { final: { seconds: 60, samples: 4 } } });
    const b = board(3);
    b.scenes[0].clip = { ...b.scenes[0].clip, status: "final" } as NodeState;
    b.scenes[1].clip = { ...b.scenes[1].clip, pinned: true } as NodeState;
    // One clip left: 60 + 30 tail = 90s.
    expect(finalizeEta(b)).toBe("~2 min");
  });

  it("ignores a kind it has no clip median for", () => {
    // An engine that has only ever rendered scripts knows nothing about
    // what a clip costs here, and must not be mistaken for one that does.
    setEngineEtas({ script: { draft: { seconds: 3, samples: 20 } } });
    expect(finalizeEta(board())).toBeNull();
  });
});
