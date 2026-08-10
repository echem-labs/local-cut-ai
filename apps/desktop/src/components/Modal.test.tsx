import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal";

/* Vite's raw glob rather than node:fs — the renderer project types are
   `vite/client` only, deliberately, so a test here reads sources the same
   way the bundle would. */
const SOURCES = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("the dialog shell", () => {
  it("puts the title, the body and the actions in three fixed places", () => {
    render(
      <Modal title="Enable pack" subtitle="github.com/example/pack" onClose={() => {}} footer={<button>Enable</button>}>
        <p>Body text</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Enable pack");
    expect(dialog.querySelector(".modal-head h2")).toHaveTextContent("Enable pack");
    expect(dialog.querySelector(".modal-sub")).toHaveTextContent("github.com/example/pack");
    expect(dialog.querySelector(".modal-body")).toHaveTextContent("Body text");
    expect(dialog.querySelector(".modal-foot")).toHaveTextContent("Enable");
  });

  it("leaves out the subtitle and the footer rather than reserving empty space", () => {
    render(
      <Modal title="Bare" onClose={() => {}}>
        <p>Only a body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".modal-sub")).toBeNull();
    expect(dialog.querySelector(".modal-foot")).toBeNull();
  });

  it("offers the same close control in every dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Shortcuts" onClose={onClose}>
        <p>keys</p>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape and on the backdrop, but not on the dialog itself", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Confirm" onClose={onClose}>
        <p>sure?</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    // Queried from the document, not from the render container: the dialog
    // is portaled to <body>, so it is not under the caller's node.
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog", () => {
    render(
      <Modal title="Form" onClose={() => {}} footer={<button>Save</button>}>
        <input aria-label="name" />
      </Modal>,
    );
    // DOM order is head → body → foot, so the close button is the first
    // control and the footer's last button is the last one.
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });

    save.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it("opens with the body's first field focused, not the close button", () => {
    // Landing on ✕ would make the first Enter dismiss the dialog.
    render(
      <Modal title="Form" onClose={() => {}} footer={<button>Save</button>}>
        <input aria-label="version" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("version"));
  });

  it("renders at the top level, not inside whatever opened it", () => {
    // The rail's Help menu renders its dialog as a sibling of the ? button,
    // which made the dialog a DOM descendant of `.rail` — and
    // `.rail .tip-wrap { width: 100% }` then reached the close button's
    // tooltip wrapper and stretched ✕ across the whole header. The title,
    // a flex sibling with `min-width: 0` and `overflow-wrap: anywhere`,
    // took the squeeze and rendered one letter per line.
    //
    // `position: fixed` takes a dialog out of the visual flow but NOT out
    // of the selector tree, so only the portal makes a dialog independent
    // of where it was opened from.
    render(
      <div className="rail">
        <Modal title="Keyboard shortcuts" onClose={() => {}}>
          <p>keys</p>
        </Modal>
      </div>,
    );

    const backdrop = document.querySelector(".modal-backdrop")!;
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.closest(".rail")).toBeNull();
  });

  it("hands focus back to whatever opened it", () => {
    render(<button>opener</button>);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    const view = render(
      <Modal title="Anything" onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    view.unmount();
    expect(document.activeElement).toBe(opener);
  });
});

/**
 * The cohesion rule, as a test rather than as a convention.
 *
 * Five dialogs used to build their own backdrop around their own markup —
 * two of them trapping no focus at all, three inventing their own header,
 * and four picking their own width. The fix is only durable if the next
 * dialog cannot quietly do it again, and nothing about a hand-rolled
 * backdrop looks wrong in review.
 */
describe("every dialog uses the shell", () => {
  it("has no component building its own backdrop", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([file]) => !file.endsWith("/Modal.tsx") && !file.endsWith(".test.tsx"))
      .filter(([, source]) => source.includes('className="modal-backdrop"'))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  // The stylesheet half of this rule — that no dialog picks its own width —
  // lives in engine/tests/test_ui_contract.py. Vitest stubs CSS imports to
  // an empty string (css: false), so a check written here would read "" and
  // pass against anything. It did, until the empty string was noticed.
});
