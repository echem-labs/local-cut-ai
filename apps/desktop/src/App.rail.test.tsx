/**
 * The rail's two destinations.
 *
 * Until U2 the rail also carried a list of past tool sessions — the library
 * in the worst possible place for it, growing without bound and duplicating
 * whatever the tabs already showed. That list is now the Library screen, so
 * what is worth pinning here is what replaced it: one row under Home, the
 * same activation rules, a count of everything, and no per-session rows at
 * any length of history.
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

let openProject: ReturnType<typeof vi.fn>;

const PROJECTS = [
  project("v1", "prompt", "A tour of the solar system", 50),
  project("t-old", "tool:voiceover", "one small step", 10),
  project("t-new", "tool:image", "a lighthouse at dusk", 30),
];

const rail = () => screen.getByRole("navigation", { name: t("nav.navigationAria") });
const homeRow = () => within(rail()).getByRole("button", { name: t("nav.home") });
// By accessible name, not position: the rail renders compact under jsdom's
// matchMedia, where Home is a brand mark with a label and no text.
const libraryRow = () => within(rail()).getByRole("button", { name: /^Library/ });

beforeEach(() => {
  localStorage.clear();
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
    libraryOpen: false,
    libraryFilter: "all",
    engineError: null,
    system: null,
    openProject,
  } as never);
});

describe("the rail's Library row", () => {
  it("sits under Home carrying the count of everything made", () => {
    render(<App />);
    // DOCUMENT_POSITION_FOLLOWING: the Library row comes after Home's.
    expect(homeRow().compareDocumentPosition(libraryRow()) & 4).toBeTruthy();
    // The count is everything, videos and tool outputs alike.
    expect(libraryRow().querySelector(".rail-count")?.textContent).toBe("3");
  });

  it("opens the Library, and takes the active state off Home", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(libraryRow());
    });
    expect(useApp.getState().libraryOpen).toBe(true);
    expect(screen.getByRole("heading", { name: t("library.title") })).toBeInTheDocument();
    expect(libraryRow().className).toContain("active");
    expect(homeRow().className).not.toContain("active");
  });

  it("returns to Home, which is active again", async () => {
    render(<App />);
    await act(async () => {
      fireEvent.click(libraryRow());
    });
    await act(async () => {
      fireEvent.click(homeRow());
    });
    expect(useApp.getState().libraryOpen).toBe(false);
    expect(homeRow().className).toContain("active");
  });

  it("never grows a row per tool session, however long the history", () => {
    useApp.setState({
      projects: Array.from({ length: 30 }, (_, i) =>
        project(`t${i}`, "tool:image", `output ${i}`, i),
      ),
    } as never);
    render(<App />);
    expect(screen.queryByTitle("output 3")).toBeNull();
    expect(libraryRow().querySelector(".rail-count")?.textContent).toBe("30");
  });
});
