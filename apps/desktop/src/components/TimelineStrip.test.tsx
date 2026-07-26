/**
 * What the timeline tells a screen reader.
 *
 * Each block's accessible name is the only description of that scene a
 * non-sighted user gets — the visual pill, its colour and its tooltip are all
 * unavailable to them. It interpolated `clip.status` raw, so it announced the
 * wire value: "skipped", where the pill next to it reads "not needed". Those
 * are opposite readings of the same tile. A skipped keyframe is deliberate
 * ("this scene is conditioned on your photo, nothing to generate"); "skipped"
 * sounds like something went wrong and was passed over.
 *
 * Every other status surface — the pill, the scene card's own aria-label —
 * already resolves through the catalog, which is also what makes the strings
 * translatable at all.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, NodeStatus } from "../api/types";
import status from "../i18n/en/status.json";
import { TimelineStrip } from "./TimelineStrip";
import { useApp } from "../store";

const node = (id: string, nodeStatus: NodeStatus): NodeState => ({
  node_id: id,
  status: nodeStatus,
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 0,
  model: null,
  pinned: nodeStatus === "pinned",
});

const board = (clip: NodeStatus): Board => ({
  scenes: [
    {
      scene_id: "s1",
      keyframe: node("s1.keyframe", "draft"),
      clip: node("s1.clip", clip),
      narration: null,
    },
  ],
  aux: {},
  assembled_durations: { s1: 4 },
});

function mount(clip: NodeStatus) {
  useApp.setState({
    board: board(clip),
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
  } as never);
  return render(<TimelineStrip />);
}

/** The blocks are the only elements whose name starts with "Scene 1," —
 * matching on the catalog word alone would also hit the pill. */
const blockName = (): string => {
  const block = screen.getByRole("button", { name: /^Scene 1,/ });
  return block.getAttribute("aria-label") ?? "";
};

beforeEach(() => {
  useApp.setState({ board: null, currentProject: null, client: null } as never);
  vi.restoreAllMocks();
});

describe("a timeline block's accessible name", () => {
  it("announces a skipped clip the way the rest of the UI reads it", () => {
    mount("skipped");

    expect(blockName()).toContain(status.skipped);
    expect(status.skipped).toBe("not needed"); // the word the pill shows
    expect(blockName()).not.toContain("skipped"); // …not the wire value
  });

  it("goes through the catalog for every status, not just that one", () => {
    // A status whose label happens to equal its id would pass the test above
    // by accident; this is the property that actually holds.
    for (const value of [
      "queued",
      "rendering",
      "draft",
      "final",
      "failed",
    ] as NodeStatus[]) {
      cleanup(); // one strip in the DOM at a time, or the query is ambiguous
      mount(value);
      expect(blockName(), value).toContain(
        status[value as keyof typeof status],
      );
    }
  });
});
