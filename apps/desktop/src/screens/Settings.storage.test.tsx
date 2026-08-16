/**
 * Settings → Storage, the quick-tool half.
 *
 * `GET /storage` reports every `.lcut` directory the same way — it has no
 * idea which are quick tool sessions — so the split is made here against
 * `mode` from the project list. That is the load-bearing bit: get it wrong
 * and "Clear outputs" either misses sessions or offers to delete the user's
 * actual videos, and the confirmation copy tells them the wrong thing about
 * what they are about to lose.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "./Settings";
import { formatSize } from "../components/ModelLibrary";
import { t } from "../i18n";
import { useApp } from "../store";

const STORAGE = {
  projects: [
    { id: "v1", title: "A tour of the solar system", bytes: 90_000_000 },
    { id: "t1", title: "a lighthouse at dusk", bytes: 1_000_000 },
    { id: "t2", title: "one small step", bytes: 1_000_000 },
  ],
  models_bytes: 0,
  cache_bytes: 0,
  disk_free_bytes: 1_000_000_000,
  disk_total_bytes: 2_000_000_000,
};

const PROJECTS = [
  { id: "v1", title: "A tour of the solar system", created_at: 0, mode: "prompt", approvals: [] },
  { id: "t1", title: "a lighthouse at dusk", created_at: 0, mode: "tool:image", approvals: [] },
  { id: "t2", title: "one small step", created_at: 0, mode: "tool:voiceover", approvals: [] },
];

/** The button's own label, built from the same formatter the row uses, so
 * this test pins the COUNT and the TOTAL rather than a size-format string. */
const clearLabel = () =>
  t("settings.storage.clearTools_other", { count: 2, size: formatSize(2_000_000) });

let deleteToolSessions: ReturnType<typeof vi.fn>;
let deleteProject: ReturnType<typeof vi.fn>;

async function mount(projects = PROJECTS) {
  deleteToolSessions = vi.fn(async () => null);
  deleteProject = vi.fn(async () => null);
  useApp.setState({
    settingsOpen: true,
    settingsTab: "storage",
    storage: STORAGE,
    storageStale: false,
    projects,
    deleteToolSessions,
    deleteProject,
    refreshStorage: vi.fn(async () => {}),
  } as never);
  await act(async () => {
    render(<Settings />);
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("Settings → Storage, quick tool outputs", () => {
  it("counts and sizes only the tool sessions, never the projects", async () => {
    await mount();
    // Two sessions at 1 MB each — the 90 MB video is not in this total.
    expect(screen.getByRole("button", { name: clearLabel() })).toBeTruthy();
  });

  it("offers nothing to clear when the only projects are real ones", async () => {
    await mount([PROJECTS[0]]);
    const button = screen
      .getAllByRole("button")
      .find((node) => node.textContent?.startsWith("Clear 0"));
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears the history only after confirmation", async () => {
    await mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: clearLabel(),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    });
    expect(deleteToolSessions).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: clearLabel(),
      }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: t("settings.storage.clearToolsConfirm") }),
      );
    });
    expect(deleteToolSessions).toHaveBeenCalled();
  });

  // The per-row trash in "Projects by size" deletes from the same list, so
  // it has to tell the truth about which kind of thing is going away.
  it("uses one-off copy when the row being deleted is a tool session", async () => {
    await mount();
    fireEvent.click(
      screen.getByLabelText(t("settings.storage.deleteAria", { title: "a lighthouse at dusk" })),
    );
    // Named for what it is, not for the app's own data model: this row is
    // an image, and "quick tool output" was the phrase every one of these
    // used no matter which of the six made it.
    expect(screen.getByText(t("home.deleteToolMessage", { noun: "image" }))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t("home.deleteToolConfirm", { noun: "image" }) }),
    ).toBeTruthy();
  });

  it("names the other kinds too, from the tool the session ran", async () => {
    await mount();
    fireEvent.click(
      screen.getByLabelText(t("settings.storage.deleteAria", { title: "one small step" })),
    );
    expect(screen.getByText(t("home.deleteToolMessage", { noun: "voiceover" }))).toBeTruthy();
  });

  it("keeps the project warning for a real project", async () => {
    await mount();
    fireEvent.click(
      screen.getByLabelText(
        t("settings.storage.deleteAria", { title: "A tour of the solar system" }),
      ),
    );
    expect(screen.getByText(t("home.deleteMessage"))).toBeTruthy();
  });
});
