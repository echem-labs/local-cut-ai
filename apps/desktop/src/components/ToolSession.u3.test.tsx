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

function mountSession(
  tool: string,
  toolNode: NodeState,
  extra: Record<string, unknown> = {},
  title = "T",
) {
  useApp.setState({
    currentProject: project("p1", `tool:${tool}`, title),
    board: { scenes: [], aux: { [tool]: toolNode } } as unknown as Board,
    client: {
      artifactUrl: () => "http://engine/a",
      artifactPeaks: vi.fn().mockRejectedValue(new Error("no peaks in tests")),
      // The voiceover window offers the voice picker, which asks the engine
      // what the pack holds the moment it mounts.
      voices: vi.fn().mockResolvedValue({ available: false, voices: [], default: null }),
      voicePreviewUrl: (id: string) => `http://engine/voices/${id}/preview`,
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

  it("hands the done voiceover text to the composer, chips to the status row", () => {
    const { container } = mountSession(
      "voiceover",
      node("voiceover", { params: { text: "Hello there", voice: "deep" } }),
    );
    // Done session: the composer is the text's home, the status row is the
    // chips' — no card is left holding only an eyebrow and two badges.
    expect(container.querySelector(".session-recipe")).toBeNull();
    const status = container.querySelector(".tool-status") as HTMLElement;
    expect(within(status).getByText("deep")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Edit this session's prompt") as HTMLTextAreaElement).value,
    ).toBe("Hello there");
  });

  it("does not repeat the prompt the page title already is", () => {
    // Tool projects are titled by their own ask — the run's other inputs
    // read from the status row, not from a card echoing the h1.
    const { container } = mountSession(
      "image",
      node("image", { params: { prompt: "T", aspect: "16:9" } }),
    );
    expect(container.querySelector(".session-recipe")).toBeNull();
    const status = container.querySelector(".tool-status") as HTMLElement;
    expect(within(status).getByText("16:9")).toBeInTheDocument();
  });

  it("hides the script's own heading when the page title merely extends it", async () => {
    // The engine titles the screenplay from a truncated prompt while the
    // project keeps the full ask — "…the next video" under "…the next
    // video. on snake" is still the same words twice at heading weight.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            title: "A strong hook, clear sections",
            hook: "It starts with a question.",
            scenes: [{ id: "s1", narration: "One clue.", visual: "v", duration_s: 3 }],
          }),
      }),
    );
    try {
      const { container } = mountSession(
        "script",
        node("script", { params: { prompt: "A strong hook, clear sections. on snake" } }),
        {},
        "A strong hook, clear sections. on snake",
      );
      await screen.findByText("It starts with a question.");
      expect(container.querySelector(".script-view h2")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the composer", () => {
  it("holds the recipe as an editable working copy and re-renders the edit", async () => {
    const refineTool = vi.fn().mockResolvedValue(null);
    mountSession(
      "music",
      node("music", { params: { brief: "lofi beat" } }),
      { refineTool },
    );
    const box = screen.getByLabelText("Edit this session's prompt") as HTMLTextAreaElement;
    expect(box.value).toBe("lofi beat");
    // Unchanged text is not an update.
    const button = screen.getByText("Update & re-render") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "lofi beat, warmer keys" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(refineTool).toHaveBeenCalledWith("music", { brief: "lofi beat, warmer keys" }),
    );
  });

  it("wears Home's prompt-box dress: a model popover, no settings link", () => {
    const { container } = mountSession("music", node("music", { params: { brief: "lofi beat" } }));
    // The composer is the same surface Home's prompt box is — the model
    // question is answered by the same popover, not a settings deep-link.
    expect(container.querySelector(".tool-composer.prompt-box")).not.toBeNull();
    expect(screen.getByLabelText("Model readiness")).toBeInTheDocument();
    expect(screen.queryByText("Change model…")).toBeNull();
  });

  it("keeps the LLM enhance flow for scripts", () => {
    mountSession("script", node("script", { params: { prompt: "T" } }));
    expect(
      screen.getByLabelText("Feedback for the script rewrite"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Update & re-render")).toBeNull();
  });
});

describe("the action row", () => {
  // Every action here is destructive-ish or slow (a re-render, a copy into
  // another project) — the verb alone doesn't say what it costs or keeps.
  const hovering = (name: string) => {
    const wrap = screen.getByText(name).closest(".tip-wrap") as HTMLElement;
    fireEvent.mouseEnter(wrap);
    const text = document.querySelector(".tip")?.textContent ?? "";
    fireEvent.mouseLeave(wrap); // else the next hover reads this bubble
    return text;
  };

  it("explains what each button will do, on hover", () => {
    mountSession("image", node("image", { params: { prompt: "waves" } }), {
      projects: [project("v1", "prompt", "Bee documentary")],
    });
    expect(hovering("Download")).toContain("saves");
    expect(hovering("Regenerate")).toContain("take");
    expect(hovering("Reroll")).toContain("seed");
    expect(hovering("Add to project…")).toContain("asset");
  });

  it("explains the script session's own two actions", () => {
    mountSession("script", node("script", { params: { prompt: "octopus hearts" } }));
    expect(hovering("Turn into a video")).toContain("project");
  });

  it("explains the voiceover clone action", () => {
    mountSession("voiceover", node("voiceover", { params: { text: "hello" } }));
    expect(hovering("Clone a voice…")).toContain("permission");
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

  it("says whether picking a take costs a render", () => {
    const gone: TakeInfo[] = [{ ...takes[0], available: false }, takes[1]];
    mountSession("image", node("image", { params: { prompt: "waves" }, takes: gone }));
    // Scoped: the image status row carries a "seed 7" chip of its own.
    const strip = screen.getByRole("group", { name: "Recorded takes" });
    const chip = within(strip).getByText("seed 7").closest(".tip-wrap") as HTMLElement;
    fireEvent.mouseEnter(chip);
    expect(document.querySelector(".tip")?.textContent).toContain("renders the seed again");
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

/**
 * Choosing the voice from inside the session.
 *
 * Re-rendering a voiceover in another voice is the reason to be on this
 * page at all, so the choice is the same row Home offers — five swatches
 * with bundled samples and a way into the rest of the pack — rather than a
 * button whose only job is to open a dialog.
 */
describe("the voiceover session's voice row", () => {
  const withPack = {
    client: {
      artifactUrl: () => "http://engine/a",
      artifactPeaks: vi.fn().mockRejectedValue(new Error("no peaks in tests")),
      voices: vi.fn().mockResolvedValue({
        available: true,
        voices: [
          { id: "af_sarah", name: "Sarah", language_code: "en-us", gender: "female" },
          { id: "bf_emma", name: "Emma", language_code: "en-gb", gender: "female" },
        ],
        default: "af_sarah",
      }),
      voicePreviewUrl: (id: string) => `http://engine/voices/${id}/preview`,
    },
  };

  it("offers the swatches Home offers, in place of a button to a dialog", async () => {
    mountSession("voiceover", node("voiceover", { params: { text: "hello" } }), withPack);
    expect(screen.getByLabelText("Use the Onyx voice")).toBeInTheDocument();
    // The full pack is still one press away — it is the entry point that
    // moved, not the picker.
    expect(await screen.findByText("All 2 voices…")).toBeInTheDocument();
    expect(screen.queryByText("Change voice")).toBeNull();
  });

  it("names the voice that spoke, not the brief that asked for one", async () => {
    mountSession(
      "voiceover",
      node("voiceover", {
        params: { text: "hello", voice: "narrator" },
        resolved_voice: "af_sarah",
      }),
      withPack,
    );
    // "narrator" matches no keyword in the engine's table, so it lands on
    // the pack default and is read by Sarah. The chip used to show the
    // brief, which named a voice that never spoke.
    expect(await screen.findByText("Voice: Sarah")).toBeInTheDocument();
    expect(screen.queryByText("narrator")).toBeNull();
  });

  it("falls back to the brief where no voice can be named", () => {
    // Off a chain that narrates elsewhere the engine reports none, and the
    // brief is still what was asked for - the only thing there is to say.
    mountSession(
      "voiceover",
      node("voiceover", { params: { text: "hello", voice: "deep" }, resolved_voice: null }),
      withPack,
    );
    expect(screen.getByText("deep")).toBeInTheDocument();
  });

  it("holds a swatch until the re-render is asked for", async () => {
    const refineTool = vi.fn().mockResolvedValue(null);
    mountSession(
      "voiceover",
      node("voiceover", { params: { text: "hello", voice_id: "bf_emma" } }),
      { ...withPack, refineTool },
    );
    const button = screen.getByText("Update & re-render") as HTMLButtonElement;
    // Nothing has moved yet, so there is nothing to re-render.
    expect(button.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    // A voice costs a synthesis, and choosing one is how you compare them:
    // applying on the click would spend a render per swatch pressed.
    expect(refineTool).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    // The brief and the pick in one patch: sent apart, the render between
    // them speaks in the voice that was just replaced.
    await vi.waitFor(() =>
      expect(refineTool).toHaveBeenCalledWith("voiceover", {
        voice: "deep",
        voice_id: null,
      }),
    );
  });

  it("sends an edited line and a new voice together", async () => {
    const refineTool = vi.fn().mockResolvedValue(null);
    mountSession("voiceover", node("voiceover", { params: { text: "hello" } }), {
      ...withPack,
      refineTool,
    });
    fireEvent.change(screen.getByLabelText("Edit this session's prompt"), {
      target: { value: "hello there" },
    });
    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    fireEvent.click(screen.getByText("Update & re-render"));
    await vi.waitFor(() =>
      expect(refineTool).toHaveBeenCalledWith("voiceover", {
        text: "hello there",
        voice: "deep",
        voice_id: null,
      }),
    );
  });

  it("reports a refusal against the composer that sent it", async () => {
    const refineTool = vi.fn().mockResolvedValue("node is pinned");
    mountSession("voiceover", node("voiceover", { params: { text: "hello" } }), {
      ...withPack,
      refineTool,
    });
    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    fireEvent.click(screen.getByText("Update & re-render"));
    expect(await screen.findByText("node is pinned")).toBeInTheDocument();
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
  it("pins a fresh seed in the regenerate call itself", async () => {
    const regenerate = vi.fn().mockResolvedValue(undefined);
    mountSession("image", node("image", { params: { prompt: "waves" } }), { regenerate });
    fireEvent.click(screen.getByText("Reroll"));
    // Awaited rather than immediate: every render-starting click now clears
    // the missing-model preflight first, which is a store call and so at
    // least a microtask even when it has nothing to warn about. The seed is
    // still pinned in the regenerate call itself — the point of this test.
    await vi.waitFor(() => expect(regenerate).toHaveBeenCalledTimes(1));
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
