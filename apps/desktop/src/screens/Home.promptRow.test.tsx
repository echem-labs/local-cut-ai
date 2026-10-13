/**
 * The prompt row composes ONE video; it does not re-aim every later one.
 *
 * The row used to read and write `defaults` directly, which made every pick
 * permanent: one anime video and anime was the baseline, one click on Auto
 * and Review steps never came back. The shipped default that says "review
 * the steps until someone says otherwise" was true only until the first
 * video, and the person it protects — someone on their first render — is
 * exactly the one who lost it.
 *
 * So the row's picks live in the draft, which already documents itself as
 * "cleared on a successful generate", and Settings → Defaults stays the one
 * place a baseline is set. `toolAspect` said as much in its own comment
 * before this: a 9:16 thumbnail experiment must not silently re-aim the
 * next full video.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { useApp } from "../store";
import { Home } from "./Home";

let createFromPrompt: ReturnType<typeof vi.fn>;

const seed = () => {
  createFromPrompt = vi.fn(async () => {});
  useApp.setState({
    client: null,
    projects: [],
    allJobs: [],
    models: [],
    system: null,
    templates: [],
    libraryOpen: false,
    settingsOpen: false,
    createFromPrompt,
    openProject: vi.fn(async () => {}),
    refreshHome: vi.fn(async () => {}),
  } as never);
};

/** Type a prompt and send it. */
async function generate(text = "a bee") {
  fireEvent.change(screen.getByLabelText(t("home.promptAria")), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("common.generate")) }));
  });
}

beforeEach(() => {
  localStorage.clear();
  seed();
});

describe("what the prompt row keeps", () => {
  it("sends the style that was picked", async () => {
    render(<Home />);
    fireEvent.click(screen.getByLabelText(t("home.styleAria")));
    fireEvent.click(screen.getByRole("option", { name: "Anime" }));
    await generate();
    expect(createFromPrompt).toHaveBeenCalledWith("a bee", 60, "9:16", "beginner", "anime");
  });

  it("goes back to the default style once that video is away", async () => {
    render(<Home />);
    fireEvent.click(screen.getByLabelText(t("home.styleAria")));
    fireEvent.click(screen.getByRole("option", { name: "Anime" }));
    await generate();
    // The chip, not the store: what the next person to look at Home sees.
    expect(screen.getByLabelText(t("home.styleAria")).textContent).toContain("Cinematic");
  });

  it("never writes the row's pick into the saved defaults", async () => {
    render(<Home />);
    fireEvent.click(screen.getByLabelText(t("home.styleAria")));
    fireEvent.click(screen.getByRole("option", { name: "Anime" }));
    await generate();
    expect(useApp.getState().defaults.style).toBe("cinematic");
  });

  // The one that cost the most: `mode` is the guard rail on a first render,
  // and picking Auto for one video used to retire it for good.
  it("keeps Review steps as the baseline after a video runs on Auto", async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: t("home.modeAuto") }));
    await generate();
    expect(createFromPrompt).toHaveBeenCalledWith("a bee", 60, "9:16", "prompt", "cinematic");
    expect(useApp.getState().defaults.mode).toBe("beginner");
    const review = screen.getByRole("button", { name: t("home.modeReview") });
    expect(review.className).toContain("active");
  });

  it("still follows a baseline changed in Settings", async () => {
    useApp.getState().setDefaults({ style: "retro", mode: "prompt" });
    render(<Home />);
    await generate();
    expect(createFromPrompt).toHaveBeenCalledWith("a bee", 60, "9:16", "prompt", "retro");
  });

  // A draft is not lost by looking away — only by being sent.
  it("holds the pick while the video is still being composed", async () => {
    const { unmount } = render(<Home />);
    fireEvent.click(screen.getByLabelText(t("home.styleAria")));
    fireEvent.click(screen.getByRole("option", { name: "Anime" }));
    unmount();
    render(<Home />);
    expect(screen.getByLabelText(t("home.styleAria")).textContent).toContain("Anime");
  });
});

/**
 * The note under the prompt names the first thing a video would hit, and its
 * link goes where that thing is fixed: a missing FFmpeg is set up in
 * Settings > Programs, which nothing in Settings > Models can do.
 */
describe("where the prompt row's readiness note leads", () => {
  const exportFails = {
    kind: "export",
    model: null,
    backend: null,
    verdict: "will_fail",
    reason: "no_ffmpeg",
    data: {},
    fix: { type: "setup_program", program: "ffmpeg", size_bytes: 137_034_436 },
  };
  const musicGap = {
    kind: "music",
    model: null,
    backend: "mock",
    verdict: "placeholder",
    reason: "no_model_installed",
    data: { task: "music.gen" },
    fix: null,
  };

  it("opens Programs for a program", () => {
    const openSettings = vi.fn();
    useApp.setState({ readiness: [exportFails], openSettings } as never);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: t("home.getIt") }));
    expect(openSettings).toHaveBeenCalledWith("programs");
  });

  it("opens Models for a model", () => {
    const openSettings = vi.fn();
    useApp.setState({ readiness: [musicGap], openSettings } as never);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: t("home.getIt") }));
    expect(openSettings).toHaveBeenCalledWith("models");
  });
});
