/**
 * U4 — what the canvas gained: a view transform, node content, chain focus,
 * search, and the first UI for `add_node`.
 *
 * The arithmetic behind three of these lives in lib/canvasView and
 * lib/canvasFocus and is tested there. What is pinned HERE is the wiring: a
 * control reaches the right function, the transform reaches the DOM, and the
 * canvas keeps the constraints it had before (every edit through /patch, no
 * button inside a button).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, StoryGraph } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { NodeCanvas } from "./NodeCanvas";

const node = (id: string, kind: string) => ({
  id,
  kind,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  frozen_hash: null,
});

/** script → s1.keyframe → s1.clip → timeline, with music joining timeline:
 * one node (music) deliberately outside the clip's chain. */
const GRAPH: StoryGraph = {
  version: 1,
  nodes: {
    script: node("script", "script"),
    "s1.keyframe": node("s1.keyframe", "keyframe"),
    "s1.clip": node("s1.clip", "clip"),
    music: node("music", "music"),
    timeline: node("timeline", "timeline"),
  },
  edges: [
    { src: "script", dst: "s1.keyframe", port: "default" },
    { src: "s1.keyframe", dst: "s1.clip", port: "keyframe" },
    { src: "s1.clip", dst: "timeline", port: "default" },
    { src: "music", dst: "timeline", port: "music" },
  ],
};

const state = (over: Record<string, unknown> = {}) => ({
  node_id: "x",
  status: "done",
  progress: 1,
  error: null,
  artifact_hash: null,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  ...over,
});

const BOARD: Board = {
  scenes: [
    {
      scene_id: "s1",
      keyframe: state({ node_id: "s1.keyframe", artifact_hash: "h".repeat(64) }),
      clip: state({ node_id: "s1.clip", status: "rendering", progress: 0.62 }),
      narration: null,
    },
  ],
  aux: {},
} as unknown as Board;

function mount(overrides: Record<string, unknown> = {}) {
  useApp.setState({
    graph: GRAPH,
    graphError: null,
    board: BOARD,
    currentProject: { id: "p1", title: "t", approvals: [] },
    selectedNode: null,
    client: { artifactUrl: (pid: string, hash: string) => `http://engine/${pid}/${hash}` },
    refreshGraph: vi.fn().mockResolvedValue(undefined),
    connectNodes: vi.fn().mockResolvedValue(null),
    disconnectPort: vi.fn().mockResolvedValue(null),
    removeNode: vi.fn().mockResolvedValue(null),
    addNode: vi.fn().mockResolvedValue(null),
    select: vi.fn((id: string | null) => useApp.setState({ selectedNode: id } as never)),
    ...overrides,
  } as never);
  return render(<NodeCanvas />);
}

const stage = () => document.querySelector(".canvas-stage") as HTMLElement;
const box = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement;

beforeEach(() => {
  useApp.setState({ graph: null, board: null, selectedNode: null } as never);
});

describe("the view transform", () => {
  it("starts at 100% and scales the stage from its top-left", () => {
    mount();
    expect(screen.getByText("100%")).toBeInTheDocument();
    // Origin matters: scaling about the centre moves the graph out from
    // under the scroll offsets that position it.
    expect(stage().style.transform).toBe("scale(1)");
    expect(stage().style.transformOrigin).toBe("0 0");
  });

  it("steps one notch per press of − and +", () => {
    mount();
    fireEvent.click(screen.getByLabelText(t("canvas.zoomOut")));
    expect(screen.getByText("90%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(t("canvas.zoomIn")));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("counts every press, even two in the same tick", () => {
    // A handler that closes over the rendered zoom computes both presses
    // from the same number, so the second one is lost. Real users double-tap
    // −, and a wheel spins several events per frame.
    mount();
    const out = screen.getByLabelText(t("canvas.zoomOut"));
    // Both inside ONE act: fireEvent flushes between calls, which is exactly
    // the batching a browser does not do for you. Two clicks in a single
    // task are one React batch, and that is where the stale read lives.
    act(() => {
      out.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      out.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("shrinks the scrollable area with the zoom", () => {
    // A transform does not change the layout box, so the surface kept
    // scrolling over the FULL-SIZE graph however far it was zoomed out —
    // "Fit" left a scrollbar and a screenful of empty space.
    mount();
    const sizer = document.querySelector(".canvas-sizer") as HTMLElement;
    const before = Number.parseFloat(sizer.style.width);
    fireEvent.click(screen.getByLabelText(t("canvas.zoomOut")));
    expect(Number.parseFloat(sizer.style.width)).toBeLessThan(before);
  });

  it("zooms on ctrl+wheel and leaves a plain wheel to scroll the surface", () => {
    mount();
    const surface = document.querySelector(".canvas-surface") as HTMLElement;

    fireEvent.wheel(surface, { deltaY: -240, ctrlKey: true });
    expect(screen.queryByText("100%")).toBeNull();

    const zoomed = (document.querySelector(".canvas-zoom-value") as HTMLElement).textContent;
    // A bare wheel is the scroll gesture the surface already had; hijacking
    // it would make the graph unscrollable with a plain mouse.
    fireEvent.wheel(surface, { deltaY: -240 });
    expect((document.querySelector(".canvas-zoom-value") as HTMLElement).textContent).toBe(zoomed);
  });

  it("actually refuses the browser's own ctrl+wheel zoom", () => {
    // React registers `wheel` on the root container as a PASSIVE listener,
    // so preventDefault inside an onWheel handler is ignored: Chromium logs
    // the violation as a console error and zooms the whole app underneath a
    // canvas that is also zooming. Only the element's own listener,
    // registered { passive: false }, can refuse it.
    mount();
    const surface = document.querySelector(".canvas-surface") as HTMLElement;
    const event = new WheelEvent("wheel", {
      deltaY: -240,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      surface.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("fits the graph to the panel", () => {
    mount();
    const surface = document.querySelector(".canvas-surface") as HTMLElement;
    // jsdom gives every element a zero box, so state the viewport outright.
    vi.spyOn(surface, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(surface, "clientHeight", "get").mockReturnValue(300);

    fireEvent.click(screen.getByLabelText(t("canvas.zoomFit")));

    // The layout is wider than 400px, so Fit lands below 100%.
    const shown = (document.querySelector(".canvas-zoom-value") as HTMLElement).textContent!;
    expect(Number.parseInt(shown, 10)).toBeLessThan(100);
  });
});

describe("node content", () => {
  it("shows the artifact inside a keyframe node", () => {
    mount();
    // Queried by class, not by role: the thumb is decorative — the node's
    // own button already says which node this is, so naming the image would
    // read the id twice.
    const thumb = box("s1.keyframe").querySelector("img")!;
    expect(thumb).toHaveAttribute("src", `http://engine/p1/${"h".repeat(64)}`);
    expect(thumb).toHaveAttribute("alt", "");
  });

  it("shows no image on a still-kind node that has not rendered yet", () => {
    // s1.keyframe with its artifact taken away: the node is the same kind,
    // so what decides is the artifact, not the kind.
    mount({
      board: {
        ...BOARD,
        scenes: [{ ...BOARD.scenes[0]!, keyframe: state({ node_id: "s1.keyframe" }) }],
      },
    });
    expect(box("s1.keyframe").querySelector("img")).toBeNull();
  });

  it("never shows one on a kind whose artifact needs a player", () => {
    // A clip's artifact is an mp4 and a narration's a wav — the Details
    // panel and the storyboard are what those are for.
    mount();
    expect(box("s1.clip").querySelector("img")).toBeNull();
  });

  it("shows progress on a node that is rendering, and nothing on one that is not", () => {
    mount();
    expect(within(box("s1.clip")).getByText("62%")).toBeInTheDocument();
    expect(within(box("s1.keyframe")).queryByText(/%$/)).toBeNull();
  });
});

describe("chain focus", () => {
  it("dims everything outside the selected node's chain", () => {
    mount({ selectedNode: "s1.clip" });
    // script → keyframe → clip → timeline is the chain; music only shares a
    // destination with it.
    for (const id of ["script", "s1.keyframe", "s1.clip", "timeline"]) {
      expect(box(id).className).not.toMatch(/dimmed/);
    }
    expect(box("music").className).toMatch(/dimmed/);
  });

  it("says what the selection is doing, and how to move around", () => {
    // The two gestures have no affordance to discover them by — ctrl+wheel
    // and drag-to-pan are invisible until tried — so the mock puts them in
    // the corner the graph flows away from.
    mount({ selectedNode: "s1.clip" });
    const legend = document.querySelector(".canvas-legend")!;
    expect(legend.textContent).toContain(t("canvas.chainOf", { id: "s1.clip" }));
    expect(legend.textContent).toContain(t("canvas.panHint"));
  });

  it("drops the chain line when there is no selection to describe", () => {
    mount();
    const legend = document.querySelector(".canvas-legend")!;
    expect(legend.querySelector("b")).toBeNull();
    expect(legend.textContent).toContain(t("canvas.panHint"));
  });

  it("dims nothing when nothing is selected", () => {
    mount();
    expect(document.querySelectorAll(".canvas-node.dimmed")).toHaveLength(0);
  });

  it("clears the selection on Escape", () => {
    const select = vi.fn();
    mount({ selectedNode: "s1.clip", select });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(select).toHaveBeenCalledWith(null);
  });

  it("clears it on a click on empty space, which is where Escape's hand is not", () => {
    const select = vi.fn();
    mount({ selectedNode: "s1.clip", select });
    const surface = document.querySelector(".canvas-surface") as HTMLElement;

    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 10, clientY: 10 });

    expect(select).toHaveBeenCalledWith(null);
  });

  it("keeps it through a pan, which starts with the same press", () => {
    // Drag-to-pan and click-to-clear are one gesture until the pointer
    // moves. Clearing at the end of a pan would make the canvas unusable
    // with a mouse: every drag would drop the focus being read.
    const select = vi.fn();
    mount({ selectedNode: "s1.clip", select });
    const surface = document.querySelector(".canvas-surface") as HTMLElement;

    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(surface, { clientX: 90, clientY: 40 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 90, clientY: 40 });

    expect(select).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when a press lands on a node", () => {
    // The node's own button owns that click; the surface must not clear the
    // selection out from under it.
    const select = vi.fn();
    mount({ selectedNode: "s1.clip", select });
    const surface = document.querySelector(".canvas-surface") as HTMLElement;

    fireEvent.pointerDown(box("music"), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(surface, { button: 0, clientX: 10, clientY: 10 });

    expect(select).not.toHaveBeenCalledWith(null);
  });
});

describe("canvas search", () => {
  it("marks the matches and says how many there are", () => {
    mount();
    fireEvent.change(screen.getByLabelText(t("canvas.searchAria")), { target: { value: "s1" } });
    expect(document.querySelectorAll(".canvas-node.match")).toHaveLength(2);
    expect(screen.getByText(t("canvas.matches_other", { count: 2 }))).toBeInTheDocument();
  });

  it("jumps to the first match on Enter, then walks the rest", () => {
    const select = vi.fn();
    mount({ select });
    const search = screen.getByLabelText(t("canvas.searchAria"));
    fireEvent.change(search, { target: { value: "s1" } });

    fireEvent.keyDown(search, { key: "Enter" });
    expect(select).toHaveBeenLastCalledWith("s1.clip"); // code-unit order

    fireEvent.keyDown(search, { key: "Enter" });
    expect(select).toHaveBeenLastCalledWith("s1.keyframe");

    // …and wraps, so Enter is never a dead key.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(select).toHaveBeenLastCalledWith("s1.clip");
  });

  it("says so when a query matches nothing", () => {
    mount();
    fireEvent.change(screen.getByLabelText(t("canvas.searchAria")), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(t("canvas.noMatches"))).toBeInTheDocument();
  });
});

describe("add node", () => {
  it("offers the five kinds a person can usefully add", () => {
    mount();
    fireEvent.click(screen.getByText(t("canvas.addNode")));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toHaveLength(5);
    expect(items[0]).toContain(t("canvas.kinds.keyframe"));
  });

  it("adds through the store's patch-building action, not a private path", () => {
    const addNode = vi.fn().mockResolvedValue(null);
    mount({ addNode });
    fireEvent.click(screen.getByText(t("canvas.addNode")));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(t("canvas.kinds.music")) }));
    expect(addNode).toHaveBeenCalledWith("music");
  });

  it("closes on a press outside it, like every other menu in the app", () => {
    mount();
    fireEvent.click(screen.getByText(t("canvas.addNode")));
    expect(screen.getAllByRole("menuitem")).toHaveLength(5);

    fireEvent.mouseDown(document.querySelector(".canvas-surface") as HTMLElement);

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("closes on Escape, and lets the selection alone while it does", () => {
    // Two things answered one key: the menu stayed open and the selection —
    // the thing Escape was NOT aimed at — was what went.
    const select = vi.fn();
    mount({ selectedNode: "s1.clip", select });
    fireEvent.click(screen.getByText(t("canvas.addNode")));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("reports a refusal in the bar instead of silently doing nothing", async () => {
    const addNode = vi.fn().mockResolvedValue("the graph is locked");
    mount({ addNode });
    fireEvent.click(screen.getByText(t("canvas.addNode")));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(t("canvas.kinds.clip")) }));
    expect(await screen.findByText("the graph is locked")).toBeInTheDocument();
  });
});

describe("removing a node", () => {
  it("offers a control, not only a key", () => {
    // Backspace on a focused node was the only way to delete one, which is
    // a thing you have to be told rather than find.
    mount();
    const remove = within(box("music")).getByLabelText(
      t("canvas.actions.remove", { id: "music" }),
    );
    fireEvent.click(remove);
    expect(screen.getByText(t("canvas.confirmDelete.title", { id: "music" }))).toBeInTheDocument();
  });

  it("keeps it a sibling of the node's own button, never inside it", () => {
    // ARIA specifies a button's children as presentational: nested, the
    // delete would vanish from assistive tech however reachable by Tab.
    mount();
    const remove = within(box("music")).getByLabelText(
      t("canvas.actions.remove", { id: "music" }),
    );
    expect(remove.closest("button")).toBe(remove);
  });
});

describe("the search field", () => {
  it("keeps one width whether it is empty, matching or not matching", () => {
    // It used to grow when you typed and grow again when the tally changed
    // length — a text box resizing under the cursor mid-word.
    mount();
    const field = document.querySelector(".canvas-search") as HTMLElement;
    const input = screen.getByLabelText(t("canvas.searchAria"));
    // jsdom has no layout, so the property under test is structural: the
    // tally is not inside the box whose width is fixed in CSS.
    expect(field.querySelector(".canvas-search-count")).toBeNull();

    fireEvent.change(input, { target: { value: "s1" } });
    expect(field.querySelector(".canvas-search-count")).toBeNull();
    expect(document.querySelector(".canvas-bar > .canvas-search-count")).not.toBeNull();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(field.querySelector(".canvas-search-count")).toBeNull();
  });
});
