import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

/**
 * UI-1 and UI-2. Both are about a modal that is only visually modal.
 *
 * These could not be caught by review alone: the UI-1 bug was a dependency
 * array, and its symptom (the confirm button unreachable by keyboard) only
 * appears when something re-renders the PARENT — a download ticking, a
 * render publishing progress — which is exactly the state a destructive
 * confirmation is most likely to be shown in.
 */

function Harness({
  onConfirm = () => {},
  onCancel = () => {},
  tick = 0,
}: {
  onConfirm?: () => void;
  onCancel?: () => void;
  tick?: number;
}) {
  // Inline arrows, as every real caller writes them: a new function identity
  // on every render. That is what put onCancel in the effect's dep list and
  // made the focus effect re-run continuously.
  return (
    <div>
      <span data-testid="tick">{tick}</span>
      <ConfirmDialog
        title="Delete project"
        message="This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => onConfirm()}
        onCancel={() => onCancel()}
      />
    </div>
  );
}

describe("ConfirmDialog", () => {
  it("opens with focus on the safe action", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("keeps the confirm button reachable while the parent re-renders (UI-1)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(<Harness onConfirm={onConfirm} tick={0} />);

    // Tab off the safe default onto the destructive one, as a keyboard user
    // would. (Not .focus() — the point is that the keyboard path works.)
    await user.tab();
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toHaveFocus();

    // Something in the app re-renders the parent — a job progress event, a
    // download tick. Nothing about it touches focus. With onCancel in the
    // dep list the focus effect re-ran here and yanked focus back to Cancel,
    // so Delete could never be reached by keyboard at all.
    for (let n = 1; n <= 3; n++) {
      rerender(<Harness onConfirm={onConfirm} tick={n} />);
    }
    expect(screen.getByTestId("tick")).toHaveTextContent("3");
    expect(confirm).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("traps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const close = screen.getByRole("button", { name: "Close" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete" });

    // Focus opens on the SAFE action, not on the shell's close button and
    // not on Delete — the whole point of a confirmation.
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    // Past the last control, focus cycles back to the dialog's first —
    // which is the header's close button — rather than walking out into
    // the page behind.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("cancels on Escape without leaking it to the layer behind (UI-2)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    // Stands in for the Settings overlay / Inspector drawer, which register
    // their own window-level Escape handlers and sit underneath this dialog.
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<Harness onCancel={onCancel} />);
      await user.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledOnce();
      // stopImmediatePropagation, not just stopPropagation: the layer behind
      // listens on window too, so dismissing the confirmation used to dismiss
      // Settings in the same keystroke.
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("cancels when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    // From the document, not the render container: `Modal` portals to
    // <body>, so the backdrop is not under the caller's node.
    await user.click(document.querySelector(".modal-backdrop") as HTMLElement);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("marks itself as a modal alert dialog for assistive tech", () => {
    render(<Harness />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Delete project");
  });
});
