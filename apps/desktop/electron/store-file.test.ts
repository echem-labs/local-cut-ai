/**
 * The durability promises made by store-file.ts, exercised against a real
 * filesystem rather than a mocked `fs` — the whole point of the module is what
 * survives on disk, and a mock can only confirm which calls were made.
 *
 * Both files this backs (provider keys, the remote pairing) hold credentials
 * the user cannot re-derive from anywhere else, so "the write half-finished"
 * and "the read gave up quietly" are the two failures worth encoding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson, writeJsonAtomic } from "./store-file";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localcut-store-"));
  file = path.join(dir, "keys.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const siblings = (): string[] => fs.readdirSync(dir);

describe("writeJsonAtomic", () => {
  it("round-trips a value and creates the directory it lands in", () => {
    const nested = path.join(dir, "deep", "nested", "keys.json");
    writeJsonAtomic(nested, { anthropic: "sk-1", nested: { ok: true } });
    expect(readJson(nested)).toEqual({ anthropic: "sk-1", nested: { ok: true } });
  });

  it("leaves no temp file behind", () => {
    writeJsonAtomic(file, { a: 1 });
    expect(siblings()).toEqual(["keys.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "creates the file 0600, so credentials are never briefly world-readable",
    () => {
      // The mode is passed to open(), not applied afterwards: a write-then-chmod
      // publishes the keys to every local user for the length of the write.
      writeJsonAtomic(file, { anthropic: "sk-secret" });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")("keeps 0600 when overwriting a laxer file", () => {
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    writeJsonAtomic(file, { anthropic: "sk-secret" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous file intact when serialization fails mid-write", () => {
    writeJsonAtomic(file, { anthropic: "sk-original" });
    // BigInt is the cheapest way to make JSON.stringify throw after the temp
    // file has already been opened — the exact shape of a write that dies
    // between "created the temp" and "renamed it into place".
    expect(() => writeJsonAtomic(file, { bad: 1n })).toThrow(TypeError);

    expect(readJson(file)).toEqual({ anthropic: "sk-original" });
    expect(siblings()).toEqual(["keys.json"]);
  });

  it("does not leak the file handle when the rename fails", () => {
    // A directory where the target should be: renameSync fails, and the
    // `finally` still has to close the descriptor and remove the temp.
    fs.mkdirSync(file);
    const closeSync = vi.spyOn(fs, "closeSync");
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow();
    expect(closeSync).toHaveBeenCalled();
    expect(siblings()).toEqual(["keys.json"]);
  });
});

describe("readJson", () => {
  it("answers null for a file that was never written", () => {
    expect(readJson(file)).toBeNull();
  });

  it("answers null for a directory, rather than throwing out of a caller", () => {
    fs.mkdirSync(file);
    expect(readJson(file)).toBeNull();
  });

  it("quarantines a corrupt file instead of discarding it", () => {
    // Treating corruption as "no keys yet" is what turns one bad write into
    // permanent loss: the caller reads an empty set, the user re-enters one
    // key, and the read-modify-write cycle overwrites the others.
    fs.writeFileSync(file, '{"anthropic": "sk-half-writ');
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readJson(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);

    const kept = siblings().filter((name) => name.includes(".corrupt-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]!), "utf8")).toBe('{"anthropic": "sk-half-writ');
  });

  it("still answers null when the corrupt file cannot even be moved aside", () => {
    fs.writeFileSync(file, "not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM");
    });
    // The caller gets the same empty answer either way; what it must never get
    // is an exception out of a startup read.
    expect(readJson(file)).toBeNull();
  });
});
