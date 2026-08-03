/**
 * The rail's two reasons for being compact, and why they must not be the
 * same reason.
 *
 * One is a preference the user set and we persist; the other is the window
 * being too narrow to hold a 200px labeled rail beside the reading column.
 * Conflating them costs the preference: the toggle would flip a stored value
 * that the viewport immediately overrides, so the click looks broken AND
 * silently discards the choice the user made at a wider size.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { t } from "./i18n";
import { useApp } from "./store";

const RAIL_KEY = "localcut.rail.expanded";

/** matchMedia with a fixed answer — the suite's default stub always says
 * false, which would keep every test on the wide branch. */
function width(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const rail = () => document.querySelector("nav.rail") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    connect: vi.fn(async () => {}),
    client: null,
    firstRunDone: true,
    currentProject: null,
    openProjects: [],
    projects: [],
    allJobs: [],
    settingsOpen: false,
    engineError: null,
    system: null,
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("rail compaction", () => {
  it("honors the stored preference at a normal width", () => {
    localStorage.setItem(RAIL_KEY, "1");
    width(false);
    render(<App />);
    expect(rail().classList.contains("compact")).toBe(false);
  });

  it("compacts below the narrow breakpoint even when the preference says expanded", () => {
    localStorage.setItem(RAIL_KEY, "1");
    width(true);
    render(<App />);
    expect(rail().classList.contains("compact")).toBe(true);
  });

  it("keeps the stored preference when the window - not the user - forced it", () => {
    localStorage.setItem(RAIL_KEY, "1");
    width(true);
    render(<App />);
    const toggle = screen.getByRole("button", { name: t("nav.sidebarNarrow") });
    fireEvent.click(toggle);
    expect(localStorage.getItem(RAIL_KEY)).toBe("1");
    expect(rail().classList.contains("compact")).toBe(true);
  });

  it("says why the toggle is unavailable rather than offering a click that does nothing", () => {
    width(true);
    render(<App />);
    const toggle = screen.getByRole("button", { name: t("nav.sidebarNarrow") });
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole("button", { name: t("nav.expandSidebar") })).toBeNull();
  });

  it("still toggles - and persists - at a normal width", () => {
    localStorage.setItem(RAIL_KEY, "1");
    width(false);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: t("nav.collapseSidebar") }));
    expect(localStorage.getItem(RAIL_KEY)).toBe("0");
    expect(rail().classList.contains("compact")).toBe(true);
  });
});
