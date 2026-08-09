/** The Inspector's takes row: alternate versions a regenerate displaced.
 * Chips appear only when there is more than one identity to choose from,
 * the current one is marked and inert, and clicking another sends the
 * select_take patch through the store.
 *
 * Each take now carries a second control beside its chip (reroll on this
 * take's seed — see Inspector.reroll.test.tsx), so "every button in the
 * group" is no longer "every take". These read `.chip` explicitly rather
 * than indexing `querySelectorAll("button")`, which silently addressed the
 * wrong element the moment a second control appeared. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState, TakeInfo } from "../api/types";
import { Inspector } from "./Inspector";
import { useApp } from "../store";

const take = (
  hash: string,
  current: boolean,
  available = true,
  model: string | null = null,
): TakeInfo => ({
  output_hash: hash,
  seed: 1,
  model,
  at: current ? null : 1,
  available,
  current,
});

const node = (id: string, takes?: TakeInfo[]): NodeState => ({
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
});

const boardWith = (takes?: TakeInfo[]): Board => ({
  scenes: [
    { scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip", takes), narration: null },
  ],
  aux: {},
});

/** The take chips only — not the reroll control that now sits beside each
 * one. */
const chipsOf = (group: HTMLElement) =>
  Array.from(group.querySelectorAll<HTMLButtonElement>("button.chip"));

/**
 * What a chip's tooltip says.
 *
 * These warnings used to be `title` attributes, readable straight off the
 * element. They are `Tip` bubbles now — the app's own — and a bubble exists
 * only while it is shown, so the chip has to be hovered first. Hovered on
 * the WRAPPER: the current take's chip is disabled, and Chromium delivers no
 * pointer events to a disabled control, which is why the warning moved off
 * `title` in the first place.
 */
const tipOf = (chip: HTMLButtonElement): string => {
  const wrap = chip.closest(".tip-wrap");
  if (!wrap) throw new Error("take chip carries no tooltip");
  fireEvent.mouseEnter(wrap);
  const said = document.querySelector(".tip")?.textContent ?? "";
  fireEvent.mouseLeave(wrap);
  return said;
};

let selectTake: ReturnType<typeof vi.fn>;

function mount(takes?: TakeInfo[]) {
  selectTake = vi.fn().mockResolvedValue(null);
  useApp.setState({
    board: boardWith(takes),
    selectedNode: "s1.clip",
    selectTake,
  } as never);
  render(<Inspector />);
}

beforeEach(() => {
  useApp.setState({ board: null, selectedNode: null } as never);
});

describe("Inspector takes", () => {
  it("renders one chip per take with the current one pressed", () => {
    mount([take("a".repeat(64), false), take("b".repeat(64), true)]);
    const group = screen.getByRole("group", { name: /takes/i });
    const chips = chipsOf(group);
    expect(chips).toHaveLength(2);
    expect(chips[1]).toHaveAttribute("aria-pressed", "true");
    expect(chips[1]).toBeDisabled(); // the current take is not a destination
  });

  it("clicking another take sends its recorded hash", () => {
    mount([take("a".repeat(64), false), take("b".repeat(64), true)]);
    const group = screen.getByRole("group", { name: /takes/i });
    fireEvent.click(chipsOf(group)[0]!);
    expect(selectTake).toHaveBeenCalledWith("s1.clip", "a".repeat(64));
  });

  it("shows nothing until a node has an alternate to offer", () => {
    mount(undefined);
    expect(screen.queryByRole("group", { name: /takes/i })).toBeNull();
  });

  it("says a cloud take bills when its artifact is gone", () => {
    // Only then does selecting it actually re-render: the restored identity
    // no longer resolves to a file in the cache, so the engine queues the
    // job — on the user's own key. The app is the surface where that choice
    // is allowed, but it must not be a surprise.
    mount([
      take("a".repeat(64), false, false, "cloud:kling-2.5"),
      take("b".repeat(64), true, true, null),
    ]);
    const chip = chipsOf(screen.getByRole("group", { name: /takes/i }))[0]!;
    expect(tipOf(chip)).toMatch(/cloud:kling-2\.5/);
    expect(tipOf(chip)).toMatch(/bills again/i);
    expect(chip.className).toContain("billed");
  });

  it("does not warn about a cloud take that is still on disk", () => {
    // The regression: selecting an AVAILABLE take lands on a hash the cache
    // already holds, so nothing is queued and nothing is billed however the
    // take was first rendered. Warning here talked users out of the common
    // case — stepping back to the take they had just left.
    mount([
      take("a".repeat(64), false, true, "cloud:kling-2.5"),
      take("b".repeat(64), true, true, null),
    ]);
    const chip = chipsOf(screen.getByRole("group", { name: /takes/i }))[0]!;
    expect(chip.className).not.toContain("billed");
    expect(tipOf(chip)).not.toMatch(/bills again/i);
  });

  it("does not call a local take billed", () => {
    mount([take("a".repeat(64), false, false, "local:ltx"), take("b".repeat(64), true)]);
    const chip = chipsOf(screen.getByRole("group", { name: /takes/i }))[0]!;
    expect(chip.className).not.toContain("billed");
  });

  it("shows the engine's refusal instead of a chip that does nothing", async () => {
    mount([take("a".repeat(64), false), take("b".repeat(64), true)]);
    selectTake.mockResolvedValue("engine 422: s1.clip has no recorded take");
    fireEvent.click(chipsOf(screen.getByRole("group", { name: /takes/i }))[0]!);
    expect(await screen.findByRole("status")).toHaveTextContent("no recorded take");
  });
});
