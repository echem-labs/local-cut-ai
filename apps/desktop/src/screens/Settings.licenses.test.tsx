/**
 * The attribution list renders what the collector actually carried.
 *
 * `third-party-notices.test.ts` asserts that `collectLicenses()` picks up the
 * texts; it says nothing about whether a user can read them. Two branches sit
 * between the data and the reader and neither had a test: the `<details>`
 * disclosure for a package that published a notice, and the plain line for
 * one that did not. The second is not hypothetical — three of the ten entries
 * that ship today (the dockview family) publish no license file, so it is the
 * branch a real user meets in the real dialog.
 *
 * Driven off `__OSS_LICENSES__` rather than a fixture, for the same reason
 * `Settings.tips.test.tsx` scans the dialog rather than a list of labels: a
 * hardcoded pair of entries says nothing about the next dependency added.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { t } from "../i18n";
import { useApp } from "../store";

const client = {
  baseUrl: "http://127.0.0.1:7830",
  listProviders: async () => [],
  llmModels: async () => ({ models: [] }),
};

async function openLicenses() {
  useApp.setState({
    settingsOpen: true,
    settingsTab: "about",
    client,
    remotePaired: false,
    remote: false,
    projects: [],
    models: [],
    refreshStorage: vi.fn(async () => {}),
    refreshModels: vi.fn(async () => {}),
  } as never);
  await act(async () => render(<Settings />));
  await act(async () => {
    fireEvent.click(screen.getByText(t("settings.about.licenses")));
  });
}

/** Modal portals to <body>, so the list is found on the document. */
const rows = () => Array.from(document.querySelectorAll(".licenses-list > li"));

describe("Settings - open-source licenses", () => {
  beforeEach(() => {
    useApp.setState({ settingsOpen: false } as never);
  });

  it("shows one row per collected entry", async () => {
    await openLicenses();
    expect(rows().length).toBe(__OSS_LICENSES__.length);
  });

  it("puts every carried notice behind a disclosure the keyboard can scroll", async () => {
    await openLicenses();
    const withText = __OSS_LICENSES__.filter((e) => e.text);
    // The premise of the whole panel: at least one package published a notice.
    expect(withText.length).toBeGreaterThan(0);
    for (const entry of withText) {
      const row = rows().find((li) => li.querySelector(".lic-name")?.textContent === entry.name);
      expect(row, `${entry.name} has no row`).toBeTruthy();
      const pre = row?.querySelector("details.lic-text pre");
      expect(pre, `${entry.name} renders no license text`).toBeTruthy();
      expect(pre?.textContent).toBe(entry.text);
      // The UA's own focus stop on the scrollport is anonymous, so the name
      // has to come from here. NOT tabbable, though: a tabindex inside a
      // collapsed <details> would win Modal's initial-focus query and then
      // refuse the focus it was given.
      expect(pre?.getAttribute("role")).toBe("note");
      expect(pre?.getAttribute("aria-label")).toContain(entry.name);
      expect(pre?.getAttribute("tabindex")).toBeNull();
      expect(row?.querySelector(".lic-none")).toBeNull();
    }
  });

  it("names each disclosure for its own package, not seven of the same", async () => {
    await openLicenses();
    const summaries = [...document.querySelectorAll("details.lic-text > summary")];
    expect(summaries.length).toBeGreaterThan(1);
    const labels = summaries.map((s) => s.getAttribute("aria-label"));
    for (const label of labels) expect(label).toBeTruthy();
    // Distinctness is the point, not merely having a label: a rotor listing
    // seven controls all reading "License text" tells a screen-reader user
    // nothing about which notice each one opens.
    expect(new Set(labels).size).toBe(summaries.length);
  });

  it("says so, without a disclosure, for a package that published none", async () => {
    await openLicenses();
    const without = __OSS_LICENSES__.filter((e) => !e.text);
    for (const entry of without) {
      const row = rows().find((li) => li.querySelector(".lic-name")?.textContent === entry.name);
      expect(row, `${entry.name} has no row`).toBeTruthy();
      expect(row?.querySelector(".lic-none")?.textContent).toBe(t("settings.about.licensesNoText"));
      // No empty disclosure to open onto nothing.
      expect(row?.querySelector("details.lic-text")).toBeNull();
    }
  });
});
