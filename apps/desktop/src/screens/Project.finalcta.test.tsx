/**
 * The screen's one primary action, while the render it started is running.
 *
 * `allReady` counts scene CLIPS, and finalize renders more than those — the
 * timeline and the export always, plus the keyframes, music and thumbnail at
 * final quality. So the moment the last clip landed, the CTA re-armed itself
 * and offered to create a final video that was at that moment being
 * assembled: an enabled primary action beside a still-spinning queue tray,
 * inviting a second finalize of work already in flight.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Board, Job, NodeState } from "../api/types";
import { useApp } from "../store";
import { Project } from "./Project";

const node = (id: string, status: string, hash: string | null = null): NodeState =>
  ({
    node_id: id,
    status,
    progress: 0,
    error: null,
    artifact_hash: hash,
    params: {},
    seed: 0,
    model: null,
    pinned: false,
  }) as NodeState;

const job = (status: string, quality: string): Job =>
  ({
    id: `j-${status}-${quality}`,
    project_id: "p1",
    status,
    progress: 0,
    created_at: 1,
    spec: { node_id: "timeline", kind: "timeline", quality },
  }) as unknown as Job;

/** Every clip final; the assembly's state is what each case varies. */
const mount = (exportStatus: string, jobs: Job[]) => {
  const project = { id: "p1", title: "t", mode: "auto", approvals: [] };
  const board = {
    scenes: [
      {
        scene_id: "s1",
        keyframe: node("s1.keyframe", "final"),
        clip: node("s1.clip", "final", "c".repeat(64)),
        narration: node("s1.narration", "final"),
      },
    ],
    aux: {
      script: node("script", "final"),
      timeline: node("timeline", "rendering"),
      export: node("export", exportStatus, exportStatus === "final" ? "e".repeat(64) : null),
    },
    assembled_durations: {},
  } as unknown as Board;
  useApp.setState({
    // Download is a link built from `artifactUrl`, so that branch needs a
    // client to render at all — and the mount's own `refreshBoard` then
    // calls `getProject`, which answers with this same fixture so the
    // refresh cannot quietly rewrite what the test just seeded.
    client: {
      artifactUrl: (_p: string, hash: string) => `http://engine/a/${hash}`,
      getProject: () => Promise.resolve({ project, board }),
      listJobs: () => Promise.resolve(jobs),
      history: () => Promise.resolve({ undo_depth: 0, redo_depth: 0, savepoints: [] }),
    },
    currentProject: project,
    board,
    jobs,
    allJobs: [],
    nodeFailures: {},
    nodeRetries: {},
  } as never);
  render(<Project />);
};

const cta = () => screen.getByRole("button", { name: /create final video|creating final video/i });

beforeEach(() => useApp.setState({ nodeFailures: {}, nodeRetries: {} } as never));

describe("the create-final-video button while work is in flight", () => {
  it("stays unpressable while the finalize it started is still assembling", () => {
    // The reported case: every clip has landed, the export has not, and the
    // tray is still spinning.
    mount("rendering", [job("rendering", "final")]);
    expect(cta()).toBeDisabled();
    expect(cta()).toHaveTextContent(/creating final video/i);
  });

  it("counts a queued final job, not only a rendering one", () => {
    mount("queued", [job("queued", "final")]);
    expect(cta()).toBeDisabled();
  });

  it("does not claim to be creating a final video during a draft render", () => {
    // Same shape, draft work: the assembly of a DRAFT cut is not a finalize,
    // and saying so would be a lie about what the queue is doing.
    mount("rendering", [job("rendering", "draft")]);
    expect(cta()).toBeDisabled();
    expect(cta()).toHaveTextContent(/^create final video$/i);
  });

  it("offers itself once the queue is clear", () => {
    mount("draft", []);
    expect(cta()).toBeEnabled();
  });

  it("gives way to Download once the export is final", () => {
    mount("final", []);
    expect(screen.getByRole("link", { name: /download mp4/i })).toBeInTheDocument();
  });

  it("treats an engine that sends no quality as not-a-finalize", () => {
    // `spec.quality` is optional on the wire type: an engine older than the
    // field must read as "not a finalize" rather than throwing.
    const legacy = { ...job("rendering", "draft") };
    delete (legacy.spec as { quality?: string }).quality;
    mount("rendering", [legacy]);
    expect(cta()).toHaveTextContent(/^create final video$/i);
  });
});
