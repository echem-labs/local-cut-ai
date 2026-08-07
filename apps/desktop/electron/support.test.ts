/**
 * The support bundle — the file a user hands over when something is wrong.
 *
 * Two things are pinned here, and they fail differently. The *contents*: a
 * bundle missing the engine version answers none of the first questions a
 * report raises, and nobody notices an absent file in a zip they never open.
 * And the *container*: this writes the ZIP byte layout by hand (the packaged
 * build carries no runtime node_modules, see electron-builder.yml), so an
 * archive nothing can open is a real and silent failure mode — the export
 * succeeds, the file exists, and it is rubble.
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { bundleEntries, zipEntries } from "./support";

const SYSTEM = { hardware: { tier: "A", ram_gb: 32 }, backend_mode: "local" };
const VERSIONS = { app: "0.1.0", engine: "0.1.0", api: 1 };

/** The central directory, parsed back out — the half a reader actually
 * navigates by. Deliberately independent of the writer: reading back with
 * the writer's own offsets would agree with any self-consistent garbage. */
function readCentralDirectory(zip: Buffer): { name: string; body: Buffer }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const entries: { name: string; body: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    // Walk the local header too: its own name/extra lengths are what a
    // reader uses to find the payload, and they are stored separately.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressed);
    entries.push({ name, body: method === 8 ? inflateRawSync(raw) : raw });
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return entries;
}

describe("what goes in the bundle", () => {
  it("carries the logs, the versions and the system report", () => {
    const entries = bundleEntries({
      versions: VERSIONS,
      system: SYSTEM,
      logs: [{ name: "localcut.log", data: Buffer.from("[engine] started\n") }],
    });

    // Exhaustive, not a subset: this list IS the contract with whoever
    // reads a bundle, and a quietly dropped file reads as "nothing was
    // wrong there" rather than as a gap.
    expect(entries.map((entry) => entry.name)).toEqual([
      "versions.json",
      "system.json",
      "logs/localcut.log",
    ]);
    expect(JSON.parse(entries[0].data.toString())).toEqual(VERSIONS);
    expect(JSON.parse(entries[1].data.toString())).toEqual(SYSTEM);
  });

  it("still produces a bundle when the engine never answered", () => {
    // The moment a support bundle is most wanted is the moment the engine
    // is unreachable — so null has to travel, and be visibly null, rather
    // than collapse the export into an error.
    const entries = bundleEntries({ versions: VERSIONS, system: null, logs: [] });
    expect(entries.map((entry) => entry.name)).toEqual(["versions.json", "system.json"]);
    expect(JSON.parse(entries[1].data.toString())).toBeNull();
  });

  it("keeps every log file, under a folder of their own", () => {
    const entries = bundleEntries({
      versions: VERSIONS,
      system: SYSTEM,
      logs: [
        { name: "localcut.log", data: Buffer.from("now") },
        { name: "localcut.log.1", data: Buffer.from("before") },
      ],
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      "versions.json",
      "system.json",
      "logs/localcut.log",
      "logs/localcut.log.1",
    ]);
  });
});

describe("the archive itself", () => {
  it("round-trips every entry through a reader that only trusts the zip", () => {
    const zip = zipEntries([
      { name: "versions.json", data: Buffer.from('{"app":"0.1.0"}') },
      // Long and repetitive: deflate has to actually shrink something, or
      // the store-vs-deflate branch is never exercised.
      { name: "logs/localcut.log", data: Buffer.from("[engine] started\n".repeat(200)) },
    ]);

    const entries = readCentralDirectory(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["versions.json", "logs/localcut.log"]);
    expect(entries[0].body.toString()).toBe('{"app":"0.1.0"}');
    expect(entries[1].body.toString()).toBe("[engine] started\n".repeat(200));
    expect(zip.length).toBeLessThan(17 * 200);
  });

  it("writes an empty archive rather than a truncated one", () => {
    // A zip with no entries is still a valid zip: 22 bytes of EOCD. Half a
    // header is what an early return would leave.
    const zip = zipEntries([]);
    expect(readCentralDirectory(zip)).toEqual([]);
    expect(zip.length).toBe(22);
  });

  it("stores a name that gains bytes in UTF-8 at its encoded length", () => {
    // The name length in the header is BYTES. Taking it from String.length
    // puts every following offset short by the difference, which a reader
    // sees as a corrupt archive — and only for non-ASCII names.
    const zip = zipEntries([{ name: "logs/café.log", data: Buffer.from("x") }]);
    expect(readCentralDirectory(zip)[0].name).toBe("logs/café.log");
  });

  it("declares its names as UTF-8 in both headers", () => {
    // Bit 11 of the general purpose flag. Without it the format says the
    // name is CP437, and a reader that obeys that — Python's zipfile, for
    // one — cannot find the entry under the name it was written with. The
    // test above cannot catch this on its own: it decodes as UTF-8, which
    // is to say it agrees with the writer instead of with the spec.
    const zip = zipEntries([{ name: "logs/café.log", data: Buffer.from("x") }]);
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800); // local header
    expect(zip.readUInt16LE(central + 8) & 0x0800).toBe(0x0800); // directory
  });
});
