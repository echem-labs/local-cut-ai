/**
 * Preferences that read localStorage before anything can catch a throw.
 *
 * `initTheme()` is called at module scope in main.tsx and `useWorkspace`'s
 * initializer runs during the import graph — both finish before React mounts,
 * so before the ErrorBoundary exists. localStorage is not guaranteed: a
 * restrictive storage policy, a disk-full profile or a corrupt origin store
 * makes `getItem` throw, and an exception escaping module evaluation stops
 * the bundle. The window comes up blank with nothing rendered and nothing
 * logged where a user could see it.
 *
 * The contract these lock: a preference that cannot be read falls back to the
 * default, and one that cannot be written still applies for this session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DENIED = () => {
  throw new DOMException("access denied", "SecurityError");
};

/** A localStorage exactly like a blocked one: present on window, throwing on
 * use. Deleting the global instead would be a different (and milder) bug —
 * `localStorage.getItem` would throw a ReferenceError we could not distinguish
 * from a typo. */
function blockStorage() {
  vi.stubGlobal("localStorage", {
    getItem: DENIED,
    setItem: DENIED,
    removeItem: DENIED,
    clear: DENIED,
    key: DENIED,
    length: 0,
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Unstub first: the real localStorage has to be back before it can be
  // cleared, and clearing here rather than at the end of each test means a
  // failing assertion cannot leak a key into the next one.
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.resetModules();
});

describe("the theme, with storage blocked", () => {
  it("comes up on the default instead of throwing out of module scope", async () => {
    blockStorage();
    const { initTheme, loadThemePref, resolvedTheme } = await import("./theme");

    expect(loadThemePref()).toBe("system");
    initTheme(); // this is the call main.tsx makes before React exists
    expect(resolvedTheme()).toBe("dark");
  });

  it("still applies a chosen theme for this session", async () => {
    blockStorage();
    const { applyTheme, resolvedTheme } = await import("./theme");

    applyTheme("light");

    // Only the persistence is lost — the window is themed as asked.
    expect(resolvedTheme()).toBe("light");
  });

  it("still reads a stored preference when storage works", async () => {
    // The guard must not have turned the preference into a no-op.
    localStorage.setItem("localcut.theme", "light");
    const { loadThemePref } = await import("./theme");

    expect(loadThemePref()).toBe("light");
  });
});

describe("the workspace layout, with storage blocked", () => {
  it("builds its store on the defaults", async () => {
    blockStorage();
    // The failure mode: this import itself threw, and every module that
    // imports it (the whole shell) never evaluated.
    const { useWorkspace } = await import("./lib/workspace");

    expect(useWorkspace.getState().view).toBe("storyboard");
    expect(useWorkspace.getState().density).toBe("m");
  });

  it("still switches view and density for this session", async () => {
    blockStorage();
    const { useWorkspace } = await import("./lib/workspace");

    useWorkspace.getState().setView("player");
    useWorkspace.getState().setDensity("l");

    expect(useWorkspace.getState().view).toBe("player");
    expect(useWorkspace.getState().density).toBe("l");
  });

  it("still restores what was stored when storage works", async () => {
    localStorage.setItem("localcut.workspace.view", "player");
    localStorage.setItem("localcut.board.density", "s");
    const { useWorkspace } = await import("./lib/workspace");

    expect(useWorkspace.getState().view).toBe("player");
    expect(useWorkspace.getState().density).toBe("s");
  });
});
