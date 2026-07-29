import { render, screen } from "@testing-library/react";

import { describe, expect, it } from "vitest";

import type { Board, Job, NodeState, Project, Screenplay } from "../api/types";
import { NARRATION_PAD_S, SPEECH_WORDS_PER_S, spokenSeconds } from "../lib/formats";
import { useApp } from "../store";
import { ScriptTable, ToolSession, screenplayMarkdown } from "./ToolSession";

/**
 * The Length column showed `duration_s` — the script model's own claim,
 * which small local models pad to whatever number they were asked for
 * (six scenes, each "60s", for a 60s video). Nothing downstream reads that
 * field: a cut lasts as long as its narration takes to speak. The table has
 * to apply the same rule or the preview disagrees with the assembled video.
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const screenplay: Screenplay = {
  title: "The Fall of Istanbul",
  hook: "The empire's final breath.",
  scenes: [
    // The model's claim says 60s; 35 words actually speak in ~10s.
    { id: "s1", duration_s: 60, narration: words(35), visual: "aerial view", motion: "", onscreen_text: null },
    { id: "s2", duration_s: 60, narration: words(70), visual: "the walls", motion: "", onscreen_text: null },
  ],
};

describe("spokenSeconds", () => {
  it("applies the engine's narration timing rule", () => {
    expect(spokenSeconds(words(35))).toBeCloseTo(35 / SPEECH_WORDS_PER_S + NARRATION_PAD_S);
    // Whitespace runs are not words.
    expect(spokenSeconds("  one   two  ")).toBeCloseTo(2 / SPEECH_WORDS_PER_S + NARRATION_PAD_S);
  });
});

describe("ScriptTable", () => {
  it("shows spoken time per scene, never the model's duration_s claim", () => {
    render(<ScriptTable screenplay={screenplay} targetS={60} />);
    expect(screen.getByText("~10s")).toBeInTheDocument();
    expect(screen.getByText("~20s")).toBeInTheDocument();
    expect(screen.queryByText("~60s")).not.toBeInTheDocument();
  });

  it("totals the spoken time against the requested target", () => {
    render(<ScriptTable screenplay={screenplay} targetS={60} />);
    expect(screen.getByText("~31s spoken · target 60s")).toBeInTheDocument();
  });
});

describe("screenplayMarkdown", () => {
  it("carries title, hook, narration and visuals with spoken lengths", () => {
    const md = screenplayMarkdown(screenplay);
    expect(md).toContain("# The Fall of Istanbul");
    expect(md).toContain("> The empire's final breath.");
    expect(md).toContain("## s1 · ~10s");
    expect(md).toContain("*Visual:* aerial view");
    expect(md.endsWith("\n")).toBe(true);
  });
});

/**
 * The provenance line reads the project-scoped `jobs` slice, not `allJobs`.
 *
 * `allJobs` is refreshed only by refreshHome, and a job event for the OPEN
 * project deliberately routes to refreshBoard instead — so the model and
 * duration read from it were whatever the last Home visit happened to see:
 * absent for a first render, and a take stale after every enhance.
 */

const toolNode = (): NodeState => ({
  node_id: "script",
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: { target_duration_s: 60 },
  seed: 0,
  model: null,
  pinned: false,
});

const doneJob = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  project_id: "p1",
  status: "done",
  progress: 1,
  error: null,
  created_at: 100,
  started_at: 100,
  finished_at: 168,
  model: "llama3.2",
  spec: { node_id: "script", kind: "script" },
  ...over,
});

function mountSession(state: { jobs?: Job[]; allJobs?: Job[] }) {
  useApp.setState({
    currentProject: { id: "p1", title: "T", mode: "tool:script" } as Project,
    board: { scenes: [], aux: { script: toolNode() } } as Board,
    client: null,
    jobs: [],
    allJobs: [],
    actionError: null,
    ...state,
  } as never);
  return render(<ToolSession />);
}

describe("ToolSession provenance", () => {
  it("shows the model and duration of the job the board loop refreshed", () => {
    mountSession({ jobs: [doneJob()] });
    expect(screen.getByText("llama3.2")).toBeInTheDocument();
    expect(screen.getByText("took 1:08")).toBeInTheDocument();
  });

  it("does not read the Home-only allJobs slice", () => {
    // The exact shape of the bug: the board loop has this render's job, and
    // allJobs still holds the previous take's. Reading allJobs would show
    // "some-stale-model" here.
    mountSession({
      jobs: [doneJob()],
      allJobs: [doneJob({ id: "j0", model: "some-stale-model", finished_at: 900 })],
    });
    expect(screen.getByText("llama3.2")).toBeInTheDocument();
    expect(screen.queryByText("some-stale-model")).toBeNull();
  });

  it("shows nothing rather than a wrong model when the slice is empty", () => {
    mountSession({ jobs: [], allJobs: [doneJob({ model: "some-stale-model" })] });
    expect(screen.queryByText("some-stale-model")).toBeNull();
  });
});
