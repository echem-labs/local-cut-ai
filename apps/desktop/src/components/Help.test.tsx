/**
 * The two reference dialogs: shortcuts and the glossary.
 *
 * Both were flat lists — 15 rows and 32 rows with nothing dividing them —
 * and the restructure into groups is the kind of edit that quietly drops a
 * row. So the shortcut set is pinned by content rather than by count, and
 * the key caps are pinned by shape: a combo is one cap per key, because a
 * single cap reading "Ctrl Shift Z" is a box, not a keyboard.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { HelpMenu, OPEN_GLOSSARY_EVENT, OPEN_SHORTCUTS_EVENT } from "./Help";
import { m, t } from "../i18n";

const openShortcuts = () => {
  render(<HelpMenu />);
  fireEvent(window, new CustomEvent(OPEN_SHORTCUTS_EVENT));
};

const openGlossary = () => {
  render(<HelpMenu />);
  fireEvent(window, new CustomEvent(OPEN_GLOSSARY_EVENT));
};

beforeEach(() => {
  localStorage.clear();
});

describe("the shortcut overlay", () => {
  it("keeps every shortcut the flat list had", () => {
    // The groups exist to retire four parentheticals, not to lose rows.
    const keys = m()
      .help.shortcutGroups.flatMap((group) => group.items)
      .map((entry) => entry.keys);
    for (const expected of ["Ctrl K", "/", "?", "F2", "Space", "Enter", "R", "P", "Esc", "Ctrl Z"]) {
      expect(keys).toContain(expected);
    }
    // The one row that was two shortcuts wearing one cap is now two rows.
    expect(keys).toContain("Ctrl +");
    expect(keys).toContain("Ctrl −");
    expect(keys).not.toContain("Ctrl + / Ctrl −");
  });

  it("draws one cap per key, so a combo reads as a keyboard", () => {
    openShortcuts();
    const row = screen.getByText("Redo").closest(".prow");
    const caps = [...(row?.querySelectorAll("kbd") ?? [])].map((cap) => cap.textContent);
    expect(caps).toEqual(["Ctrl", "Shift", "Z"]);
  });

  it("groups the rows, and says nothing twice about where they apply", () => {
    openShortcuts();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll(".well").length).toBeGreaterThan(1);
    // "(from anywhere)" and "(Home or Library)" were a heading's job done
    // one row at a time; the group headers do it once.
    expect(dialog.textContent).not.toMatch(/from anywhere/i);
    expect(dialog.textContent).not.toMatch(/Home or Library/i);
  });
});

describe("the glossary", () => {
  it("says how big the haystack is before anything is typed", () => {
    openGlossary();
    const count = m().terms.glossary.length;
    expect(screen.getByLabelText(t("help.modal.searchAria"))).toHaveAttribute(
      "placeholder",
      expect.stringContaining(String(count)) as unknown as string,
    );
  });

  it("filters on the definition, not only the term", async () => {
    openGlossary();
    // "animated" appears in definitions and in no term, so a match proves
    // the filter reads the body rather than the heading alone.
    await userEvent.type(screen.getByLabelText(t("help.modal.searchAria")), "animated");
    const terms = [...document.querySelectorAll(".gentry dt")].map((node) => node.textContent);
    expect(terms).toContain("Clip");
    expect(terms.length).toBeLessThan(m().terms.glossary.length);
  });

  it("offers the way back when nothing matches", async () => {
    openGlossary();
    const box = screen.getByLabelText(t("help.modal.searchAria"));
    await userEvent.type(box, "zzzzz");
    expect(document.querySelectorAll(".gentry")).toHaveLength(0);
    // The same well with the needle at zero, and a control that empties
    // the box — a dead end otherwise, since the search is the only thing
    // on screen and it is the thing that is wrong.
    await userEvent.click(screen.getByRole("button", { name: t("help.modal.clearSearch") }));
    expect(box).toHaveValue("");
    expect(document.querySelectorAll(".gentry").length).toBeGreaterThan(0);
  });
});
