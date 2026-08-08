/**
 * The pre-finalize drawtext warning.
 *
 * An FFmpeg 7 static build without libharfbuzz has no `drawtext` filter, so
 * a cut that burns a title on any scene dies at the very last step — after
 * every scene has re-rendered at final quality. That is the most expensive
 * moment in the whole product to discover a missing filter, and nothing on
 * screen said a word about it beforehand.
 *
 * Both halves have to be true. The reason this is tested rather than just
 * written is the halves: warning every machine without drawtext, including
 * the projects with no titles at all, is how a warning becomes wallpaper.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "./Project";
import { t } from "../i18n";
import { useApp } from "../store";

const node = (id: string, status = "final") => ({
  node_id: id,
  status,
  progress: 1,
  error: null,
  artifact_hash: `h-${id}`,
  params: {},
  seed: 1,
  model: null,
  pinned: false,
});

const BOARD = {
  scenes: [{ scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null }],
  aux: { script: node("script"), timeline: node("timeline") },
  has_onscreen_text: true,
};

async function mount(over: { drawtext?: boolean | null; titles?: boolean } = {}) {
  useApp.setState({
    currentProject: { id: "p1", title: "A tour", created_at: 0, mode: "prompt", approvals: [] },
    board: { ...BOARD, has_onscreen_text: over.titles ?? true },
    jobs: [],
    client: { baseUrl: "http://127.0.0.1:7830", artifactUrl: () => "blob:x" },
    system: over.drawtext === undefined ? undefined : { ...SYSTEM, ffmpeg_drawtext: over.drawtext },
    refreshBoard: vi.fn(async () => {}),
    actionError: null,
  } as never);
  await act(async () => {
    render(<Project />);
  });
}

const SYSTEM = {
  hardware: {
    os: "linux",
    arch: "x64",
    ram_gb: 32,
    disk_free_gb: 100,
    gpus: [],
    primary_gpu: null,
    tier: "A",
  },
  recommendations: [],
  backend_mode: "local",
};

const warning = () => screen.queryByText(t("project.noDrawtext"));

beforeEach(() => {
  useApp.setState({ system: undefined } as never);
});

describe("warning before the expensive step, not after it", () => {
  it("warns when this ffmpeg cannot draw text and the cut has titles", async () => {
    await mount({ drawtext: false, titles: true });
    expect(warning()).toBeInTheDocument();
  });

  it("says nothing when the cut has no titles to burn", async () => {
    // The same broken ffmpeg, and this project is entirely unaffected by
    // it. Warning anyway is how people learn to ignore the banner.
    await mount({ drawtext: false, titles: false });
    expect(warning()).not.toBeInTheDocument();
  });

  it("says nothing on a machine whose ffmpeg can draw text", async () => {
    await mount({ drawtext: true, titles: true });
    expect(warning()).not.toBeInTheDocument();
  });

  it("stays quiet when there is no ffmpeg at all", async () => {
    // `null` is "no ffmpeg was found", which the engine and the Settings
    // row already report far more loudly. Two banners for one cause reads
    // as two problems.
    await mount({ drawtext: null, titles: true });
    expect(warning()).not.toBeInTheDocument();
  });

  it("stays quiet against an engine too old to have looked", async () => {
    // `undefined` is an absent field, not a "no". Guessing from silence
    // would warn every user of an older engine about nothing.
    await mount({ drawtext: undefined, titles: true });
    expect(warning()).not.toBeInTheDocument();
  });

  it("stays quiet against an engine that does not report overlays", async () => {
    // Same argument the other way: an older engine sends no
    // `has_onscreen_text`, and `undefined` must not read as "yes".
    useApp.setState({ system: { ...SYSTEM, ffmpeg_drawtext: false } } as never);
    const { has_onscreen_text: _dropped, ...older } = BOARD;
    useApp.setState({
      currentProject: { id: "p1", title: "A tour", created_at: 0, mode: "prompt", approvals: [] },
      board: older,
      jobs: [],
      client: { baseUrl: "http://127.0.0.1:7830", artifactUrl: () => "blob:x" },
      refreshBoard: vi.fn(async () => {}),
      actionError: null,
    } as never);
    await act(async () => {
      render(<Project />);
    });
    expect(warning()).not.toBeInTheDocument();
  });
});
