/**
 * The flowchart canvas, as a user reaches it.
 *
 * The interesting behaviour is not "does it draw" — it is that every edit
 * goes through the same graph patch the inspector and the LLM editor use, so
 * the engine's cycle check, consent gate and re-plan all apply here without
 * this component knowing about any of them. A canvas with its own mutation
 * path would quietly bypass all three, and nothing on screen would say so.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, StoryGraph } from "../api/types";
import status from "../i18n/en/status.json";
import { NodeCanvas } from "./NodeCanvas";
import { useApp } from "../store";

const node = (id: string, kind: string) => ({
  id,
  kind,
  params: {},
  seed: 0,
  model: null,
  pinned: false,
  frozen_hash: null,
});

const GRAPH: StoryGraph = {
  version: 1,
  nodes: {
    script: node("script", "script"),
    "s1.keyframe": node("s1.keyframe", "keyframe"),
    "s1.clip": node("s1.clip", "clip"),
  },
  edges: [
    { src: "script", dst: "s1.keyframe", port: "default" },
    { src: "s1.keyframe", dst: "s1.clip", port: "keyframe" },
  ],
};

const BOARD: Board = {
  scenes: [
    {
      scene_id: "s1",
      keyframe: {
        node_id: "s1.keyframe",
        status: "skipped",
        progress: 0,
        error: null,
        artifact_hash: null,
        params: {},
        seed: 0,
        model: null,
        pinned: false,
      },
      clip: {
        node_id: "s1.clip",
        status: "rendering",
        progress: 0.4,
        error: null,
        artifact_hash: null,
        params: {},
        seed: 0,
        model: null,
        pinned: false,
      },
      narration: null,
    },
  ],
  aux: {},
};

function mount(overrides: Partial<ReturnType<typeof useApp.getState>> = {}) {
  useApp.setState({
    graph: GRAPH,
    graphError: null,
    board: BOARD,
    currentProject: { id: "p1", title: "t", approvals: [] },
    selectedNode: null,
    refreshGraph: vi.fn().mockResolvedValue(undefined),
    connectNodes: vi.fn().mockResolvedValue(null),
    disconnectPort: vi.fn().mockResolvedValue(null),
    removeNode: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never);
  return render(<NodeCanvas />);
}

const nodeBox = (id: string) => screen.getByRole("button", { name: new RegExp(`node ${id},`) });

beforeEach(() => {
  useApp.setState({ graph: null, graphError: null, board: null, selectedNode: null } as never);
});

describe("the canvas", () => {
  it("draws a node for every node in the graph", () => {
    mount();

    for (const id of ["script", "s1.keyframe", "s1.clip"]) {
      expect(nodeBox(id)).toBeTruthy();
    }
  });

  it("names each node's render state through the catalog", () => {
    // Same discipline as the timeline strip and the scene card: the raw value
    // is a wire id, and "skipped" reads "not needed" everywhere else.
    mount();

    expect(nodeBox("s1.keyframe").getAttribute("aria-label")).toContain(status.skipped);
    expect(nodeBox("s1.keyframe").getAttribute("aria-label")).not.toContain("skipped");
  });

  it("selects a node into the Details panel rather than owning an editor", () => {
    // The inspector is already the one place a node is edited; a second
    // editor on the canvas would be a second thing to keep in step.
    mount();

    nodeBox("s1.clip").click();

    expect(useApp.getState().selectedNode).toBe("s1.clip");
  });

  it("is reachable without a mouse", async () => {
    mount();
    const box = nodeBox("script");

    box.focus();
    await userEvent.keyboard("{Enter}");

    expect(useApp.getState().selectedNode).toBe("script");
  });

  it("asks before deleting a node, and does nothing if the answer is no", async () => {
    // `add_node` has no UI at all, so a node deleted here cannot be put back:
    // delete `export` and the project can never finish a cut. Backspace on a
    // focused element is a reflex key, which is precisely why the app reserves
    // ConfirmDialog for acts like this one.
    const removeNode = vi.fn().mockResolvedValue(null);
    mount({ removeNode });
    nodeBox("s1.keyframe").focus();

    await userEvent.keyboard("{Backspace}");

    expect(removeNode).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(removeNode).not.toHaveBeenCalled();
  });

  it("deletes through a graph patch once the deletion is confirmed", async () => {
    const removeNode = vi.fn().mockResolvedValue(null);
    mount({ removeNode });
    nodeBox("s1.keyframe").focus();

    await userEvent.keyboard("{Delete}");
    await userEvent.click(screen.getByRole("button", { name: /delete node/i }));

    expect(removeNode).toHaveBeenCalledWith("s1.keyframe");
  });

  it("says why the script node stays instead of offering to delete it", async () => {
    // The engine refuses this one (the rest of the pipeline is rebuilt from
    // it), so a dialog here would ask a question whose only answer is a 422 a
    // round trip later. Same split as the cycle check: the engine's refusal
    // makes it safe, this one makes it explicable while the key is still down.
    const removeNode = vi.fn().mockResolvedValue(null);
    mount({ removeNode });
    nodeBox("script").focus();

    await userEvent.keyboard("{Delete}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(removeNode).not.toHaveBeenCalled();
    expect(screen.getByText(/rebuilt from it/)).toBeTruthy();
  });

  it("keeps every port reachable by exposing it outside the node's own button", async () => {
    // ARIA specifies the children of a `button` as presentational, so a port
    // nested inside one is hidden from assistive technology however reachable
    // it is by Tab — and the ports are the only way to disconnect an edge and
    // the only drop target for a wire.
    mount();
    const port = screen.getByRole("button", { name: /keyframe input of s1\.clip/ });
    const output = screen.getByRole("button", { name: "output of s1.clip" });

    for (const control of [port, output]) {
      expect(control.closest("button")).toBe(control);
      expect(control.closest('[role="button"]')).toBeNull();
    }
  });

  it("frees an occupied input when its port is clicked", async () => {
    const disconnectPort = vi.fn().mockResolvedValue(null);
    mount({ disconnectPort });

    // s1.clip's `keyframe` port is the one holding an edge.
    await userEvent.click(screen.getByRole("button", { name: /keyframe input of s1\.clip/ }));

    expect(disconnectPort).toHaveBeenCalledWith("s1.clip", "keyframe");
  });

  it("does not select the node when its port is clicked", async () => {
    // The port sits inside the node box; without stopPropagation a
    // disconnect would also change the selection, opening Details on
    // something the user did not ask about.
    mount();

    await userEvent.click(screen.getByRole("button", { name: /keyframe input of s1\.clip/ }));

    expect(useApp.getState().selectedNode).toBeNull();
  });

  it("keeps a freed port as a drop target so the unwire can be undone", async () => {
    // Ports are derived from the edges a node HAS, which made this a one-way
    // door: unwire s1.clip's `keyframe` and the port stops being drawn, so
    // the only target left is `default` — which the clip backends ignore, and
    // the scene then renders with no conditioning image and no error.
    const disconnectPort = vi.fn().mockResolvedValue(null);
    const withoutEdge: StoryGraph = {
      ...GRAPH,
      edges: GRAPH.edges.filter((edge) => edge.port !== "keyframe"),
    };
    mount({ disconnectPort });

    await userEvent.click(screen.getByRole("button", { name: /keyframe input of s1\.clip/ }));
    // The engine agreed, so the next refresh brings back a graph without it.
    await act(async () => {
      useApp.setState({ graph: withoutEdge } as never);
    });

    expect(screen.getByRole("button", { name: /keyframe input of s1\.clip/ })).toBeTruthy();
  });

  it("does not keep a port the engine refused to free", async () => {
    // Only a disconnect the engine accepted is remembered — otherwise a
    // refused unwire would leave a port drawn that no edge ever vacated.
    const disconnectPort = vi.fn().mockResolvedValue("nope");
    const barePorts: StoryGraph = { ...GRAPH, nodes: GRAPH.nodes, edges: [] };
    mount({ disconnectPort });

    await userEvent.click(screen.getByRole("button", { name: /keyframe input of s1\.clip/ }));
    await act(async () => {
      useApp.setState({ graph: barePorts } as never);
    });

    expect(screen.queryByRole("button", { name: /keyframe input of s1\.clip/ })).toBeNull();
  });

  it("fetches the graph on mount", () => {
    const refreshGraph = vi.fn().mockResolvedValue(undefined);
    mount({ refreshGraph });

    expect(refreshGraph).toHaveBeenCalled();
  });
});

describe("wiring", () => {
  /** Drag from `src`'s output onto `dst`'s `port`. */
  async function dragWire(src: string, dst: string, port: string) {
    const user = userEvent.setup();
    await user.pointer([
      { keys: "[MouseLeft>]", target: screen.getByRole("button", { name: `output of ${src}` }) },
      {
        target: screen.getByRole("button", {
          name: new RegExp(`${port} input of ${dst.replace(".", "\\.")}`),
        }),
      },
      { keys: "[/MouseLeft]" },
    ]);
  }

  it("sends a connect patch when a wire lands on a port", async () => {
    const connectNodes = vi.fn().mockResolvedValue(null);
    mount({ connectNodes });

    await dragWire("script", "s1.clip", "keyframe");

    expect(connectNodes).toHaveBeenCalledWith("script", "s1.clip", "keyframe");
  });

  it("refuses a wire that would loop, without asking the engine", async () => {
    // The engine's check is what makes this safe; refusing here is what makes
    // it explicable. A wire accepted, sent and 422'd a round trip later tells
    // the user nothing at the moment they were looking at it.
    const connectNodes = vi.fn().mockResolvedValue(null);
    mount({ connectNodes });

    // s1.clip is downstream of s1.keyframe, so feeding it back in closes the
    // loop. (`script` is not the target here: a root kind offers no input
    // port at all, so there would be nothing to drop on.)
    await dragWire("s1.clip", "s1.keyframe", "main");

    expect(connectNodes).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/loop back into itself/)).toBeTruthy());
  });

  it("shows the engine's reason when it refuses one", async () => {
    const connectNodes = vi.fn().mockResolvedValue("voice_ref accepts only a consented sample");
    mount({ connectNodes });

    await dragWire("script", "s1.clip", "keyframe");

    await waitFor(() => expect(screen.getByText(/consented sample/)).toBeTruthy());
  });
});

describe("when the graph cannot be read", () => {
  it("offers a reload instead of an empty canvas", () => {
    mount({ graph: null, graphError: "engine unreachable" } as never);

    expect(screen.getByText("engine unreachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
  });

  it("keeps the graph on screen when a refresh fails", () => {
    // Losing the picture is a worse outcome than showing a stale one: the
    // user was reading it, and the failure is about the fetch, not the graph.
    mount({ graphError: "engine unreachable" });

    expect(nodeBox("script")).toBeTruthy();
  });

  it("says so for a project with no nodes at all", () => {
    mount({ graph: { version: 1, nodes: {}, edges: [] } });

    expect(screen.getByText(/no graph yet/i)).toBeTruthy();
  });
});
