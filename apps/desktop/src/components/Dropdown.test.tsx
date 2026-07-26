import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dropdown, type DropdownOption } from "./Dropdown";

/**
 * UI-4. The option list is not static: it is rebuilt from the models list,
 * so a download finishing or a model being deleted rewrites it while the
 * menu is open. The retained activeIndex then points past the end, and Enter
 * dereferenced undefined — a TypeError thrown out of a keydown handler,
 * which React does not catch.
 */

const OPTIONS: DropdownOption<string>[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

describe("Dropdown", () => {
  it("picks the highlighted option with Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Dropdown value="a" options={OPTIONS} onChange={onChange} ariaLabel="Pick one" />);

    await user.click(screen.getByRole("button", { name: /Pick one/ }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("survives the list shrinking under an open menu (UI-4)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Dropdown value="a" options={OPTIONS} onChange={onChange} ariaLabel="Pick one" />,
    );

    await user.click(screen.getByRole("button", { name: /Pick one/ }));
    await user.keyboard("{ArrowDown}{ArrowDown}"); // activeIndex = 2 (Charlie)

    // A download finishes and the list is rebuilt with fewer entries. The
    // retained index now points past the end.
    rerender(
      <Dropdown value="a" options={OPTIONS.slice(0, 1)} onChange={onChange} ariaLabel="Pick one" />,
    );

    // Must not throw a TypeError out of the keydown handler.
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("a"); // clamped to the last valid option
  });

  it("does nothing rather than throwing when the list empties entirely", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Dropdown value="a" options={OPTIONS} onChange={onChange} ariaLabel="Pick one" />,
    );
    await user.click(screen.getByRole("button", { name: /Pick one/ }));
    rerender(<Dropdown value="a" options={[]} onChange={onChange} ariaLabel="Pick one" />);

    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Dropdown value="a" options={OPTIONS} onChange={vi.fn()} ariaLabel="Pick one" />);
    await user.click(screen.getByRole("button", { name: /Pick one/ }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
