/**
 * U3's panel depth: every control the panels grew has to reach the engine
 * as the field the route actually reads — and the preset chips write into
 * the VISIBLE field, never into hidden request state, so what travels is
 * always what the user can see and edit.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolKind } from "../api/types";
import { m } from "../i18n";
import { TOOL_CLIP_SECONDS } from "../lib/formats";
import { useApp } from "../store";
import { Home } from "./Home";

const draft = (over: Record<string, unknown> = {}) => ({
  prompt: "",
  tool: null,
  toolInput: "",
  voice: "",
  motion: "",
  scriptModel: "",
  toolAspect: "16:9",
  toolDuration: 60,
  clipSeconds: 5,
  ...over,
});

function seed(over: Record<string, unknown> = {}) {
  const createTool = vi.fn(
    async (_tool: ToolKind, _input: Record<string, unknown>, _frame?: File) => {},
  );
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    models: [],
    system: null,
    templates: [],
    homeDraft: draft(),
    defaults: {
      aspect: "9:16",
      duration: 60,
      style: "cinematic",
      mode: "prompt",
      voice: "",
      videoModel: null,
    },
    setHomeDraft: (patch: Record<string, unknown>) =>
      useApp.setState({ homeDraft: { ...useApp.getState().homeDraft, ...patch } } as never),
    setDefaults: vi.fn(),
    createFromPrompt: vi.fn(async () => {}),
    createTool,
    openProject: vi.fn(async () => {}),
    refreshHome: vi.fn(async () => {}),
    openLibrary: vi.fn(),
    openSettings: vi.fn(),
    actionError: null,
    ...over,
  } as never);
  return createTool;
}

/** The draft is seeded BEFORE render: a store write after mount is not
 * act-wrapped here, and the Generate button's disabled state would not
 * have flushed by the time the click lands. */
const openTool = (kind: ToolKind, over: Record<string, unknown> = {}) =>
  useApp.setState({ homeDraft: draft({ tool: kind, ...over }) } as never);

beforeEach(() => {
  localStorage.clear();
});

describe("the clip panel", () => {
  it("sends motion, clamped seconds and its own aspect", async () => {
    const createTool = seed();
    openTool("clip", {
      toolInput: "a hummingbird",
      motion: "orbit left",
      clipSeconds: 99, // typed past the max — the clamp is the point
      toolAspect: "1:1",
    });
    render(<Home />);
    fireEvent.click(screen.getByText("Generate clip"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][0]).toBe("clip");
    expect(createTool.mock.calls[0][1]).toMatchObject({
      prompt: "a hummingbird",
      motion: "orbit left",
      duration_s: TOOL_CLIP_SECONDS.max,
      aspect: "1:1",
    });
  });

  it("fills the visible motion field from a preset chip", () => {
    seed();
    openTool("clip");
    render(<Home />);
    fireEvent.click(screen.getByText(m().home.motionPresets.orbit.label));
    expect(useApp.getState().homeDraft.motion).toBe(m().home.motionPresets.orbit.text);
    // The field shows it — chips never write hidden state.
    expect(screen.getByLabelText("Camera motion")).toHaveValue(
      m().home.motionPresets.orbit.text,
    );
  });

  it("hands the picked start frame to createTool", async () => {
    const createTool = seed();
    openTool("clip", { toolInput: "a hummingbird" });
    render(<Home />);
    const frame = new File(["png"], "hero.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload a start frame for the clip"), {
      target: { files: [frame] },
    });
    expect(screen.getByText("Start frame: hero.png")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Generate clip"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][2]).toBe(frame);
  });

  it("clears a picked frame without sending it", async () => {
    const createTool = seed();
    openTool("clip", { toolInput: "a hummingbird" });
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Upload a start frame for the clip"), {
      target: { files: [new File(["png"], "hero.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByLabelText("Remove the start frame"));
    fireEvent.click(screen.getByText("Generate clip"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][2]).toBeUndefined();
  });
});

describe("the script panel", () => {
  it("sends its own target length and aspect", async () => {
    const createTool = seed();
    openTool("script", { toolInput: "octopus hearts", toolDuration: 30 });
    render(<Home />);
    fireEvent.click(screen.getByText("Generate script"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][1]).toMatchObject({
      prompt: "octopus hearts",
      target_duration_s: 30,
      aspect: "16:9",
    });
  });

  it("appends a preset's scaffold to the visible prompt, once", () => {
    seed();
    openTool("script", { toolInput: "octopus hearts" });
    render(<Home />);
    const chip = screen.getByText(m().home.scriptPresets.shorts.label);
    fireEvent.click(chip);
    fireEvent.click(chip); // stacking the same scaffold twice helps nobody
    const scaffold = m().home.scriptPresets.shorts.text;
    const input = useApp.getState().homeDraft.toolInput;
    expect(input).toBe(`octopus hearts\n${scaffold}`);
  });

  it("stacks a platform and a tone chip", () => {
    seed();
    openTool("script");
    render(<Home />);
    fireEvent.click(screen.getByText(m().home.scriptPresets.tiktok.label));
    fireEvent.click(screen.getByText(m().home.scriptPresets.casual.label));
    const input = useApp.getState().homeDraft.toolInput;
    expect(input).toContain(m().home.scriptPresets.tiktok.text);
    expect(input).toContain(m().home.scriptPresets.casual.text);
  });
});

describe("the voiceover panel", () => {
  it("selects a brief the engine's keyword map resolves", async () => {
    const createTool = seed();
    openTool("voiceover", { toolInput: "Hello there" });
    render(<Home />);
    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    expect(screen.getByLabelText("Voice")).toHaveValue("deep");
    fireEvent.click(screen.getByText("Generate voiceover"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][1]).toMatchObject({ text: "Hello there", voice: "deep" });
  });

  /**
   * A picked voice and a brief are two answers to one question, and the
   * engine only ever hears the pick: `kokoro.execute` resolves
   * `voice_id or pick_voice(voice)`. So the panel must never hold both -
   * whichever the user touched last is the one that survives, or a swatch
   * lights up as chosen while another voice is what actually speaks.
   */
  it("clears a picked voice when a swatch brief is chosen instead", () => {
    seed();
    openTool("voiceover", { toolInput: "Hello there", voiceId: "bf_emma" });
    render(<Home />);
    fireEvent.click(screen.getByLabelText("Use the Onyx voice"));
    expect(useApp.getState().homeDraft.voice).toBe("deep");
    // Without this the Onyx swatch renders active while bf_emma still wins.
    expect(useApp.getState().homeDraft.voiceId).toBeNull();
  });

  /**
   * The panel's options describe THAT run and go back to their starting
   * values with the text - and this one is persisted, so a pick left behind
   * is not merely stale for the next voiceover but for every later session.
   */
  it("forgets a picked voice once the run is away", async () => {
    const createTool = seed();
    openTool("voiceover", { toolInput: "Hello there", voiceId: "bf_emma" });
    render(<Home />);
    fireEvent.click(screen.getByText("Generate voiceover"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][1]).toMatchObject({ voice_id: "bf_emma" });
    await vi.waitFor(() => expect(useApp.getState().homeDraft.toolInput).toBe(""));
    expect(useApp.getState().homeDraft.voiceId).toBeNull();
  });
});

describe("the music panel", () => {
  it("sends the target length", async () => {
    const createTool = seed();
    openTool("music", { toolInput: "lo-fi beat", toolDuration: 90 });
    render(<Home />);
    fireEvent.click(screen.getByText("Generate music"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][1]).toMatchObject({
      prompt: "lo-fi beat",
      target_duration_s: 90,
    });
    // Music has no aspect — nothing to send.
    expect(createTool.mock.calls[0][1]).not.toHaveProperty("aspect");
  });
});

describe("the image panel", () => {
  it("sends its own aspect", async () => {
    const createTool = seed();
    openTool("image", { toolInput: "black-sand beach", toolAspect: "9:16" });
    render(<Home />);
    fireEvent.click(screen.getByText("Generate image"));
    await vi.waitFor(() => expect(createTool).toHaveBeenCalled());
    expect(createTool.mock.calls[0][1]).toMatchObject({
      prompt: "black-sand beach",
      aspect: "9:16",
    });
  });
});
