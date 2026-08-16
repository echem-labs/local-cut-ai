/**
 * Taking a scene out of the cut.
 *
 * The board could add a scene and never remove one — the only way out was to
 * ask the NL editor in words. The card grows the missing verb, and the two
 * rules it enforces on the spot are here: a pinned scene refuses (a pin is
 * the app's word for "leave this alone", so asking a question the engine
 * will decline is worse than saying no now), and the card never removes
 * anything itself — it asks the board, which still exists after the card
 * has gone and can therefore report a refusal.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { NodeState, SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { SceneCard } from "./SceneCard";
import { useApp } from "../store";

const node = (id: string, over: Partial<NodeState> = {}): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  ...over,
});

const scene = (over: Partial<SceneCardModel> = {}): SceneCardModel => ({
  scene_id: "s2",
  keyframe: node("s2.keyframe"),
  clip: node("s2.clip"),
  narration: node("s2.narration"),
  ...over,
});

function mount(model: SceneCardModel, onRemove?: () => void) {
  useApp.setState({
    board: { scenes: [model], aux: {}, assembled_durations: { s2: 4 } },
    currentProject: { id: "p1", title: "t", approvals: [] },
    client: { artifactUrl: () => "" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  render(<SceneCard scene={model} onRemove={onRemove} />);
}

const removeButton = () =>
  screen.getByRole("button", { name: t("scene.actions.remove.aria", { n: "2" }) });

describe("removing a scene from the board", () => {
  it("asks the board rather than removing anything itself", async () => {
    const onRemove = vi.fn();
    mount(scene(), onRemove);
    await userEvent.click(removeButton());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("refuses on a pinned scene, where the engine would refuse anyway", () => {
    mount(scene({ clip: node("s2.clip", { pinned: true }) }), vi.fn());
    expect(removeButton()).toBeDisabled();
  });

  it("is absent where the board offers no removal", () => {
    mount(scene());
    expect(
      screen.queryByRole("button", { name: t("scene.actions.remove.aria", { n: "2" }) }),
    ).toBeNull();
  });
});
