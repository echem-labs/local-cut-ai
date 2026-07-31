/** The save points dialog: create from the input, restore/delete per row,
 * and a rejection message surfaced in place instead of vanishing. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SavePoints } from "./SavePoints";
import { useApp } from "../store";

const HISTORY = (savepoints: { id: string; label: string; at: number }[]) => ({
  undo_depth: 0,
  redo_depth: 0,
  undo_top: null,
  redo_top: null,
  savepoints,
});

let createSavepoint: ReturnType<typeof vi.fn>;
let restoreSavepoint: ReturnType<typeof vi.fn>;
let deleteSavepoint: ReturnType<typeof vi.fn>;

function mount(savepoints: { id: string; label: string; at: number }[] = []) {
  createSavepoint = vi.fn().mockResolvedValue(null);
  restoreSavepoint = vi.fn().mockResolvedValue(null);
  deleteSavepoint = vi.fn().mockResolvedValue(null);
  useApp.setState({
    history: HISTORY(savepoints),
    createSavepoint,
    restoreSavepoint,
    deleteSavepoint,
  } as never);
  const onClose = vi.fn();
  render(<SavePoints onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  useApp.setState({ history: null } as never);
});

describe("SavePoints", () => {
  it("creates a save point from the trimmed label", async () => {
    mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  before final  " } });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(createSavepoint).toHaveBeenCalledWith("before final");
  });

  it("restores a listed save point", () => {
    mount([{ id: "sp1", label: "start", at: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(restoreSavepoint).toHaveBeenCalledWith("sp1");
  });

  it("deletes a listed save point", () => {
    mount([{ id: "sp1", label: "start", at: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(deleteSavepoint).toHaveBeenCalledWith("sp1");
  });

  it("shows the engine's refusal instead of swallowing it", async () => {
    mount([{ id: "sp1", label: "start", at: 1 }]);
    restoreSavepoint.mockResolvedValue("engine 409: nope");
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("engine 409: nope");
  });

  it("escape closes the dialog", () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
