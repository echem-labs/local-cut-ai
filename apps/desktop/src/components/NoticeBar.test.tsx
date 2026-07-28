/**
 * The soft-warning bar for finished renders.
 *
 * The first notice it carries is the reason a "60s" project plays for 45:
 * the script model could not reach the target and the engine rendered the
 * longest attempt instead of failing. Before this bar the only trace was a
 * server log — a desktop user saw a short video and nothing else.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Board, NodeNotice, NodeState } from "../api/types";
import { collectNotices, NoticeBar } from "./NoticeBar";
import { useApp } from "../store";

const node = (id: string, notices?: NodeNotice[]): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  notices,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const SHORT: NodeNotice = {
  code: "script.short_of_target",
  data: { target_s: 60, estimated_s: 45, words: 148 },
};

const board = (aux: Record<string, NodeState>): Board => ({
  scenes: [
    {
      scene_id: "s1",
      keyframe: node("s1.keyframe"),
      clip: node("s1.clip"),
      narration: null,
    },
  ],
  aux,
});

function mount(aux: Record<string, NodeState>) {
  useApp.setState({ board: board(aux) } as never);
  return render(<NoticeBar />);
}

describe("NoticeBar", () => {
  it("renders a short-of-target notice with its numbers interpolated", () => {
    mount({ script: node("script", [SHORT]) });
    const bar = screen.getByRole("note");
    expect(bar.textContent).toContain("45");
    expect(bar.textContent).toContain("60");
    expect(bar.textContent).toContain("148");
    // The message text, not the wire id.
    expect(bar.textContent).not.toContain("short_of_target");
  });

  it("renders nothing when no cell carries a notice", () => {
    mount({ script: node("script") });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("skips a code this build does not know rather than show a raw id", () => {
    // A newer engine behind an older desktop: unknown codes must not put an
    // untranslated identifier on screen.
    mount({ script: node("script", [{ code: "clip.someday_new", data: {} }]) });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("dedupes identical notices across cells, keeps distinct data apart", () => {
    const again: NodeNotice = { ...SHORT, data: { ...SHORT.data } };
    const other: NodeNotice = {
      code: "script.short_of_target",
      data: { target_s: 120, estimated_s: 73, words: 246 },
    };
    const cells = board({
      script: node("script", [SHORT, other]),
      export: node("export", [again]),
    });
    expect(collectNotices(cells)).toEqual([SHORT, other]);
  });
});
