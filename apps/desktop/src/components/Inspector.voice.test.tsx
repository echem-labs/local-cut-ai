/**
 * The Voice tab, which is the one place a scene's narrator is chosen.
 *
 * Two things were unanswerable from this panel. It said a scene "follows
 * the project" without naming what the project sounds like — and the
 * project's voice is set nowhere else, so there was no second place to go
 * and read it. And the brief field looks like the setting, when the value
 * it holds is a per-scene copy of the screenplay's style that the next
 * script render writes back over; only a picked voice survives that.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, NodeState } from "../api/types";
import { Inspector } from "./Inspector";
import { useApp } from "../store";

const node = (id: string, params: Record<string, unknown> = {}, over: Partial<NodeState> = {}) =>
  ({
    node_id: id,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: "a".repeat(64),
    params,
    seed: 0,
    model: null,
    pinned: false,
    ...over,
  }) as NodeState;

const PACK = {
  available: true,
  voices: [
    { id: "af_sarah", name: "Sarah", language_code: "en-us", gender: "female" },
    { id: "bf_emma", name: "Emma", language_code: "en-gb", gender: "female" },
  ],
  default: "af_sarah",
};

function scene(id: string, narration: NodeState | null) {
  return { scene_id: id, keyframe: node(`${id}.keyframe`), clip: node(`${id}.clip`), narration };
}

let applyNode: ReturnType<typeof vi.fn>;
let setProjectVoice: ReturnType<typeof vi.fn>;

/** Two scenes, so "every scene" has somewhere to reach.
 *
 * `held` is the pick both scenes already carry — the state a clear has to
 * have something to clear.
 */
function mount(over: Partial<NodeState> = {}, held: string | null = null) {
  applyNode = vi.fn();
  setProjectVoice = vi.fn().mockResolvedValue(null);
  const picked = held ? { voice_id: held } : {};
  const board: Board = {
    scenes: [
      scene("s1", node("s1.narration", { text: "one", voice: "clear", ...picked }, over)),
      scene("s2", node("s2.narration", { text: "two", voice: "clear", ...picked })),
    ],
    aux: {},
  } as unknown as Board;
  useApp.setState({
    board,
    selectedNode: "s1.narration",
    applyNode,
    setProjectVoice,
    client: {
      voices: vi.fn().mockResolvedValue(PACK),
      voicePreviewUrl: (id: string) => `http://engine/voices/${id}/preview`,
    },
  } as never);
  return render(<Inspector />);
}

beforeEach(() => {
  useApp.setState({ board: null, selectedNode: null, engineVersions: null } as never);
});

describe("what the scene sounds like", () => {
  it("names the voice a followed brief resolves to", async () => {
    mount({ params: { text: "one", voice: "clear" }, resolved_voice: "af_sarah" } as never);
    // "follows the project" alone names a value set nowhere the user can
    // look: the brief is a wish, and which voice it lands on is the
    // engine's own mapping.
    expect(await screen.findByText("Voice: follows the project · Sarah")).toBeInTheDocument();
  });

  it("falls back to saying only that it follows, off a chain with no pack", async () => {
    // A chain narrating on another backend has no voice to name, and a
    // guess would be a fabricated provenance.
    mount({ params: { text: "one", voice: "clear" }, resolved_voice: null } as never);
    expect(await screen.findByText("Voice: follows the project")).toBeInTheDocument();
  });

  it("says the brief is rewritten by the next script render", async () => {
    mount();
    // The trap: a scene's `voice` is copied from the screenplay's style on
    // every expansion, so an edit here survives until the next re-script
    // and no further. A pick does survive, and the note says which is
    // which — there is nowhere else this could be learned.
    expect(await screen.findByText(/rewrites this from the project's style/)).toBeInTheDocument();
  });
});

describe("choosing for the whole project", () => {
  async function open(everyScene: boolean, held: string | null = null) {
    mount({}, held);
    fireEvent.click(await screen.findByText("Change voice"));
    if (everyScene) fireEvent.click(screen.getByLabelText("Use this voice for every scene"));
  }

  it("writes only this scene when it was not asked for, and waits for Apply", async () => {
    await open(false);
    fireEvent.click(screen.getByText("Emma"));
    // A pick for one scene is an edit like any other on this panel: it
    // stages, and Apply sends it with whatever else was typed.
    expect(setProjectVoice).not.toHaveBeenCalled();
    expect(applyNode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Apply & regenerate"));
    await waitFor(() => expect(applyNode).toHaveBeenCalled());
    expect(applyNode.mock.calls[0][0]).toBe("s1.narration");
    expect(applyNode.mock.calls[0][1].params).toMatchObject({ voice_id: "bf_emma" });
  });

  it("asks before rewriting scenes the panel is not about", async () => {
    await open(true);
    fireEvent.click(screen.getByText("Emma"));
    // "Apply & regenerate" means this scene, and it has to keep meaning
    // that: a project-wide change asks for itself, where it is chosen.
    expect(setProjectVoice).not.toHaveBeenCalled();
    expect(await screen.findByText("Use Emma for all 2 scenes?")).toBeInTheDocument();
  });

  it("writes every scene once the ask is answered", async () => {
    await open(true);
    fireEvent.click(screen.getByText("Emma"));
    fireEvent.click(await screen.findByRole("button", { name: "Use Emma" }));
    await waitFor(() => expect(setProjectVoice).toHaveBeenCalledWith("bf_emma"));
    // Not through the scene's own Apply: the two are separate decisions
    // made at separate moments now.
    expect(applyNode).not.toHaveBeenCalled();
  });

  it("leaves everything alone when the ask is declined", async () => {
    await open(true);
    fireEvent.click(screen.getByText("Emma"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(setProjectVoice).not.toHaveBeenCalled();

    // And the scene keeps the voice it had: a cancelled project-wide pick
    // must not leave a scene-sized one staged behind it.
    fireEvent.click(screen.getByText("Apply & regenerate"));
    await waitFor(() => expect(applyNode).toHaveBeenCalled());
    expect(applyNode.mock.calls[0][1].params.voice_id).toBeUndefined();
  });

  it("names the ask for what clearing does", async () => {
    await open(true, "af_sarah");
    fireEvent.click(screen.getByText("Follow the project"));
    expect(
      await screen.findByText("Put all 2 scenes back to following the project?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Follow the project" }));
    await waitFor(() => expect(setProjectVoice).toHaveBeenCalledWith(null));
  });

  it("reports a refusal on the panel the pick was made from", async () => {
    await open(true);
    // Set after the mount that creates it. The dialog is gone by the time
    // the answer arrives, so a refusal that only lived there would be a
    // change the user believes happened.
    setProjectVoice.mockResolvedValue("node is pinned");
    fireEvent.click(screen.getByText("Emma"));
    fireEvent.click(await screen.findByRole("button", { name: "Use Emma" }));
    expect(await screen.findByText("node is pinned")).toBeInTheDocument();
  });
});
