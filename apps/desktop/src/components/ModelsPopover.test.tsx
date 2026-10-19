/**
 * The models popover under the prompt: each stage's model, or "Not
 * installed". A stage whose weights are on disk behind a stopped ComfyUI is
 * installed; one whose weights are not is not, whichever of the two the
 * engine names as the gap.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessRow } from "../api/types";
import { t } from "../i18n";
import { useApp } from "../store";
import { ModelsPopover } from "./ModelsPopover";

const comfyDown = (task: string, weights: boolean): ReadinessRow => ({
  kind: task === "music.gen" ? "music" : "keyframe",
  model: null,
  backend: "mock",
  verdict: "placeholder",
  reason: "comfyui_down",
  data: { task, weights_installed: weights },
  fix: null,
});

function open(rows: ReadinessRow[]) {
  useApp.setState({
    system: null,
    models: [],
    readiness: rows,
    openSettings: vi.fn(),
  } as never);
  render(<ModelsPopover />);
  fireEvent.click(screen.getByRole("button", { name: t("home.modelsAria") }));
  return screen.getByRole("menu");
}

const rowOf = (menu: HTMLElement, label: string) =>
  within(menu).getByText(label).closest(".models-pop-row") as HTMLElement;

beforeEach(() => {
  useApp.setState({ readiness: null } as never);
});

describe("a stage behind a ComfyUI that is not running", () => {
  it("is not installed when its weights are not on disk either", () => {
    const menu = open([comfyDown("image.gen", false)]);
    expect(rowOf(menu, "Keyframes")).toHaveTextContent(t("home.notInstalled"));
  });

  it("is installed when its weights are there for ComfyUI to run", () => {
    const menu = open([comfyDown("music.gen", true)]);
    expect(rowOf(menu, "Music")).not.toHaveTextContent(t("home.notInstalled"));
  });
});
