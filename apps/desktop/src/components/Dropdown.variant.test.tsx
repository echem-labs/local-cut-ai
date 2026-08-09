/**
 * Two looks, and only one of them may carry a caret.
 *
 * The design proposal draws every dropdown on Home and in the composer as a
 * CHIP with no chevron — a chip sits in a row of chips, and the row is what
 * reads as pickable. The home and session parity frames hold that: a caret
 * added to the default would move pixels on frames nothing else touched.
 *
 * A settings row has none of that context. The control stands alone against
 * a label with the width of the pane between them, and a bare word like
 * "Auto" read as a value someone had typed rather than one of several that
 * could be chosen. That variant gets the caret.
 *
 * So this pins the pair: the caret exists where it was asked for, and is
 * absent everywhere else — which is the half a parity frame would catch late
 * and expensively.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dropdown, type DropdownOption } from "./Dropdown";

const OPTIONS: DropdownOption<string>[] = [
  { value: "", label: "Auto" },
  { value: "wan", label: "Wan 2.2" },
];

const trigger = () => screen.getByRole("button", { name: /Video clips/ });

describe("the dropdown's two looks", () => {
  it("draws no caret on a chip", () => {
    render(
      <Dropdown value="" options={OPTIONS} onChange={vi.fn()} ariaLabel="Video clips" />,
    );
    expect(trigger().querySelector(".dropdown-caret")).toBeNull();
    expect(trigger().className).not.toContain("field");
  });

  it("draws one on a field", () => {
    render(
      <Dropdown
        value=""
        options={OPTIONS}
        onChange={vi.fn()}
        ariaLabel="Video clips"
        variant="field"
      />,
    );
    expect(trigger().querySelector(".dropdown-caret")).not.toBeNull();
    expect(trigger().className).toContain("field");
  });

  it("keeps the caret out of the accessible name", () => {
    // It is decoration for the pointer; the control already says what it is.
    render(
      <Dropdown
        value=""
        options={OPTIONS}
        onChange={vi.fn()}
        ariaLabel="Video clips"
        variant="field"
      />,
    );
    expect(trigger().querySelector(".dropdown-caret")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("still opens and picks as a field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Dropdown
        value=""
        options={OPTIONS}
        onChange={onChange}
        ariaLabel="Video clips"
        variant="field"
      />,
    );
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: /Wan 2.2/ }));
    expect(onChange).toHaveBeenCalledWith("wan");
  });
});
