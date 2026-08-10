/**
 * What dropping a file on the app is allowed to do.
 *
 * Two of these are about damage rather than convenience. A file dropped on
 * an Electron page that has not been told otherwise NAVIGATES THE WINDOW to
 * it — the running app is replaced by a picture, with no way back but a
 * reload — so the default has to be prevented on every drag event, not just
 * the drop. And a dropped voice sample must not be a way past the question
 * the file picker asks: `graph/patch.py` refuses a `voice_ref` that is not
 * consented, and this surface is what earns the affirmation it sends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { useApp } from "../store";
import { DropTarget } from "./DropTarget";

const uploadSceneImage = vi.fn(async (_file: File) => ({ nodeId: "asset-abc" }) as {
  nodeId?: string;
  error?: string;
});
const conditionScene = vi.fn(async (_sceneId: string, _file: File) => null as string | null);
// Nothing on this machine can see, so the New scene dialog offers no
// Generate button — which is not what these tests are about.
const visionModel = vi.fn(async () => ({ model: null, kind: null }));
const applySessionVoiceClone = vi.fn(async (_file: File) => null as string | null);

const file = (name: string, type: string, bytes = "x") =>
  new File([bytes], name, { type });

/** A DragEvent carrying files, the way the browser delivers one. */
function dropOf(files: File[]): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, items: files.map((f) => ({ type: f.type })), types: ["Files"] },
  });
  return event;
}

/** A drop that lands ON something — the board reads `event.target` to decide
 *  whether the image is a scene's still or a new scene. */
function dropOnScene(sceneId: string, files: File[]): Element {
  const card = document.createElement("div");
  card.setAttribute("data-scene", sceneId);
  document.body.appendChild(card);
  card.dispatchEvent(dropOf(files));
  return card;
}

function dragOf(name: string, files: { type: string }[]): Event {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [], items: files, types: ["Files"] },
  });
  return event;
}

beforeEach(() => {
  uploadSceneImage.mockClear();
  conditionScene.mockClear();
  applySessionVoiceClone.mockClear();
  uploadSceneImage.mockResolvedValue({ nodeId: "asset-abc" });
  conditionScene.mockResolvedValue(null);
  applySessionVoiceClone.mockResolvedValue(null);
  useApp.setState({
    uploadSceneImage,
    conditionScene,
    applySessionVoiceClone,
    client: { visionModel },
    board: { scenes: [], aux: {} },
  } as never);
});

afterEach(cleanup);

describe("dropping a file on the app", () => {
  it("stops the window navigating to whatever was dropped", async () => {
    // The whole app is replaced by the file otherwise. The default is
    // decided at dragover, so preventing only `drop` is not enough.
    render(<DropTarget />);

    const over = dragOf("dragover", [{ type: "image/png" }]);
    await act(async () => void window.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);

    const dropped = dropOf([file("shot.png", "image/png")]);
    await act(async () => void window.dispatchEvent(dropped));
    expect(dropped.defaultPrevented).toBe(true);
  });

  it("asks what the new scene should say rather than making a blank one", async () => {
    // `add_scene` leaves prompt and narration empty, and the compiler reads
    // empty as "not ready" — a scene made here and now would never render.
    render(<DropTarget />);

    await act(async () => void window.dispatchEvent(dropOf([file("shot.png", "image/png")])));

    expect(uploadSceneImage).toHaveBeenCalledTimes(1);
    expect(uploadSceneImage.mock.calls[0]![0].name).toBe("shot.png");
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent(t("drop.sceneBody")),
    );
  });

  it("asks about a voice before uploading one, and does not upload if refused", async () => {
    render(<DropTarget />);

    await act(async () => void window.dispatchEvent(dropOf([file("me.wav", "audio/wav")])));

    // Nothing has been sent yet: the dialog is the consent, not a receipt.
    expect(applySessionVoiceClone).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(t("drop.consentBody"));
    // And the confirm cannot be pressed until the box is ticked.
    expect(screen.getByText(t("drop.consentConfirm"))).toBeDisabled();

    fireEvent.click(screen.getByText(t("drop.consentCancel")));
    expect(applySessionVoiceClone).not.toHaveBeenCalled();
  });

  it("uploads the voice sample once consent is given", async () => {
    render(<DropTarget />);
    await act(async () => void window.dispatchEvent(dropOf([file("me.wav", "audio/wav")])));

    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByText(t("drop.consentConfirm")));
    });

    expect(applySessionVoiceClone).toHaveBeenCalledTimes(1);
    expect(applySessionVoiceClone.mock.calls[0]![0].name).toBe("me.wav");
  });

  it("says what it cannot use rather than failing silently", async () => {
    render(<DropTarget />);

    await act(async () => void window.dispatchEvent(dropOf([file("notes.pdf", "application/pdf")])));

    expect(uploadSceneImage).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      t("drop.unsupported", { name: "notes.pdf" }),
    );
  });

  it("reports a rejection from the store instead of claiming success", async () => {
    uploadSceneImage.mockResolvedValue({ error: t("drop.needsProject") });
    render(<DropTarget />);

    await act(async () => void window.dispatchEvent(dropOf([file("shot.png", "image/png")])));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(t("drop.needsProject")),
    );
  });

  it("colours the notice by what it is reporting", async () => {
    // Green, amber and red are what the status tokens already mean
    // everywhere else in the app; a bar that reports a refusal in the same
    // colour as a success makes the reader parse the sentence to find out
    // which happened.
    useApp.setState({ board: { scenes: [{ scene_id: "s1", clip: {}, keyframe: null }], aux: {} } } as never);
    render(<DropTarget />);

    // Dropped ON a scene with no picture yet: applied straight away, so the
    // success bar is what it reports.
    await act(async () => void dropOnScene("s1", [file("shot.png", "image/png")]));
    await waitFor(() => expect(screen.getByRole("status")).toHaveClass("success"));

    cleanup();
    render(<DropTarget />);
    await act(async () => void window.dispatchEvent(dropOf([file("notes.pdf", "application/pdf")])));
    expect(screen.getByRole("status")).toHaveClass("warning");

    cleanup();
    uploadSceneImage.mockResolvedValue({ error: "upload failed" });
    render(<DropTarget />);
    await act(async () => void window.dispatchEvent(dropOf([file("shot.png", "image/png")])));
    await waitFor(() => expect(screen.getByRole("status")).toHaveClass("error"));
  });

  it("takes itself down rather than waiting to be dismissed", async () => {
    // The drop is over by the time this appears. A notice left up is still
    // on screen during the NEXT drop, describing the wrong file.
    vi.useFakeTimers();
    try {
      render(<DropTarget />);
      // An unsupported file: refused outright, so the bar is the whole
      // outcome and there is no dialog in the way of it.
      await act(async () => void window.dispatchEvent(dropOf([file("notes.pdf", "application/pdf")])));
      await act(async () => {});
      expect(screen.getByRole("status")).toBeInTheDocument();

      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds while it is being read", async () => {
    // A refusal is the longest thing this says, and one that clears itself
    // mid-sentence cannot be read at all.
    vi.useFakeTimers();
    try {
      render(<DropTarget />);
      await act(async () => void window.dispatchEvent(dropOf([file("notes.pdf", "application/pdf")])));
      await act(async () => {});
      const bar = screen.getByRole("status");
      fireEvent.mouseEnter(bar);

      await act(async () => void vi.advanceTimersByTime(30_000));
      expect(screen.getByRole("status")).toBeInTheDocument();

      fireEvent.mouseLeave(bar);
      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the overlay up while the drag crosses elements inside the window", async () => {
    // dragenter/dragleave fire for every element the pointer crosses, so a
    // naive open/close flickers the overlay across the whole window.
    render(<DropTarget />);

    await act(async () => void window.dispatchEvent(dragOf("dragenter", [{ type: "image/png" }])));
    await act(async () => void window.dispatchEvent(dragOf("dragenter", [{ type: "image/png" }])));
    await act(async () => void window.dispatchEvent(dragOf("dragleave", [{ type: "image/png" }])));

    // The overlay's presence is the point here; what it SAYS depends on what
    // is under the pointer and is pinned in DropTarget.scene.test.tsx.
    expect(screen.getByRole("note")).toBeInTheDocument();

    await act(async () => void window.dispatchEvent(dragOf("dragleave", [{ type: "image/png" }])));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
