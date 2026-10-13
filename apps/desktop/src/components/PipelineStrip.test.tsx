/**
 * The strip as drawn: a light, a stage and a word per stage, and the
 * sentence under them. Two stages keep words of their own, and the
 * Settings sentence about a missing model links to where models are got.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProgramInfo, ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { PipelineStrip } from "./PipelineStrip";

const row = (kind: string, verdict: ReadinessRow["verdict"], reason: string): ReadinessRow => ({
  kind,
  model: null,
  backend: null,
  verdict,
  reason: reason as ReadinessRow["reason"],
  data: {},
  fix: null,
});

const ready = (id: ProgramInfo["id"]) =>
  ({
    id,
    state: "ready",
    problem: null,
    source: "default",
    location: "",
    setting: "",
    version: null,
    checks: {},
    managed: null,
    setup: { available: false, job: null, last: null },
  }) as unknown as ProgramInfo;

let setSettingsTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setSettingsTab = vi.fn();
  useApp.setState({
    programQueue: [],
    setSettingsTab,
    programs: {
      platform: "linux-x64",
      programs_dir: "/p",
      programs_bytes: 0,
      disk_free_bytes: 1,
      programs: [ready("ffmpeg"), ready("ollama"), ready("comfyui")],
    },
  } as never);
});

describe("the pipeline strip", () => {
  it("names music that is a stand-in as none, and still-tier clips as stills", () => {
    useApp.setState({
      readiness: [
        row("script", "ready", "ok"),
        row("clip", "degraded", "still_clip_tier"),
        row("music", "placeholder", "no_model_installed"),
      ],
    } as never);
    render(<PipelineStrip context="settings" />);
    const music = screen.getByText("Music").closest("li")!;
    expect(music).toHaveTextContent(t("programs.strip.none"));
    expect(music.querySelector(".light")?.className).toContain("ph");
    const clips = screen.getByText("Video clips").closest("li")!;
    expect(clips).toHaveTextContent(t("programs.strip.stills"));
    expect(screen.getByText("Script").closest("li")).toHaveTextContent(
      t("programs.strip.lights.ok"),
    );
  });

  it("sends a stage that only lacks a model to Settings > Models", () => {
    const kinds = ["script", "keyframe", "clip", "narration", "captions", "timeline", "export"];
    useApp.setState({
      readiness: [
        ...kinds.map((kind) => row(kind, "ready", "ok")),
        row("music", "placeholder", "no_model_installed"),
      ],
    } as never);
    render(<PipelineStrip context="settings" />);
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Music has no model yet. Get one in Models.");
    fireEvent.click(screen.getByRole("button", { name: t("programs.narrate.modelsLink") }));
    expect(setSettingsTab).toHaveBeenCalledWith("models");
  });

  it("puts a fresh machine's render in one sentence", () => {
    useApp.setState({
      programs: {
        platform: "linux-x64",
        programs_dir: "/p",
        programs_bytes: 0,
        disk_free_bytes: 1,
        programs: [
          { ...ready("ffmpeg"), state: "missing" },
          { ...ready("ollama"), state: "missing" },
          { ...ready("comfyui"), state: "missing" },
        ],
      },
      readiness: [
        row("script", "placeholder", "llm_server_down"),
        row("keyframe", "placeholder", "no_model_installed"),
        row("clip", "placeholder", "no_model_installed"),
        row("narration", "placeholder", "no_model_installed"),
        row("captions", "placeholder", "no_model_installed"),
        row("music", "placeholder", "no_model_installed"),
        row("export", "will_fail", "no_ffmpeg"),
      ],
    } as never);
    render(<PipelineStrip context="wizard" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "A render right now would use stand-ins for 4 stages, then fail at the final video.",
    );
  });
});
