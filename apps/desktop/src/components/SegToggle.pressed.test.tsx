/**
 * Every segmented toggle says which option is on.
 *
 * A `.seg-toggle` is a `role="group"` of buttons where exactly one is the
 * current choice, and that choice was drawn only by the `active` class. A
 * screen reader heard "Auto, button" and "Review steps, button" with nothing
 * to tell them apart, so the one control that decides whether a render stops
 * for review could not be read without sight. Each button now carries
 * `aria-pressed`, the state the app's other toggle buttons (the take chips,
 * pin) already expose, and `group` stays the container role CLAUDE.md lists.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { Home } from "../screens/Home";
import { Settings } from "../screens/Settings";
import { useApp } from "../store";
import { FilterTabs } from "./FilterTabs";
import { ModelLibrary } from "./ModelLibrary";

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  localStorage.clear();
});

describe("Home's generation mode", () => {
  beforeEach(() => {
    useApp.setState({
      client: null,
      projects: [],
      allJobs: [],
      models: [],
      system: null,
      templates: [],
      libraryOpen: false,
      settingsOpen: false,
      homeDraft: { prompt: "", tool: null, toolInput: "", voice: "", motion: "", scriptModel: "" },
      defaults: {
        aspect: "16:9",
        duration: 60,
        mode: "prompt",
        style: "cinematic",
        voice: "",
        videoModel: null,
      },
      refreshHome: vi.fn(async () => {}),
    } as never);
  });

  it("says which mode is on, and follows the click", () => {
    render(<Home />);
    expect(pressed(t("home.modeAuto"))).toBe("true");
    expect(pressed(t("home.modeReview"))).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: t("home.modeReview") }));
    expect(pressed(t("home.modeReview"))).toBe("true");
    expect(pressed(t("home.modeAuto"))).toBe("false");
  });
});

describe("Settings", () => {
  async function mount(tab: string) {
    useApp.setState({
      settingsOpen: true,
      settingsTab: tab,
      client: null,
      defaults: {
        aspect: "16:9",
        duration: 60,
        mode: "beginner",
        style: "cinematic",
        voice: "",
        videoModel: null,
      },
    } as never);
    await act(async () => render(<Settings />));
  }

  it("says which default mode is on, and follows the click", async () => {
    await mount("defaults");
    expect(pressed(t("home.modeReview"))).toBe("true");
    expect(pressed(t("home.modeAuto"))).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: t("home.modeAuto") }));
    expect(pressed(t("home.modeAuto"))).toBe("true");
    expect(pressed(t("home.modeReview"))).toBe("false");
  });

  // Asked of the pane rather than of a list of toggles, so the next one
  // added to it is held to the same rule.
  it.each(["general", "defaults"])("marks exactly one option of each toggle on the %s tab", async (tab) => {
    await mount(tab);
    const groups = document.querySelectorAll(".seg-toggle");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const buttons = Array.from(group.querySelectorAll("button"));
      const states = buttons.map((button) => button.getAttribute("aria-pressed"));
      expect(states.every((state) => state === "true" || state === "false")).toBe(true);
      expect(states.filter((state) => state === "true")).toHaveLength(1);
    }
  });
});

describe("the shared filter tabs", () => {
  it("say which filter is on", () => {
    const onChange = vi.fn();
    render(
      <FilterTabs
        ariaLabel="filter"
        value="all"
        onChange={onChange}
        options={[
          { value: "fits", label: "Fits" },
          { value: "all", label: "All" },
        ]}
      />,
    );
    expect(pressed("All")).toBe("true");
    expect(pressed("Fits")).toBe("false");
  });
});

describe("the custom model's source", () => {
  it("says whether it is a link or a file", () => {
    useApp.setState({ models: [], downloadErrors: {}, refreshModels: vi.fn(async () => {}) } as never);
    render(<ModelLibrary showAddCustom />);
    fireEvent.click(screen.getByRole("button", { name: t("models.custom.addEntry") }));
    expect(pressed(t("models.custom.sourceUrl"))).toBe("true");
    expect(pressed(t("models.custom.sourceFile"))).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: t("models.custom.sourceFile") }));
    expect(pressed(t("models.custom.sourceFile"))).toBe("true");
    expect(pressed(t("models.custom.sourceUrl"))).toBe("false");
  });
});
