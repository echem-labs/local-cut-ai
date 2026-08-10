/**
 * Where an image lands decides what it means.
 *
 * Dropped on a scene it is that shot's still; dropped anywhere else in an
 * open project it is a new scene. The old behaviour — upload it as a
 * free-floating asset and tell the user to go wire it up on the flowchart —
 * was the app explaining its data model instead of doing what was meant.
 *
 * The replace question is asked only when there is something to lose. A
 * scene that has never rendered a picture has nothing to confirm about, and
 * a dialog there is a click charged for nothing.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeState, SceneCardModel } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { DropTarget } from "./DropTarget";

const uploadSceneImage = vi.fn(async (_file: File) => ({ nodeId: "asset-abc" }) as {
  nodeId?: string;
  error?: string;
});
const conditionScene = vi.fn(async (_id: string, _file: File) => null as string | null);
const addSceneFromImage = vi.fn(
  async (_id: string, _fields: { narration: string; prompt: string }) => null as string | null,
);
const suggestScene = vi.fn(async (_id: string) => ({ narration: "N", prompt: "P" }));
const listProviders = vi.fn(async () => [
  { id: "anthropic", label: "Anthropic", capabilities: ["text", "vision"], configured: true },
]);

const node = (id: string, hash: string | null): NodeState =>
  ({ node_id: id, status: "draft", progress: 1, error: null, artifact_hash: hash, params: {}, seed: 0, model: null, pinned: false }) as NodeState;

const scene = (over: Partial<SceneCardModel> = {}): SceneCardModel =>
  ({ scene_id: "s1", keyframe: node("s1.keyframe", null), clip: node("s1.clip", null), narration: null, ...over }) as SceneCardModel;

const file = (name: string, type: string) => new File(["x"], name, { type });

function dropOn(sceneId: string | null, files: File[]): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, items: files.map((f) => ({ type: f.type })), types: ["Files"] },
  });
  if (sceneId === null) {
    window.dispatchEvent(event);
    return;
  }
  const card = document.createElement("div");
  card.setAttribute("data-scene", sceneId);
  document.body.appendChild(card);
  card.dispatchEvent(event);
}

function mount(scenes: SceneCardModel[] = [scene()]) {
  useApp.setState({
    uploadSceneImage,
    conditionScene,
    addSceneFromImage,
    suggestScene,
    client: { listProviders },
    board: { scenes, aux: {} },
  } as never);
  return render(<DropTarget />);
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadSceneImage.mockResolvedValue({ nodeId: "asset-abc" });
  conditionScene.mockResolvedValue(null);
  addSceneFromImage.mockResolvedValue(null);
});

afterEach(cleanup);

describe("an image dropped on a scene", () => {
  it("becomes that scene's still", async () => {
    mount();

    await act(async () => void dropOn("s1", [file("shot.png", "image/png")]));

    expect(conditionScene).toHaveBeenCalledTimes(1);
    expect(conditionScene.mock.calls[0]![0]).toBe("s1");
    expect(uploadSceneImage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        t("drop.stillApplied", { name: "shot.png", n: "1" }),
      ),
    );
  });

  it("asks first when that scene already shows a picture", async () => {
    mount([scene({ keyframe: node("s1.keyframe", "abc123") })]);

    await act(async () => void dropOn("s1", [file("shot.png", "image/png")]));

    expect(conditionScene).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(t("drop.replaceTitle"));
  });

  it("replaces it once that is confirmed", async () => {
    mount([scene({ keyframe: node("s1.keyframe", "abc123") })]);
    await act(async () => void dropOn("s1", [file("shot.png", "image/png")]));

    await act(async () => {
      fireEvent.click(screen.getByText(t("drop.replaceConfirm")));
    });

    expect(conditionScene).toHaveBeenCalledTimes(1);
  });

  it("counts the user's own image as a picture worth asking about", async () => {
    // The card draws `still` when there is one, so that is what a second
    // drop would be replacing — asking only about the generated keyframe
    // would overwrite the user's previous photo without a word.
    mount([scene({ keyframe: node("s1.keyframe", null), still: node("asset-old", "def456") })]);

    await act(async () => void dropOn("s1", [file("shot.png", "image/png")]));

    expect(conditionScene).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("an image dropped anywhere else in a project", () => {
  it("offers to build a scene from it", async () => {
    mount();

    await act(async () => void dropOn(null, [file("shot.png", "image/png")]));

    expect(uploadSceneImage).toHaveBeenCalledTimes(1);
    // Nothing landed yet: a scene with no words never renders, so the graph
    // is not touched until the dialog has them.
    expect(addSceneFromImage).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("will not add the scene until both fields say something", async () => {
    mount();
    await act(async () => void dropOn(null, [file("shot.png", "image/png")]));
    await waitFor(() => screen.getByRole("dialog"));

    expect(screen.getByText(t("drop.sceneAdd"))).toBeDisabled();

    fireEvent.change(screen.getByLabelText(t("drop.sceneNarration")), {
      target: { value: "The city wakes." },
    });
    expect(screen.getByText(t("drop.sceneAdd"))).toBeDisabled();

    fireEvent.change(screen.getByLabelText(t("drop.scenePrompt")), {
      target: { value: "a slow push in" },
    });
    expect(screen.getByText(t("drop.sceneAdd"))).toBeEnabled();
  });

  it("lands the image and the words together", async () => {
    mount();
    await act(async () => void dropOn(null, [file("shot.png", "image/png")]));
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.change(screen.getByLabelText(t("drop.sceneNarration")), {
      target: { value: "The city wakes." },
    });
    fireEvent.change(screen.getByLabelText(t("drop.scenePrompt")), {
      target: { value: "a slow push in" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText(t("drop.sceneAdd")));
    });

    expect(addSceneFromImage).toHaveBeenCalledWith("asset-abc", {
      narration: "The city wakes.",
      prompt: "a slow push in",
    });
  });

  it("can have the model write both from the image", async () => {
    mount();
    await act(async () => void dropOn(null, [file("shot.png", "image/png")]));
    await waitFor(() => screen.getByText(t("drop.sceneGenerate")));

    await act(async () => {
      fireEvent.click(screen.getByText(t("drop.sceneGenerate")));
    });

    expect(suggestScene).toHaveBeenCalledWith("asset-abc");
    expect(screen.getByLabelText(t("drop.sceneNarration"))).toHaveValue("N");
    expect(screen.getByLabelText(t("drop.scenePrompt"))).toHaveValue("P");
  });

  it("hides the offer on a machine with no key for it", async () => {
    // A button that can only fail is worse than no button: the engine's
    // refusal names Settings, which the user reads only after clicking.
    listProviders.mockResolvedValueOnce([
      { id: "anthropic", label: "Anthropic", capabilities: ["text", "vision"], configured: false },
    ]);
    mount();

    await act(async () => void dropOn(null, [file("shot.png", "image/png")]));
    await waitFor(() => screen.getByRole("dialog"));

    expect(screen.queryByText(t("drop.sceneGenerate"))).toBeNull();
  });
});
