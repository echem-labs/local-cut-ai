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
import { finalizeEta, setEngineEtas } from "./eta";

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
    // Two clips plus the assembly tail. The 1.5x draft->final factor is a
    // guess that must not be applied on top of a real final-quality sample.
    setEngineEtas({
      clip: { final: { seconds: 60, samples: 4 }, draft: { seconds: 20, samples: 9 } },
    });
    // 2 x 60 = 120s, plus the tail; well past the 90s minutes threshold.
    expect(finalizeEta(board())).toBe("~3 min");
  });

  it("scales a draft median when the engine has never rendered a final", () => {
    // The common case: you have watched drafts, never pressed the CTA. The
    // factor is honest here because there is nothing better to use.
    setEngineEtas({ clip: { draft: { seconds: 60, samples: 5 } } });
    // 2 x 60 x 1.5 = 180s + 30s tail = 210s -> 4 min.
    expect(finalizeEta(board())).toBe("~4 min");
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
