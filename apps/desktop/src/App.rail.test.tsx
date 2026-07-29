/**
 * The rail's quick-tool history.
 *
 * A tool session is a real project the engine keeps, but before this list
 * existed the rail showed one only while its tab happened to be open, so
 * closing the tab was indistinguishable from throwing the output away. The
 * properties worth pinning are the ones that make the two lists mean
 * different things: history is derived from the engine's project list, an
 * open session belongs to the tabs and must not appear twice, and the
 * trailing control here DELETES where the tabs' control merely closes.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { t } from "./i18n";
import { useApp } from "./store";
import type { Job, Project } from "./api/types";

const project = (id: string, mode: string, title: string, updated_at: number): Project => ({
  id,
  title,
  created_at: 0,
  updated_at,
  mode,
  approvals: [],
});

const done = (project_id: string, node_id: string): Job => ({
  id: `j-${project_id}`,
  project_id,
  status: "done",
  progress: 1,
  error: null,
  created_at: 1,
  started_at: 1,
  finished_at: 1,
  model: null,
  spec: { node_id, kind: node_id },
});

let deleteProject: ReturnType<typeof vi.fn>;
let openProject: ReturnType<typeof vi.fn>;

const PROJECTS = [
  project("v1", "prompt", "A tour of the solar system", 50),
  project("t-old", "tool:voiceover", "one small step", 10),
  project("t-new", "tool:image", "a lighthouse at dusk", 30),
];

/** The rail's history group, so a query cannot stray into the tab list. */
const historyGroup = () => screen.getByText(t("nav.recent")).parentElement as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  deleteProject = vi.fn(async () => null); // null = the engine agreed
  openProject = vi.fn(async () => {});
  useApp.setState({
    connect: vi.fn(async () => {}),
    client: null,
    firstRunDone: true,
    currentProject: null,
    openProjects: [],
    projects: PROJECTS,
    allJobs: [done("t-new", "image"), done("t-old", "voiceover")],
    settingsOpen: false,
    engineError: null,
    system: null,
    deleteProject,
    openProject,
  } as never);
});

describe("rail quick-tool history", () => {
  it("lists past tool sessions, newest first, and no real projects", () => {
    render(<App />);
    const rows = within(historyGroup())
      .getAllByRole("button")
      .map((node) => node.getAttribute("title"))
      .filter((title): title is string => Boolean(title));
    // Titles appear twice per row (open + delete); the order of first
    // appearance is the render order.
    const seen = [...new Set(rows)];
    expect(seen[0]).toBe("a lighthouse at dusk"); // updated_at 30
    expect(seen).not.toContain("A tour of the solar system");
    expect(seen.some((title) => title.includes("one small step"))).toBe(true);
  });

  it("leaves an open session to the tab list rather than showing it twice", () => {
    useApp.setState({ openProjects: ["t-new"] } as never);
    render(<App />);
    const titles = within(historyGroup())
      .getAllByRole("button")
      .map((node) => node.getAttribute("title"));
    expect(titles).not.toContain("a lighthouse at dusk");
    // ...and it is still reachable, from the tabs above.
    expect(screen.getAllByTitle("a lighthouse at dusk").length).toBeGreaterThan(0);
  });

  it("hides the group entirely when there is no history", () => {
    useApp.setState({ projects: [PROJECTS[0]] } as never);
    render(<App />);
    expect(screen.queryByText(t("nav.recent"))).toBeNull();
  });

  it("opens a session on click", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(within(historyGroup()).getByTitle("a lighthouse at dusk"));
    });
    expect(openProject).toHaveBeenCalledWith("t-new");
  });

  it("asks before deleting, and does nothing if the answer is no", async () => {
    render(<App />);
    fireEvent.click(
      within(historyGroup()).getByLabelText(
        t("nav.deleteToolAria", { title: "a lighthouse at dusk" }),
      ),
    );
    // The safe choice, not the destructive one, is what the dialog offers.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("common.keepIt") }));
    });
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("deletes on confirmation", async () => {
    render(<App />);
    fireEvent.click(
      within(historyGroup()).getByLabelText(
        t("nav.deleteToolAria", { title: "a lighthouse at dusk" }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("home.deleteToolConfirm") }));
    });
    expect(deleteProject).toHaveBeenCalledWith("t-new");
  });

  // deleteProject RETURNS the failure message. Dropping it would leave a
  // failed delete silent: the row simply reappears on the next refresh.
  it("reports a rejected delete instead of swallowing it", async () => {
    deleteProject.mockResolvedValue("Engine unavailable");
    render(<App />);
    fireEvent.click(
      within(historyGroup()).getByLabelText(
        t("nav.deleteToolAria", { title: "a lighthouse at dusk" }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("home.deleteToolConfirm") }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Engine unavailable");
  });
});
