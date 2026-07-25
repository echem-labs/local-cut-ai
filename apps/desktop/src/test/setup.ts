import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// React Testing Library does not auto-clean without globals+afterEach wiring
// in every file; do it once here so a component left mounted by one test
// cannot receive another test's window-level keydown.
afterEach(cleanup);

/**
 * Browser APIs jsdom does not implement.
 *
 * Each of these is reached by code under test, and jsdom's default is either
 * a missing property or a "Not implemented" console error that buries the
 * real assertion failure. Stubbed to the smallest thing that behaves.
 */

// The zoom module and the theme both read this at import time.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom's HTMLMediaElement throws "Not implemented" for these. The Monitor
// calls play()/pause() on every playback state change.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: vi.fn(),
});

// ErrorBoundary's "Copy details" writes here. Defined unconditionally:
// jsdom does ship a navigator.clipboard, but writing to it needs a permission
// grant that does not exist under test, so the real one rejects. Tests that
// assert on it spy over this per-test.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  writable: true,
  value: { writeText: () => Promise.resolve() },
});

/**
 * The preload bridge. The renderer treats `window.localcut` as always
 * present (it is, in the real app — preload runs first), so leaving it
 * undefined would fail tests for a reason that cannot happen in production.
 */
Object.defineProperty(window, "localcut", {
  configurable: true,
  writable: true,
  value: {
    getEngineConnection: vi.fn().mockResolvedValue({ url: null, token: null }),
    inspectPairing: vi.fn(),
    pairEngine: vi.fn().mockResolvedValue({ ok: true, error: null }),
    unpairEngine: vi.fn().mockResolvedValue({ ok: true, error: null }),
    armProviderKeys: vi.fn().mockResolvedValue({ ok: true, error: null }),
    setProviderKeys: vi.fn(),
    getProviderKeyPresence: vi.fn().mockResolvedValue({}),
  },
});
