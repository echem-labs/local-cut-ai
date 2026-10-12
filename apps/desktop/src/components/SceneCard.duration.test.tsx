/**
 * The length a scene card puts under its picture.
 *
 * It read the clip's `duration_s`, which is one take's planned length. On a
 * real 60 s project the cards said 7.5 s, 6.7 s and 5 s while the timeline
 * strip under them said 21.04, 22.73 and 18.51 s, and the export ran 62.3 s.
 * A number on a scene card reads as the scene's length, so it was off by
 * three times on every split scene.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, NodeStatus, SceneCardModel } from "../api/types";
import copy from "../i18n/en/scene.json";
import { displaySeconds, spokenSeconds } from "../lib/formats";
import { SceneCard } from "./SceneCard";
import { useApp } from "../store";

const node = (id: string, params: Record<string, unknown>, status: NodeStatus = "draft"): NodeState => ({
  node_id: id,
  status,
  progress: 1,
  error: null,
  artifact_hash: null,
  params,
  seed: 0,
  model: null,
  pinned: false,
});

const WORDS = Array.from({ length: 63 }, (_, i) => `word${i}`).join(" ");

const scene = (clip: NodeStatus, narration: string | null): SceneCardModel => ({
  scene_id: "s1",
  keyframe: node("s1.keyframe", {}),
  clip: node("s1.clip", { duration_s: 7.5, take: 1 }, clip),
  clip_takes: [
    node("s1.clip2", { duration_s: 7.5, take: 2 }, clip),
    node("s1.clip3", { duration_s: 7.5, take: 3 }, clip),
  ],
  narration: narration === null ? null : node("s1.narration", { text: narration }),
});

function mount(card: SceneCardModel, assembled?: Record<string, number>) {
  const board: Board = {
    scenes: [card],
    aux: {},
    ...(assembled ? { assembled_durations: assembled } : {}),
  };
  useApp.setState({
    board,
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
    selectedNode: null,
    select: vi.fn(),
    regenerate: vi.fn().mockResolvedValue(null),
    togglePin: vi.fn().mockResolvedValue(null),
    applyNode: vi.fn().mockResolvedValue(null),
  } as never);
  const { container } = render(<SceneCard scene={card} />);
  return {
    under: container.querySelector(".scene-dur")?.textContent,
    badge: container.querySelector(".dur-badge")?.textContent,
  };
}

afterEach(cleanup);

describe("a scene card's length", () => {
  it("is the assembled scene's, the number the timeline shows", () => {
    const { under, badge } = mount(scene("draft", WORDS), { s1: 21.04 });
    expect(under).toBe("21s");
    expect(badge).toBe("21s");
  });

  // Before assembly there is no real number yet, so the card gives the
  // engine's own estimate and marks it as one.
  it("estimates from the narration before assembly", () => {
    const expected = `~${displaySeconds(spokenSeconds(WORDS))}s`;
    const { under, badge } = mount(scene("draft", WORDS));
    expect(under).toBe(expected);
    expect(badge).toBe(expected);
  });

  it("counts every take of a silent scene, queued or not", () => {
    expect(mount(scene("queued", null)).under).toBe("~22.5s");
    cleanup();
    expect(mount(scene("draft", null)).badge).toBe("~22.5s");
  });

  it("keeps the dash while the clip renders", () => {
    expect(mount(scene("rendering", WORDS), { s1: 21.04 }).under).toBe(copy.dash);
  });
});
