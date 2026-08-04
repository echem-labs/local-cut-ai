import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Palette } from "./Palette";

/**
 * `project.mode` is a free string the engine chose, and the palette lists
 * every project on the machine — so it is the one surface that sees a mode
 * this build has no copy for.
 *
 * Indexing the tools catalog with an unchecked cast threw on that miss, and
 * the palette opens over every screen: the throw took the whole app to the
 * ErrorBoundary from anywhere, with no way back to the projects it was
 * listing. A newer engine driving an older desktop is a documented topology
 * (laptop + GPU box on separate update schedules), and Home already resolves
 * unknown kinds to null for exactly this reason.
 */

const project = (id: string, mode: string, title: string): Project => ({
  id,
  title,
  created_at: 0,
  updated_at: 0,
  mode,
  approvals: [],
});

const openPalette = async (over: Record<string, unknown> = {}) => {
  useApp.setState({
    projects: [
      project("p1", "tool:image", "a lighthouse"),
      // A quick tool kind shipped after this build: the engine knows it, the
      // catalog does not.
      project("p2", "tool:podcast", "an interview"),
      project("p3", "prompt", "a documentary"),
    ],
    allJobs: [],
    libraryOpen: false,
    currentProject: null,
    openProject: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    closeProject: vi.fn(),
    ...over,
  } as never);
  render(<Palette />);
  await userEvent.keyboard("{Control>}k{/Control}");
};

beforeEach(() => {
  useApp.setState({ libraryOpen: false, currentProject: null } as never);
});

describe("the command palette", () => {
  it("lists a tool session whose kind this build does not know", async () => {
    await openPalette();

    // The unknown session is listed and openable, not a crash and not missing.
    expect(screen.getByText("an interview")).toBeInTheDocument();
    // And the two it does know still read normally.
    expect(screen.getByText("a lighthouse")).toBeInTheDocument();
    expect(screen.getByText("a documentary")).toBeInTheDocument();
  });
});

/**
 * The Library is a third screen the rail switches to (U2), and the palette
 * reaches Home past whatever is showing. Every command that means "put me on
 * Home" has to leave the Library as well as a project — otherwise the command
 * runs, the store changes, and the screen does not move.
 */
describe("going Home from the Library", () => {
  it("leaves the Library when the Home command runs", async () => {
    await openPalette({ libraryOpen: true });
    await userEvent.click(screen.getByText(t("palette.home")));
    expect(useApp.getState().libraryOpen).toBe(false);
  });

  it("leaves the Library when a create command runs, so Home is there to receive it", async () => {
    await openPalette({ libraryOpen: true });
    await userEvent.click(screen.getByText(t("palette.newVideo")));
    expect(useApp.getState().libraryOpen).toBe(false);
  });
});

/**
 * "Save as template…" is the one command that only exists in a context: a
 * template is a project's shape, and a one-off tool output has no shape to
 * save (plan doc 11, U2).
 */
describe("saving the open video as a template", () => {
  it("is offered while a video is open, and asks for a name", async () => {
    await openPalette({ currentProject: project("p3", "prompt", "a documentary") });
    await userEvent.click(screen.getByText(t("palette.saveTemplate")));
    expect(useApp.getState().saveTemplateFor?.id).toBe("p3");
  });

  it("is not offered for a tool output, which has no shape", async () => {
    await openPalette({ currentProject: project("p1", "tool:image", "a lighthouse") });
    expect(screen.queryByText(t("palette.saveTemplate"))).toBeNull();
  });

  it("is not offered with nothing open", async () => {
    await openPalette();
    expect(screen.queryByText(t("palette.saveTemplate"))).toBeNull();
  });
});
