/**
 * Where the "turned into a video" link lives inside the tool session panel.
 *
 * It first sat inside the `done && artifactUrl` branch, next to the download
 * and the promote button — which reads naturally but is wrong: it made a
 * fact about the session's HISTORY conditional on the state of its CURRENT
 * artifact. Regenerate the script and the link vanished while the new one
 * rendered; let that regeneration fail and it never came back, even though
 * the videos it had already produced were still there and still linked.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolSession } from "./ToolSession";
import { useApp } from "../store";
import type { Project } from "../api/types";

const SESSION: Project = {
  id: "s1",
  title: "octopus hearts",
  created_at: 0,
  mode: "tool:script",
  approvals: [],
  promoted_to: ["v1"],
};

const VIDEO: Project = {
  id: "v1",
  title: "Why octopuses have three hearts",
  created_at: 0,
  mode: "prompt",
  approvals: [],
  promoted_from: "s1",
};

/** Mount the panel with the session's script node in a given state. */
function mount(
  status: string,
  artifact_hash: string | null = null,
  { session = SESSION, projects = [SESSION, VIDEO] }: { session?: Project; projects?: Project[] } = {},
) {
  useApp.setState({
    currentProject: session,
    projects,
    board: { aux: { script: { status, progress: 0, artifact_hash, error: null } } },
    client: { artifactUrl: () => "blob:artifact" },
    openProject: vi.fn(async () => {}),
    promote: vi.fn(async () => {}),
    actionError: null,
  } as never);
  render(<ToolSession />);
}

beforeEach(() => {
  localStorage.clear();
});

describe("promotion link in the tool session panel", () => {
  it("shows while the session is re-rendering", () => {
    mount("rendering");
    expect(screen.getByRole("button", { name: VIDEO.title })).toBeTruthy();
  });

  it("still shows after a failed re-run", () => {
    mount("failed");
    expect(screen.getByRole("button", { name: VIDEO.title })).toBeTruthy();
  });

  it("shows on a finished session too", () => {
    mount("final", "abc123");
    expect(screen.getByRole("button", { name: VIDEO.title })).toBeTruthy();
  });

  it("shows nothing for a session that was never promoted", () => {
    mount("final", "abc123", { session: { ...SESSION, promoted_to: [] } });
    expect(screen.queryByRole("button", { name: VIDEO.title })).toBeNull();
  });

  // The advisory contract: the id survives the delete, the link does not.
  it("shows nothing once the video it names has been deleted", () => {
    mount("final", "abc123", { projects: [SESSION] });
    expect(screen.queryByRole("button", { name: VIDEO.title })).toBeNull();
  });
});
