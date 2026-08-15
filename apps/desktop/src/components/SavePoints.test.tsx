/** The save points dialog: create from the input, restore/delete per row,
 * and a rejection message surfaced in place instead of vanishing. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SavePoints } from "./SavePoints";
import { t } from "../i18n";
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

  it("asks before deleting a save point, and does nothing if the answer is no", () => {
    // Restore needs no confirmation because it lands in the undo history —
    // one Ctrl+Z walks back out of it. That reasoning has never applied to
    // delete, which sits two pixels away and is not undoable.
    mount([{ id: "sp1", label: "start", at: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: /delete save point start/i }));
    expect(deleteSavepoint).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    expect(deleteSavepoint).not.toHaveBeenCalled();
  });

  it("deletes a listed save point once confirmed", () => {
    mount([{ id: "sp1", label: "start", at: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: /delete save point start/i }));
    // The confirm names the victim, so the right one is checkable rather
    // than merely trusted.
    expect(screen.getByRole("alertdialog")).toHaveTextContent("start");
    fireEvent.click(screen.getByRole("button", { name: t("project.savepoints.delete") }));
    expect(deleteSavepoint).toHaveBeenCalledWith("sp1");
  });

  it("shows the engine's refusal instead of swallowing it", async () => {
    // As an Alert: this was an unstyled `role="status"` div, so a failed
    // restore was invisible on screen and, being a polite live region,
    // could go unannounced as well.
    mount([{ id: "sp1", label: "start", at: 1 }]);
    restoreSavepoint.mockResolvedValue("engine 409: nope");
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("engine 409: nope");
  });

  it("names each version by when it was taken", () => {
    // `SavePointInfo.at` is on the wire and was dropped on the floor, so
    // two versions saved twenty minutes apart were indistinguishable.
    mount([{ id: "sp1", label: "start", at: 1_755_000_000 }]);
    expect(screen.getByRole("listitem").textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("escape closes the dialog", () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
