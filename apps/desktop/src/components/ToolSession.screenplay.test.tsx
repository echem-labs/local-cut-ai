/**
 * `useScreenplay` has to tell three states apart: still arriving, here, and
 * unreadable.
 *
 * Without the `ok` check the engine's error body is JSON too, so a 401 or a
 * 500 parsed cleanly and became the screenplay — the table then read fields
 * off `{detail: "..."}` that are not there. And a request that failed to
 * connect left the panel on "Loading script…" permanently, because the
 * effect only re-runs when the URL changes: restarting the engine did not
 * clear it, and the reason existed only in a console the user cannot see.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useScreenplay } from "./ToolSession";

const SCRIPT = { title: "A strong hook", hook: "It starts with a question.", scenes: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useScreenplay", () => {
  it("reads a rendered screenplay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(SCRIPT) }),
    );
    const { result } = renderHook(() => useScreenplay("http://engine/artifact"));
    await waitFor(() => expect(result.current.screenplay).toEqual(SCRIPT));
    expect(result.current.error).toBeNull();
  });

  it("reports an HTTP refusal instead of accepting the error body as the script", async () => {
    // The shape the engine actually answers with — parseable JSON, which is
    // why this needed the status check rather than a try around the parse.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ detail: "invalid token" }),
      }),
    );
    const { result } = renderHook(() => useScreenplay("http://engine/artifact"));
    await waitFor(() => expect(result.current.error).toBe("401 Unauthorized"));
    expect(result.current.screenplay).toBeNull();
  });

  it("reports a request that never connected, rather than loading forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { result } = renderHook(() => useScreenplay("http://engine/artifact"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.screenplay).toBeNull();
  });

  it("is quiet with no url, which is the genuine loading state", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { result } = renderHook(() => useScreenplay(null));
    expect(result.current.screenplay).toBeNull();
    expect(result.current.error).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
