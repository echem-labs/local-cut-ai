/**
 * U3's session depth. What is pinned and why:
 *
 * - The recipe card renders BEFORE done — mid-render is when you most
 *   wonder what you asked for, and the original only showed outputs.
 * - The seam preview is pure seek math over an audio element; the joint
 *   (end → start) is what assembly actually loops.
 * - The takes strip talks to select_take with the recorded hash — a
 *   metadata swap, not a re-render, when the artifact survives.
 * - "Add to project" offers real projects only; a tool output inside
 *   another tool session helps nobody.
 * - The clone picker cannot upload until the consent affirmation is
 *   checked — the UI half of the engine's voice_consent stamp.
 * - Reroll pins a fresh seed in the same call (RegenerateBody.seed).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Board, NodeState, Project, TakeInfo } from "../api/types";
import { useApp } from "../store";
import { SEAM_SECONDS, ToolSession, playSeam, seamPlan } from "./ToolSession";

const node = (id: string, over: Partial<NodeState> = {}): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 7,
  model: null,
  pinned: false,
  ...over,
});

const project = (id: string, mode: string, title: string): Project =>
  ({ id, title, created_at: 0, updated_at: 0, mode, approvals: [] }) as Project;

function mountSession(tool: string, toolNode: NodeState, extra: Record<string, unknown> = {}) {
  useApp.setState({
    currentProject: project("p1", `tool:${tool}`, "T"),
    board: { scenes: [], aux: { [tool]: toolNode } } as unknown as Board,
    client: {
      artifactUrl: () => "http://engine/a",
      artifactPeaks: vi.fn().mockRejectedValue(new Error("no peaks in tests")),
    },
    jobs: [],
    allJobs: [],
    projects: [],
    actionError: null,
    ...extra,
  } as never);
  return render(<ToolSession />);
}

describe("the recipe card", () => {
  it("shows the prompt and input chips while the node still renders", () => {
    mountSession(
      "clip",
      node("clip", {
        status: "rendering",
        progress: 0.42,
        artifact_hash: null,
        params: {
          prompt: "A hummingbird at a red flower",
          motion: "slow push-in toward the subject",
          duration_s: 5,
          aspect: "16:9",
        },
      }),
    );
    expect(screen.getByText("A hummingbird at a red flower")).toBeInTheDocument();
    expect(screen.getByText("slow push-in toward the subject")).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.getByText("16:9")).toBeInTheDocument();
  });

  it("labels voiceover input as text, not prompt", () => {
    mountSession("voiceover", node("voiceover", { params: { text: "Hello there", voice: "deep" } }));
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText("deep")).toBeInTheDocument();
  });
});

describe("the loop seam", () => {
  it("plays the last two seconds, then the first two, then stops", () => {
    const listeners: Record<string, () => void> = {};
    const audio = {
      currentTime: 0,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      removeEventListener: vi.fn(),
    } as unknown as HTMLAudioElement;
    const done = vi.fn();

    playSeam(audio, 60, done);
    expect(audio.currentTime).toBe(60 - SEAM_SECONDS);
    expect(audio.play).toHaveBeenCalledTimes(1);

    listeners.ended(); // the joint: the tail ran out
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);

    audio.currentTime = SEAM_SECONDS + 0.1;
    listeners.timeupdate();
    expect(audio.pause).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it("has no distinct joint on a track shorter than two seams", () => {
    expect(seamPlan(3)).toBeNull();
    expect(seamPlan(60)).toEqual({ start: 58, tailS: 2 });
    expect(seamPlan(Number.NaN)).toBeNull();
  });

  it("is offered on music sessions", () => {
    mountSession("music", node("music", { params: { brief: "lo-fi beat" } }));
    expect(screen.getByText("Play the loop seam")).toBeInTheDocument();
  });
});

describe("the takes strip", () => {
  const takes: TakeInfo[] = [
    { output_hash: "h-old", seed: 7, model: null, at: 1, available: true, current: false },
    { output_hash: "h-now", seed: 8, model: null, at: null, available: true, current: true },
  ];

  it("swaps to a recorded take through select_take", () => {
    const selectTake = vi.fn().mockResolvedValue(null);
    mountSession("image", node("image", { params: { prompt: "waves" }, takes }), { selectTake });
    // Scoped: the image status row shows the live seed too.
    const strip = screen.getByRole("group", { name: "Recorded takes" });
    fireEvent.click(within(strip).getByText("seed 7"));
    expect(selectTake).toHaveBeenCalledWith("image", "h-old");
  });

  it("marks the current take and refuses to re-select it", () => {
    const selectTake = vi.fn();
    mountSession("image", node("image", { params: { prompt: "waves" }, takes }), { selectTake });
    const current = screen.getByLabelText("Take with seed 8 — current");
    expect(current).toBeDisabled();
  });

  it("does not render for a single recorded row", () => {
    mountSession("image", node("image", { params: { prompt: "waves" }, takes: [takes[1]] }));
    expect(screen.queryByText("Takes")).toBeNull();
  });

  it("surfaces the engine's refusal when a take is gone", async () => {
    const selectTake = vi.fn().mockResolvedValue("that take fell off the record");
    mountSession("image", node("image", { params: { prompt: "waves" }, takes }), { selectTake });
    const strip = screen.getByRole("group", { name: "Recorded takes" });
    fireEvent.click(within(strip).getByText("seed 7"));
    expect(await screen.findByText("that take fell off the record")).toBeInTheDocument();
  });
});

describe("add to project", () => {
  it("offers real projects, newest first — never tool sessions", () => {
    mountSession("image", node("image", { params: { prompt: "waves" } }), {
      projects: [
        project("t1", "tool:music", "a beat"),
        { ...project("v1", "prompt", "Older video"), updated_at: 10 },
        { ...project("v2", "prompt", "Newer video"), updated_at: 20 },
      ],
    });
    fireEvent.click(screen.getByText("Add to project…"));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Newer video", "Older video"]);
  });

  it("reports where the artifact landed", async () => {
    const addToProject = vi.fn().mockResolvedValue(null);
    mountSession("image", node("image", { params: { prompt: "waves" } }), {
      projects: [project("v1", "prompt", "Bee documentary")],
      addToProject,
    });
    fireEvent.click(screen.getByText("Add to project…"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bee documentary" }));
    expect(addToProject).toHaveBeenCalledWith("v1");
    expect(await screen.findByText('Added to "Bee documentary"')).toBeInTheDocument();
  });

  it("is not offered on script sessions — they promote instead", () => {
    useApp.setState({ jobs: [] } as never);
    mountSession("script", node("script", { params: { prompt: "octopus hearts" } }));
    expect(screen.queryByText("Add to project…")).toBeNull();
    expect(screen.getByText("Turn into a video")).toBeInTheDocument();
  });
});

describe("the clone picker", () => {
  it("keeps the sample chooser behind the consent affirmation", () => {
    mountSession("voiceover", node("voiceover", { params: { text: "hello" } }));
    fireEvent.click(screen.getByText("Clone a voice…"));
    const choose = screen.getByText("Choose a sample…");
    expect(choose).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(choose).not.toBeDisabled();
  });
});

describe("the seeded reroll", () => {
  it("pins a fresh seed in the regenerate call itself", () => {
    const regenerate = vi.fn().mockResolvedValue(undefined);
    mountSession("image", node("image", { params: { prompt: "waves" } }), { regenerate });
    fireEvent.click(screen.getByText("Reroll"));
    expect(regenerate).toHaveBeenCalledTimes(1);
    const [nodeId, seed] = regenerate.mock.calls[0];
    expect(nodeId).toBe("image");
    expect(typeof seed).toBe("number");
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("shows the seed the render used", () => {
    mountSession("image", node("image", { params: { prompt: "waves" }, seed: 4242 }));
    expect(screen.getByText("seed 4242")).toBeInTheDocument();
  });
});
