import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

/** A controllable matchMedia: tests flip `matches` and fire the change
 * event the way a real window resize would. */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const list = {
    get matches() {
      return matches;
    },
    media: "",
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => {
      listeners.delete(fn);
    },
  };
  vi.stubGlobal("matchMedia", () => list);
  return {
    resize(next: boolean) {
      matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery", () => {
  it("reads the real match on mount - no false first frame", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 1000px)"));
    expect(result.current).toBe(true);
  });

  it("follows change events", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 1000px)"));
    expect(result.current).toBe(false);
    act(() => media.resize(true));
    expect(result.current).toBe(true);
    act(() => media.resize(false));
    expect(result.current).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 1000px)"));
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
