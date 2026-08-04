/**
 * The Library screen (U2). What is worth pinning is what the split has to
 * keep true: the filter decides which pool is listed and the counts agree
 * with it, search and sort are applied to that pool and not to the page
 * already drawn, paging never hides a filter change, and "Save as
 * template…" is offered for a video but never for a one-off output.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { Library } from "./Library";

const project = (id: string, mode: string, title: string, updated_at: number): Project => ({
  id,
  title,
  created_at: updated_at,
  updated_at,
  mode,
  approvals: [],
});

const VIDEOS = [
  project("v1", "prompt", "Bee documentary", 50),
  project("v2", "prompt", "Cat explainer", 40),
];
const TOOLS = [
  project("t1", "tool:image", "a lighthouse at dusk", 30),
  project("t2", "tool:voiceover", "one small step", 20),
  project("t3", "tool:music", "ukulele loop", 10),
];

const seed = (projects: Project[] = [...VIDEOS, ...TOOLS]) =>
  useApp.setState({
    projects,
    allJobs: [],
    client: null,
    libraryOpen: true,
    libraryFilter: "all",
    librarySearchFocus: 0,
    openProject: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => null),
    renameProject: vi.fn(async () => null),
    duplicateProject: vi.fn(async () => null),
  } as never);

const titles = () =>
  Array.from(document.querySelectorAll(".project-tile .title")).map((node) => node.textContent);

beforeEach(() => {
  localStorage.clear();
  seed();
});

describe("filters", () => {
  it("counts each pool and lists the one that is picked", () => {
    render(<Library />);
    expect(screen.getByRole("button", { name: t("library.filterAll", { count: 5 }) })).toBeInTheDocument();
    expect(titles()).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: t("library.filterVideos", { count: 2 }) }));
    expect(titles()).toEqual(["Bee documentary", "Cat explainer"]);

    fireEvent.click(screen.getByRole("button", { name: t("library.filterTools", { count: 3 }) }));
    expect(titles()).toEqual(["a lighthouse at dusk", "one small step", "ukulele loop"]);
  });

  it("says what an empty pool means rather than showing an empty grid", () => {
    seed(VIDEOS);
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: t("library.filterTools", { count: 0 }) }));
    expect(screen.getByText(t("library.emptyTools"))).toBeInTheDocument();
  });
});

describe("search and sort", () => {
  it("filters within the pool and reports a query that matches nothing", () => {
    render(<Library />);
    const box = screen.getByLabelText(t("library.searchAria"));
    fireEvent.change(box, { target: { value: "cat" } });
    expect(titles()).toEqual(["Cat explainer"]);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(t("library.noMatch", { q: "zzz" }))).toBeInTheDocument();
  });

  it("sorts by title in code-unit order, not the machine's locale", () => {
    seed([
      project("a", "prompt", "Zebra", 10),
      project("b", "prompt", "apple", 20),
      project("c", "prompt", "Apple", 30),
    ]);
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: /Sort the library/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: t("library.sortName") }));
    // Uppercase sorts before lowercase — deterministic across machines,
    // which localeCompare is not.
    expect(titles()).toEqual(["Apple", "Zebra", "apple"]);
  });

  it("reverses the order when the sort already in force is picked again", () => {
    seed([
      project("a", "prompt", "Zebra", 10),
      project("b", "prompt", "apple", 20),
      project("c", "prompt", "Apple", 30),
    ]);
    render(<Library />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: /Sort the library/ }));
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: t("library.sortName") }));
    expect(titles()).toEqual(["Apple", "Zebra", "apple"]);
    // Same field again: the other end first, and the chip says which way.
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(t("library.sortName")) }));
    expect(titles()).toEqual(["apple", "Zebra", "Apple"]);
  });

  it("takes the keyboard when something asks it to", async () => {
    render(<Library />);
    await act(async () => {
      useApp.getState().openLibrary({ focusSearch: true });
    });
    expect(document.activeElement).toBe(screen.getByLabelText(t("library.searchAria")));
  });
});

describe("paging", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    project(`p${i}`, "prompt", `Video ${String(i).padStart(2, "0")}`, 100 - i),
  );

  it("shows a first page and loads the rest on demand", () => {
    seed(many);
    render(<Library />);
    expect(titles()).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: t("library.loadMore_other", { count: 6 }) }));
    expect(titles()).toHaveLength(30);
  });

  it("starts over when the filter changes, so the tail of the old list is never shown", () => {
    seed([...many, ...TOOLS]);
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: t("library.loadMore_other", { count: 9 }) }));
    expect(titles()).toHaveLength(33);
    fireEvent.click(screen.getByRole("button", { name: t("library.filterVideos", { count: 30 }) }));
    expect(titles()).toHaveLength(24);
  });
});

describe("the tile menu", () => {
  it("offers a template for a video and not for a tool output", () => {
    render(<Library />);
    const tiles = document.querySelectorAll(".project-tile");
    const video = tiles[0] as HTMLElement;
    fireEvent.click(within(video).getByLabelText(t("home.tileMenuAria", { title: "Bee documentary" })));
    expect(within(video).getByRole("menuitem", { name: t("library.saveTemplate") })).toBeInTheDocument();

    const tool = document.querySelector('[data-project="t1"]') as HTMLElement;
    fireEvent.click(
      within(tool).getByLabelText(t("home.tileMenuAria", { title: "a lighthouse at dusk" })),
    );
    expect(within(tool).queryByRole("menuitem", { name: t("library.saveTemplate") })).toBeNull();
  });
});
