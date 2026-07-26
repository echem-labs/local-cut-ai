/**
 * The trim fields in the Inspector's Advanced section.
 *
 * Both bounds are edited through one `patchTrim(inValue, outValue)` call that
 * re-sends the WHOLE trim, so whatever it decides an empty box means is what
 * the engine is told about the *other* bound too. That coupling is the bug
 * farm: reading empty as "not loaded yet" made a trim unremovable, and
 * reading it as "cleared" without seeding the fields from the server first
 * made editing one bound wipe the other. Both readings are pinned here.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState } from "../api/types";
import { Inspector } from "./Inspector";
import { useApp } from "../store";

const node = (id: string, params: Record<string, unknown> = {}): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params,
  seed: 0,
  model: null,
  pinned: false,
});

const boardWith = (trims: Record<string, { in?: number; out?: number }>): Board => ({
  scenes: [{ scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null }],
  aux: { timeline: node("timeline", { trims }) },
});

let applyTimeline: ReturnType<typeof vi.fn>;

/** Mount the Inspector with a scene selected and a timeline carrying `trims`. */
function mount(trims: Record<string, { in?: number; out?: number }>) {
  applyTimeline = vi.fn();
  useApp.setState({
    board: boardWith(trims),
    selectedNode: "s1.clip",
    applyTimeline,
  } as never);
  const view = render(<Inspector />);
  // Trim lives behind the Advanced disclosure.
  fireEvent.click(screen.getByText(/advanced/i));
  return view;
}

const trimFields = () => {
  const spin = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  // The trim pair is identified by its current values rather than by order,
  // so an added numeric field elsewhere in Advanced cannot silently retarget
  // these tests at the wrong inputs.
  return { inBox: spin[spin.length - 2]!, outBox: spin[spin.length - 1]! };
};

beforeEach(() => {
  useApp.setState({ board: null, selectedNode: null } as never);
});

describe("clearing a trim", () => {
  it("removes the scene's trim when both boxes are emptied", () => {
    mount({ s1: { in: 2, out: 6 } });
    const { inBox, outBox } = trimFields();
    expect(inBox.value).toBe("2");
    expect(outBox.value).toBe("6");

    fireEvent.change(inBox, { target: { value: "" } });
    fireEvent.change(outBox, { target: { value: "" } });

    // The last patch is the one the engine keeps: no entry for s1 at all.
    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: {} });
  });

  it("drops only the bound that was emptied", () => {
    // The regression: falling back to the stored value here re-sent `in: 2`,
    // so the box read empty while the engine kept trimming — and no input
    // anywhere could remove a trim.
    mount({ s1: { in: 2, out: 6 } });
    fireEvent.change(trimFields().inBox, { target: { value: "" } });

    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: { s1: { out: 6 } } });
  });
});

describe("editing one bound", () => {
  it("keeps the other, which is only true because both are seeded", () => {
    // The failure this guards: if the fields were not seeded from the server,
    // `outValue` would be "" here and editing the in-point would silently
    // erase the out-point.
    mount({ s1: { in: 2, out: 6 } });
    fireEvent.change(trimFields().inBox, { target: { value: "3" } });

    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: { s1: { in: 3, out: 6 } } });
  });

  it("leaves other scenes' trims untouched", () => {
    mount({ s1: { in: 2, out: 6 }, s2: { in: 1 } });
    fireEvent.change(trimFields().outBox, { target: { value: "5" } });

    expect(applyTimeline).toHaveBeenLastCalledWith({
      trims: { s1: { in: 2, out: 5 }, s2: { in: 1 } },
    });
  });
});

describe("values that are not a trim", () => {
  it("ignores an out-point at or before the in-point", () => {
    // Not a trim, an empty window — and the engine would render nothing.
    mount({ s1: { in: 4 } });
    fireEvent.change(trimFields().outBox, { target: { value: "4" } });

    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: { s1: { in: 4 } } });
  });

  it("ignores a negative in-point", () => {
    mount({ s1: { out: 6 } });
    fireEvent.change(trimFields().inBox, { target: { value: "-3" } });

    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: { s1: { out: 6 } } });
  });

  it("treats a partially typed number as no value yet", () => {
    // patchTrim runs on every keystroke, so "-" and "." are states the user
    // passes through on the way to a real number.
    mount({ s1: { in: 2, out: 6 } });
    fireEvent.change(trimFields().inBox, { target: { value: "." } });

    expect(applyTimeline).toHaveBeenLastCalledWith({ trims: { s1: { out: 6 } } });
  });
});

describe("seeding from the server", () => {
  it("shows an empty pair when the scene has no trim", () => {
    mount({});
    const { inBox, outBox } = trimFields();
    expect(inBox.value).toBe("");
    expect(outBox.value).toBe("");
  });

  it("re-seeds when the board arrives after the first render", () => {
    // The board is null on mount and lands over the websocket a moment later.
    // Without the effect keyed on the stored values, the fields would stay
    // empty and the first edit would clear the trim the user never saw.
    mount({});
    // act(): the store write happens outside React's event loop, exactly as a
    // websocket message does, and the seeding effect runs on the re-render.
    act(() => {
      useApp.setState({ board: boardWith({ s1: { in: 2, out: 6 } }) } as never);
    });

    const { inBox, outBox } = trimFields();
    expect(inBox.value).toBe("2");
    expect(outBox.value).toBe("6");
  });
});
