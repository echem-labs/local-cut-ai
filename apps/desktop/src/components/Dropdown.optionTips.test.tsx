/**
 * An open menu raises a different question than a closed one.
 *
 * The trigger's bubble explains the CONTROL — "Visual style", "the look the
 * shot prompts are written for". Once the list is open that question is
 * answered and a new one takes its place: what is Watercolor, actually? A
 * word everyone knows and a look nobody can picture this model's version of.
 * So every option carries its own bubble, and the hint is optional — without
 * one the label alone still earns the bubble, because these menus ellipse
 * (a model id cut to fit the row is complete in the tooltip).
 *
 * The wrapper is presentational on purpose. `role="listbox"` owns its
 * `role="option"` children, and a bare span between the two is a foreign
 * node in that relationship; marked presentational it leaves the tree and
 * the options stay owned directly.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dropdown, type DropdownOption } from "./Dropdown";

const OPTIONS: DropdownOption<string>[] = [
  { value: "cinematic", label: "Cinematic", hint: "Shallow depth, dramatic light." },
  { value: "anime", label: "Anime", hint: "Cel shading and expressive faces." },
  { value: "plain", label: "Plain" },
];

const open = async () => {
  const user = userEvent.setup();
  render(
    <Dropdown value="cinematic" options={OPTIONS} onChange={vi.fn()} ariaLabel="Visual style" />,
  );
  await user.click(screen.getByRole("button", { name: /Visual style/ }));
  return user;
};

describe("the options in an open menu", () => {
  it("explains the one under the cursor", async () => {
    const user = await open();
    await user.hover(screen.getByRole("option", { name: /Anime/ }));
    const tip = document.querySelector(".tip");
    expect(tip).toBeTruthy();
    expect(tip?.textContent).toContain("Anime");
    expect(tip?.textContent).toContain("Cel shading");
  });

  it("still names an option that carries no hint", async () => {
    const user = await open();
    await user.hover(screen.getByRole("option", { name: /Plain/ }));
    expect(document.querySelector(".tip")?.textContent).toContain("Plain");
  });

  it("takes the bubble away when the cursor leaves", async () => {
    const user = await open();
    const anime = screen.getByRole("option", { name: /Anime/ });
    await user.hover(anime);
    expect(document.querySelector(".tip")).toBeTruthy();
    await user.unhover(anime);
    expect(document.querySelector(".tip")).toBeNull();
  });

  it("gives every option a bubble, not just the ones with copy", async () => {
    await open();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    const bare = options
      .filter((option) => !option.closest(".tip-wrap"))
      .map((option) => option.textContent);
    expect(bare).toEqual([]);
  });

  // The listbox must still own its options: a generic span between them
  // would make these unreachable as a group for assistive tech.
  it("keeps the listbox owning its options", async () => {
    await open();
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    for (const wrapper of listbox.querySelectorAll(".tip-wrap")) {
      expect(wrapper.getAttribute("role")).toBe("presentation");
    }
  });

  it("does not break picking an option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Dropdown value="cinematic" options={OPTIONS} onChange={onChange} ariaLabel="Visual style" />,
    );
    await user.click(screen.getByRole("button", { name: /Visual style/ }));
    await user.click(screen.getByRole("option", { name: /Anime/ }));
    expect(onChange).toHaveBeenCalledWith("anime");
  });
});
