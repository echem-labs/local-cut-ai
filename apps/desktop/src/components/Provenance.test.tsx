/**
 * Promotion provenance, both directions.
 *
 * The engine records the ids but deliberately never rewrites the survivor
 * when one side is deleted — doing so would mean reading every meta on every
 * delete. That makes "the other end is gone" a NORMAL state, not an error,
 * and the rendering has to treat it that way: a dangling id is no link at
 * all, never a dead button or a blank name.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromotedFrom, PromotedTo } from "./Provenance";
import { plural, t } from "../i18n";
import { useApp } from "../store";
import type { Project } from "../api/types";

const project = (id: string, title: string, extra: Partial<Project> = {}): Project => ({
  id,
  title,
  created_at: 0,
  mode: "prompt",
  approvals: [],
  ...extra,
});

const SESSION = project("s1", "octopus hearts", {
  mode: "tool:script",
  promoted_to: ["v1", "v2"],
});
const VIDEO_ONE = project("v1", "Why octopuses have three hearts");
const VIDEO_TWO = project("v2", "Octopus hearts, take two");

let openProject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openProject = vi.fn(async () => {});
  useApp.setState({ projects: [SESSION, VIDEO_ONE, VIDEO_TWO], openProject } as never);
});

describe("PromotedTo (session → videos)", () => {
  it("names every video the session produced", () => {
    render(<PromotedTo project={SESSION} />);
    expect(screen.getByText(plural("toolSession.becameVideo", 2), { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: VIDEO_ONE.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: VIDEO_TWO.title })).toBeTruthy();
  });

  it("opens the video it names", () => {
    render(<PromotedTo project={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: VIDEO_ONE.title }));
    expect(openProject).toHaveBeenCalledWith("v1");
  });

  it("skips a video that has since been deleted", () => {
    useApp.setState({ projects: [SESSION, VIDEO_TWO] } as never);
    render(<PromotedTo project={SESSION} />);
    expect(screen.queryByRole("button", { name: VIDEO_ONE.title })).toBeNull();
    expect(screen.getByRole("button", { name: VIDEO_TWO.title })).toBeTruthy();
    // One survivor, so the wording drops to the singular rather than
    // claiming two videos and showing one.
    expect(screen.getByText(plural("toolSession.becameVideo", 1), { exact: false })).toBeTruthy();
  });

  it("renders nothing when every video is gone", () => {
    useApp.setState({ projects: [SESSION] } as never);
    const { container } = render(<PromotedTo project={SESSION} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a session that was never promoted", () => {
    const fresh = project("s2", "unused", { mode: "tool:script" });
    const { container } = render(<PromotedTo project={fresh} />);
    expect(container.textContent).toBe("");
  });
});

describe("PromotedFrom (video → session)", () => {
  const VIDEO = project("v1", "Why octopuses have three hearts", { promoted_from: "s1" });

  it("names the session the screenplay came from and opens it", () => {
    render(<PromotedFrom project={VIDEO} />);
    expect(screen.getByText(t("project.fromSession"), { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SESSION.title }));
    expect(openProject).toHaveBeenCalledWith("s1");
  });

  it("renders nothing once the session has been deleted", () => {
    useApp.setState({ projects: [VIDEO] } as never);
    const { container } = render(<PromotedFrom project={VIDEO} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a project that was written from scratch", () => {
    const { container } = render(<PromotedFrom project={project("v9", "Direct")} />);
    expect(container.textContent).toBe("");
  });
});
