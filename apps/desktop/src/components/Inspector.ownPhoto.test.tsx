/**
 * "Use my photo" says so when the engine turns the picture down.
 *
 * `conditionScene` reports a refusal by RETURNING the message — the store
 * contract for anything that can be declined. This caller was still written
 * against the older, throwing one:
 *
 *     void conditionScene(sceneId, file).catch((err) => console.warn(...))
 *
 * which is dead code twice over. The promise never rejects, so the handler
 * never runs; and `void` discards the string that carries the reason. A
 * photo the engine refused looked exactly like one it took, until the render
 * came back showing the old image — while the SAME refusal, reached by
 * dropping the file instead, put a banner on screen.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import type { Board, NodeState } from "../api/types";
import { Inspector } from "./Inspector";
import { t } from "../i18n";
import { useApp } from "../store";

const node = (id: string): NodeState => ({
  node_id: id,
  status: "draft",
  progress: 1,
  error: null,
  artifact_hash: "a".repeat(64),
  params: {},
  seed: 0,
  model: null,
  pinned: false,
});

const board: Board = {
  scenes: [
    { scene_id: "s1", keyframe: node("s1.keyframe"), clip: node("s1.clip"), narration: null },
  ],
  aux: {},
};

let conditionScene: ReturnType<typeof vi.fn>;
let clearSceneStill: ReturnType<typeof vi.fn>;

/** The same scene once the user has supplied their own picture: the asset is
 *  on the clip's keyframe port, so the board reports it as `still`. */
const withStill = (over: Partial<NodeState> = {}): Board => ({
  scenes: [
    {
      scene_id: "s1",
      keyframe: node("s1.keyframe"),
      still: { ...node("asset-abc"), ...over },
      clip: node("s1.clip"),
      narration: null,
    },
  ],
  aux: {},
});

function mount(result: string | null, board_: Board = board) {
  conditionScene = vi.fn().mockResolvedValue(result);
  clearSceneStill = vi.fn().mockResolvedValue(null);
  useApp.setState({
    board: board_,
    // The image tab, which is where "use my photo" lives.
    selectedNode: "s1.keyframe",
    conditionScene,
    clearSceneStill,
    client: { artifactUrl: () => "blob:photo" },
    currentProject: { id: "p1", title: "t" },
  } as never);
  render(<Inspector />);
}

/** The file input, whichever of the two labels currently names it. */
const picker = (): HTMLElement =>
  screen.queryByLabelText(t("inspector.useMyPhoto")) ??
  screen.getByLabelText(t("inspector.yourPhoto"));

const pick = (input: HTMLElement) =>
  fireEvent.change(input, { target: { files: [new File(["x"], "shot.png", { type: "image/png" })] } });

beforeEach(() => {
  useApp.setState({ board: null, selectedNode: null } as never);
});

afterEach(cleanup);

describe("the Inspector's own-photo picker", () => {
  it("shows the reason the engine gave", async () => {
    mount("Open a video first.");

    pick(picker());

    expect(conditionScene).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("Open a video first.")).toBeInTheDocument(),
    );
  });

  it("names its scene so a dropped image lands on it", () => {
    // The drop surface reads `data-scene` off whatever the pointer is over,
    // and the board card was the only element carrying it — so dropping a
    // picture on the open scene's own details offered to build a NEW scene,
    // which is the one thing the user cannot have meant while looking at it.
    mount(null);

    expect(document.querySelector(".inspector")).toHaveAttribute("data-scene", "s1");
  });

  it("stops offering what is already done once a photo is there", () => {
    // "Use my photo instead" offers the thing the user has already chosen.
    // With a picture in place the section is ABOUT that picture.
    mount(null, withStill());

    expect(screen.queryByText(t("inspector.useMyPhoto"))).toBeNull();
    expect(screen.getByText(t("inspector.yourPhoto"))).toBeInTheDocument();
    expect(screen.getByAltText(t("inspector.photoAlt", { n: "1" }))).toBeInTheDocument();
  });

  it("asks before handing the scene back to the generated picture", async () => {
    mount(null, withStill());

    await act(async () => {
      fireEvent.click(screen.getByLabelText(t("inspector.photoRemove")));
    });

    expect(clearSceneStill).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(t("inspector.photoRemoveTitle"));

    await act(async () => {
      fireEvent.click(screen.getByText(t("inspector.photoRemoveConfirm")));
    });

    expect(clearSceneStill).toHaveBeenCalledWith("s1");
  });

  it("says nothing when the picture was taken", async () => {
    mount(null);

    pick(picker());

    await waitFor(() => expect(conditionScene).toHaveBeenCalled());
    expect(document.querySelector(".banner.error")).toBeNull();
  });
});
