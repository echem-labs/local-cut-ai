/**
 * Borrowing a take's seed for a fresh render.
 *
 * The point is not to reproduce the take — the same seed with the same
 * params hashes to a file already in the cache, so the engine would queue
 * nothing at all. It is to re-roll the CURRENT prompt, motion and model
 * against a seed whose composition the user liked, making the parameter
 * change the only difference between the two renders.
 *
 * `RegenerateBody.seed` does it in one call. Doing it as set_seed then
 * regenerate would leave the node carrying a borrowed seed if the second
 * half failed — a silent edit nobody asked for.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, TakeInfo } from "../api/types";
import { Inspector } from "./Inspector";
import { useApp } from "../store";

const take = (hash: string, seed: number, current = false): TakeInfo => ({
  output_hash: hash,
  seed,
  model: null,
  at: null,
  available: true,
  current,
});

const node = (id: string, takes?: TakeInfo[]): NodeState =>
  ({
    node_id: id,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: "a".repeat(64),
    params: {},
    seed: 0,
    model: null,
    pinned: false,
    takes,
  }) as NodeState;

const mount = (takes: TakeInfo[], extra: Record<string, unknown> = {}) => {
  useApp.setState({
    board: {
      scenes: [
        {
          scene_id: "s1",
          keyframe: node("s1.keyframe"),
          clip: node("s1.clip", takes),
          narration: null,
        },
      ],
      aux: {},
    } as unknown as Board,
    selectedNode: "s1.clip",
    nodeFailures: {},
    nodeRetries: {},
    ...extra,
  } as never);
  render(<Inspector />);
  // The clip's takes live under the Motion tab, which is the default for a
  // selected clip.
  return screen.getByRole("group", { name: /takes/i });
};

beforeEach(() => useApp.setState({ nodeFailures: {}, nodeRetries: {} } as never));

describe("the takes strip", () => {
  it("offers a reroll for every take", () => {
    const strip = mount([take("h1", 111, true), take("h2", 222)]);
    expect(within(strip).getByRole("button", { name: /take 1's seed/i })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: /take 2's seed/i })).toBeInTheDocument();
  });

  it("sends that take's seed, in one call", async () => {
    const rerollWithSeed = vi.fn().mockResolvedValue(null);
    const strip = mount([take("h1", 111, true), take("h2", 222)], { rerollWithSeed });

    await userEvent.click(within(strip).getByRole("button", { name: /take 2's seed/i }));
    expect(rerollWithSeed).toHaveBeenCalledWith("s1.clip", 222);
    expect(rerollWithSeed).toHaveBeenCalledOnce();
  });

  it("offers it on the CURRENT take too", async () => {
    // The take chip itself is disabled when current — switching to where you
    // already are does nothing. Rerolling on its seed is a different act and
    // is exactly what "I liked this one, try my new prompt on it" means.
    const rerollWithSeed = vi.fn().mockResolvedValue(null);
    const strip = mount([take("h1", 111, true), take("h2", 222)], { rerollWithSeed });

    expect(within(strip).getByRole("button", { name: /take 1$/i })).toBeDisabled();
    await userEvent.click(within(strip).getByRole("button", { name: /take 1's seed/i }));
    expect(rerollWithSeed).toHaveBeenCalledWith("s1.clip", 111);
  });

  it("keeps the reroll OUT of the take button", () => {
    // ARIA specifies a button's children as presentational, so a control
    // nested inside the chip would be invisible to a screen reader however
    // reachable it stayed by Tab. Same rule the canvas ports follow.
    const strip = mount([take("h1", 111, true), take("h2", 222)]);
    const chip = within(strip).getByRole("button", { name: /take 2$/i });
    expect(chip.querySelector("button")).toBeNull();
  });

  it("reports a refusal where it happened", async () => {
    const rerollWithSeed = vi.fn().mockResolvedValue("the engine could not be reached");
    const strip = mount([take("h1", 111, true), take("h2", 222)], { rerollWithSeed });

    await userEvent.click(within(strip).getByRole("button", { name: /take 2's seed/i }));
    expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
  });
});
