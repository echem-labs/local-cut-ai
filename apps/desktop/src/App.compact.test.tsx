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

/**
 * Compacted, the rail is a column of glyphs — so every row has to explain
 * itself the same way. Two tooltip mechanisms in one 200px strip (a styled
 * bubble on the destinations, the browser's native title on everything else)
 * read as two kinds of control, and the app's own bubble is the one that can
 * be placed: beside the row, where the first row still has somewhere to put
 * it. The brand mark belongs to the title bar; the Home row takes the home
 * icon, exactly as the Library row takes the library icon.
 */
describe("the compact rail explains itself one way", () => {
  // Every button in the strip, the tab's ✕ included: it is the one control
  // there that is not self-evident, so it is the last place a second tooltip
  // mechanism may hide.
  const railButtons = () => Array.from(rail().querySelectorAll("button"));

  it("wraps every control in the app's own tooltip, and none in a native title", () => {
    localStorage.setItem(RAIL_KEY, "0");
    width(false);
    useApp.setState({
      projects: [
        { id: "p1", title: "How Honeybees Make Honey", created_at: 0, updated_at: 0, mode: "prompt", approvals: [] },
      ],
      openProjects: ["p1"],
    } as never);
    render(<App />);
    const buttons = railButtons();
    expect(buttons.length).toBeGreaterThan(4);
    for (const button of buttons) {
      expect(button.closest(".tip-wrap")).not.toBeNull();
      expect(button.getAttribute("title")).toBeNull();
    }
  });

  it("gives Home the home icon, not the brand mark the title bar already carries", () => {
    localStorage.setItem(RAIL_KEY, "0");
    width(false);
    render(<App />);
    // The mark draws its own rounded-square plate; no rail row may.
    expect(rail().querySelector('svg[viewBox="0 0 96 96"]')).toBeNull();
    expect(document.querySelector('.titlebar svg[viewBox="0 0 96 96"]')).not.toBeNull();
  });
});
