/**
 * When the app offers to write a title.
 *
 * The publish kit is written from the SCRIPT — `POST /package` conditions a
 * thumbnail on the screenplay and asks the LLM for title, description and
 * hashtags from the same text. Nothing in it depends on the cut's quality.
 * Gating it on a `final` export therefore made you sit through a whole
 * finalize before the app would suggest so much as a title, on a project
 * that already had a watchable video.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Board, NodeState } from "../api/types";
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

const mount = (exportNode: NodeState) => {
  useApp.setState({
    client: null,
    currentProject: { id: "p1", title: "t", mode: "auto", approvals: [] },
    board: {
      scenes: [
        {
          scene_id: "s1",
          keyframe: node("s1.keyframe", "draft"),
          clip: node("s1.clip", "draft"),
          narration: node("s1.narration", "draft"),
        },
      ],
      aux: { script: node("script", "draft"), export: exportNode },
      assembled_durations: {},
    } as unknown as Board,
    jobs: [],
    allJobs: [],
    nodeFailures: {},
    nodeRetries: {},
  } as never);
  render(<Project />);
};

const prepare = () => screen.queryByRole("button", { name: /prepare to publish/i });

beforeEach(() => useApp.setState({ nodeFailures: {}, nodeRetries: {} } as never));

describe("offering the publish kit", () => {
  it("offers it on a draft cut, not only a finalized one", () => {
    mount(node("export", "draft", "a".repeat(64)));
    expect(prepare()).toBeInTheDocument();
  });

  it("offers it on a finalized cut", () => {
    mount(node("export", "final", "a".repeat(64)));
    expect(prepare()).toBeInTheDocument();
  });

  it("stays away while there is no cut at all", () => {
    // The last step first: there is nothing to publish, and the engine
    // refuses `/package` anyway while the script is unrendered.
    mount(node("export", "queued"));
    expect(prepare()).toBeNull();
  });

  it("stays away when the export node has no artifact behind its status", () => {
    // A status without a hash is a render that has not landed - offering to
    // package it would name a file that does not exist.
    mount(node("export", "draft", null));
    expect(prepare()).toBeNull();
  });
});
