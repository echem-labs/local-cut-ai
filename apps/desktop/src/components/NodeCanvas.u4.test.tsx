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
    const thumb = within(box("s1.keyframe")).getByRole("img");
    expect(thumb).toHaveAttribute("src", `http://engine/p1/${"h".repeat(64)}`);
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

  it("reports a refusal in the bar instead of silently doing nothing", async () => {
    const addNode = vi.fn().mockResolvedValue("the graph is locked");
    mount({ addNode });
    fireEvent.click(screen.getByText(t("canvas.addNode")));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(t("canvas.kinds.clip")) }));
    expect(await screen.findByText("the graph is locked")).toBeInTheDocument();
  });
});
