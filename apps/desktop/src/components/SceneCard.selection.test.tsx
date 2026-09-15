/**
 * A scene card highlights for either of its two picture nodes.
 *
 * The card draws `still ?? keyframe` — the user's image when they supplied
 * one — and the selection check reused that same resolved node. So for a
 * conditioned scene it compared the selection against the ASSET id only,
 * and the generated `{sid}.keyframe` stopped matching anything.
 *
 * That node is still on the graph and still a button on the flowchart, where
 * it is the tile marked "not needed" — `NodeCanvas.statusIndex` walks both
 * slots precisely so it can be drawn. Clicking it highlighted no card at all.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import type { NodeState, NodeStatus, SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { useDropTarget } from "../lib/dropTarget";
import { SceneCard } from "./SceneCard";
import { useApp } from "../store";

const node = (id: string, s: NodeStatus): NodeState => ({
  node_id: id,
  status: s,
  progress: 1,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

/** A scene built on the user's own picture: the asset feeds the clip, and
 *  the generated keyframe is left orphaned and marked "not needed". */
const conditioned: SceneCardModel = {
  scene_id: "s1",
  keyframe: node("s1.keyframe", "skipped"),
  still: node("asset-abc", "final"),
  clip: node("s1.clip", "draft"),
  narration: node("s1.narration", "draft"),
};

function mount(selectedNode: string | null) {
  useApp.setState({
    board: { scenes: [conditioned], aux: {}, assembled_durations: { s1: 4 } },
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
    selectedNode,
    select: vi.fn(),
    regenerate: vi.fn().mockResolvedValue(null),
    togglePin: vi.fn().mockResolvedValue(null),
    applyNode: vi.fn().mockResolvedValue(null),
    playScene: vi.fn(),
  } as never);
  render(<SceneCard scene={conditioned} onDragStart={vi.fn()} />);
  return screen.getByRole("group");
}

afterEach(cleanup);

describe("a card a picture is being dragged over", () => {
  // The window-wide scrim could not say "this one" — it covered the card the
  // answer was about. The card names itself instead, which means it has to
  // read the target from somewhere the drop surface can publish it.
  afterEach(() => useDropTarget.getState().end());

  it("marks itself and says what the drop would do", () => {
    useDropTarget.getState().over("s1");
    const card = mount(null);

    expect(card.className).toContain("drop-target");
    expect(card).toHaveTextContent(t("drop.overlayStill", { n: "1" }));
  });

  it("stays quiet when the pointer is over a different scene", () => {
    useDropTarget.getState().over("s2");
    const card = mount(null);

    expect(card.className).not.toContain("drop-target");
  });

  it("stays quiet when no drag is in the air", () => {
    // A scene id left behind by the last drag must not light a card up.
    useDropTarget.setState({ scene: "s1", dragging: false });
    const card = mount(null);

    expect(card.className).not.toContain("drop-target");
  });
});

describe("a conditioned scene's card", () => {
  it("highlights for the user's image", () => {
    expect(mount("asset-abc").className).toContain("selected");
  });

  it("highlights for the generated keyframe the flowchart still shows", () => {
    expect(mount("s1.keyframe").className).toContain("selected");
  });

  it("highlights for its clip", () => {
    expect(mount("s1.clip").className).toContain("selected");
  });

  it("stays unhighlighted for another scene's node", () => {
    expect(mount("s2.clip").className).not.toContain("selected");
  });
});
