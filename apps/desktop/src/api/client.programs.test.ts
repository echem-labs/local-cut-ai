/**
 * The program routes, as docs/programs.md gives them. Setup and cancel share
 * one path and differ only by method, and removing LocalCut's copy is a
 * DELETE one segment shorter: a method or a segment wrong here cancels a
 * setup the user asked for, or removes a copy they wanted to keep.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineClient } from "./client";

const client = () => new EngineClient({ url: "http://127.0.0.1:7830", token: "t" });

function capture(body: unknown) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the program routes", () => {
  it("starts a setup with a POST that carries no body", async () => {
    const calls = capture({ status: "started", job: "3f9c2a7d1e04" });
    await client().startProgramSetup("ffmpeg");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:7830/programs/ffmpeg/setup", method: "POST" },
    ]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("cancels a setup with a DELETE on the same path", async () => {
    const calls = capture({ ok: true });
    await client().cancelProgramSetup("ffmpeg");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:7830/programs/ffmpeg/setup", method: "DELETE" },
    ]);
  });
});
