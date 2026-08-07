/**
 * The log sink. Three things matter and each fails quietly if it breaks:
 * that the tee still reaches the terminal (the rig reads it, and `npm run
 * dev` is how this app is developed), that rotation actually bounds the
 * file, and that a disk which refuses the write does not take the app with
 * it — the wrapper is installed over `console` itself, so an error reported
 * the ordinary way would re-enter the code that just failed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installLogSink, LOG_NAMES, MAX_LOG_BYTES, readLogFiles } from "./logfile";

let dir: string;
const original = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "localcut-logs-"));
});

afterEach(() => {
  // installLogSink replaces the real console; put it back or every later
  // test in this file writes into the previous test's temp directory.
  Object.assign(console, original);
});

const logText = (): string => readFileSync(path.join(dir, LOG_NAMES[0]), "utf8");

describe("teeing console into a file", () => {
  it("writes each level, and still prints to the console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    installLogSink(dir);

    console.log("[engine] started");
    console.warn("[engine] port held by a stale engine");
    console.error("[engine] exited with code 1");

    expect(spy).toHaveBeenCalledWith("[engine] started");
    const written = logText();
    expect(written).toContain("[log] [engine] started");
    expect(written).toContain("[warn] [engine] port held by a stale engine");
    expect(written).toContain("[error] [engine] exited with code 1");
  });

  it("logs an Error's stack rather than the empty object JSON gives it", () => {
    installLogSink(dir);
    console.error("[keys] could not decrypt:", new Error("keychain rotated"));
    expect(logText()).toContain("keychain rotated");
    expect(logText()).not.toContain("{}");
  });

  it("rotates at the cap and keeps exactly one previous file", () => {
    writeFileSync(path.join(dir, LOG_NAMES[0]), "x".repeat(MAX_LOG_BYTES + 1));
    installLogSink(dir);

    console.log("after the rotation");

    expect(logText()).toContain("after the rotation");
    expect(logText().length).toBeLessThan(MAX_LOG_BYTES);
    expect(readFileSync(path.join(dir, LOG_NAMES[1]), "utf8").length).toBe(MAX_LOG_BYTES + 1);
  });

  it("survives a directory it cannot write, without recursing through console", () => {
    // A path whose parent is a FILE: mkdir fails the way a read-only or
    // full disk does, and the sink has to decline rather than throw out of
    // whatever line of app code happened to log next.
    const blocked = path.join(dir, "not-a-dir");
    writeFileSync(blocked, "");

    expect(installLogSink(path.join(blocked, "logs"))).toBeNull();
    expect(() => console.log("still fine")).not.toThrow();
  });
});

describe("collecting the files for a bundle", () => {
  it("returns the current log first, then the rotated one", () => {
    writeFileSync(path.join(dir, LOG_NAMES[0]), "now");
    writeFileSync(path.join(dir, LOG_NAMES[1]), "before");
    expect(readLogFiles(dir).map((file) => [file.name, file.data.toString()])).toEqual([
      [LOG_NAMES[0], "now"],
      [LOG_NAMES[1], "before"],
    ]);
  });

  it("skips a file that is not there instead of carrying an empty one", () => {
    writeFileSync(path.join(dir, LOG_NAMES[0]), "only session");
    expect(readLogFiles(dir).map((file) => file.name)).toEqual([LOG_NAMES[0]]);
  });

  it("returns nothing at all for a directory that does not exist", () => {
    expect(readLogFiles(path.join(dir, "nope"))).toEqual([]);
  });
});
