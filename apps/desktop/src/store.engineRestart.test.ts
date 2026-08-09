/**
 * Bringing the engine back after it stopped on its own.
 *
 * The banner's whole value is that one button fixes it, so the two ways
 * that button can lie are what matter: reporting success when the engine
 * did not come back, and clearing the crash when it did not — either one
 * takes the report and the retry off screen and leaves the app looking
 * intact while doing nothing, which is the state the banner exists to end.
 *
 * `restartEngine` follows the store's rejection contract: `null` means it
 * applied, and every other outcome — including "there is no shell to ask" —
 * comes back as a message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineCrash } from "./api/types";
import { t } from "./i18n";

const connection = vi.hoisted(() => ({ ok: true }));

vi.mock("./api/client", () => ({
  EngineClient: class {
    baseUrl = "http://127.0.0.1:7830";
    subscribe() {
      return () => {};
    }
    system = vi.fn(async () => null);
    listProjects = vi.fn(async () => []);
    listJobs = vi.fn(async () => []);
  },
}));

const { useApp } = await import("./store");

const CRASH: EngineCrash = { code: 1, signal: null, tail: ["[engine] boom"], at: "2026-08-09T00:00:00Z" };

/** A shell whose restart succeeds or fails, and whose connection follows. */
function shell(restart: { ok: boolean; error: string | null }) {
  (window as unknown as { localcut: unknown }).localcut = {
    restartEngine: vi.fn(async () => restart),
    getEngineConnection: vi.fn(async () =>
      connection.ok
        ? { connection: { url: "http://127.0.0.1:7830", token: "t" }, error: null }
        : { connection: null, error: "engine unavailable" },
    ),
  };
}

beforeEach(() => {
  connection.ok = true;
  useApp.setState({ engineCrash: CRASH, engineError: null, client: null } as never);
});

describe("restarting the engine from the crash banner", () => {
  it("clears the crash once the engine is answering again", async () => {
    shell({ ok: true, error: null });

    const message = await useApp.getState().restartEngine();

    expect(message).toBeNull();
    expect(useApp.getState().engineCrash).toBeNull();
  });

  it("keeps the crash when the shell could not start it", async () => {
    shell({ ok: false, error: "port 7830 is held by another process" });

    const message = await useApp.getState().restartEngine();

    expect(message).toBe("port 7830 is held by another process");
    expect(useApp.getState().engineCrash).toEqual(CRASH);
  });

  it("keeps the crash when it started but never came back", async () => {
    // The subtle half: the shell reports a clean spawn and the engine still
    // does not answer. Reporting success here would clear the banner on an
    // app that is still dead.
    shell({ ok: true, error: null });
    connection.ok = false;

    const message = await useApp.getState().restartEngine();

    expect(message).not.toBeNull();
    expect(useApp.getState().engineCrash).toEqual(CRASH);
  });

  it("reports rather than throwing when there is no shell to ask", async () => {
    delete (window as unknown as { localcut?: unknown }).localcut;

    await expect(useApp.getState().restartEngine()).resolves.toBe(t("errors.engineUnavailable"));
  });
});
