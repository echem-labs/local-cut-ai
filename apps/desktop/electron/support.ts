/**
 * The support bundle: everything a bug report needs, in one file, produced
 * only when the user asks for it and saved only where they choose.
 *
 * Nothing here uploads. "Copy diagnostics" beside it answers the version
 * questions in a paste; this is for the case where the answer is in the
 * logs, and asking someone to find their app-data folder is where a report
 * stops being written.
 *
 * The ZIP is written by hand against APPNOTE 6.3.3. That looks like
 * reinvention until you read electron-builder.yml: the package excludes
 * node_modules outright, on the stated grounds that the main process uses
 * only Electron and node builtins. A zip dependency here would work in dev
 * and be absent from the shipped app — a failure with no build-time symptom
 * and no symptom at all until a user tries to send us their logs. `zlib`
 * carries both halves that are genuinely hard (deflate, and a CRC-32 whose
 * polynomial has to match), so what is left is header arithmetic.
 *
 * No Zip64, no encryption, no directory entries: a handful of small text
 * files, well under every 32-bit bound in the format.
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward-slashed path inside the archive. */
  name: string;
  data: Buffer;
}

export interface BundleInput {
  /** App/engine/API versions — whatever the About pane could read. */
  versions: unknown;
  /** GET /system, or null when the engine did not answer. */
  system: unknown;
  logs: ZipEntry[];
}

/**
 * The bundle's contents, as an ordered list.
 *
 * Split from the zip writer so the *contract* — which files a bundle
 * carries — is assertable without decoding an archive, and so the caller
 * that has to touch the filesystem for the logs stays in the main process.
 */
export function bundleEntries({ versions, system, logs }: BundleInput): ZipEntry[] {
  return [
    { name: "versions.json", data: json(versions) },
    // Written even when null. A bundle from a session where the engine was
    // unreachable is exactly the bundle worth reading, and an absent file
    // is indistinguishable from one nobody thought to collect.
    { name: "system.json", data: json(system) },
    ...logs.map((entry) => ({ name: `logs/${entry.name}`, data: entry.data })),
  ];
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

/**
 * General purpose bit 11: "the name in this header is UTF-8".
 *
 * Without it the format says names are CP437, and a conforming reader obeys
 * that — Python's zipfile decodes the bytes as CP437 and then cannot find
 * the entry under the name it was written with. Set unconditionally, since
 * ASCII is already valid UTF-8 and every reader that matters has honored
 * this bit for a decade.
 */
const UTF8_NAMES = 0x0800;

/** DOS date/time, which is what the format stores. Second resolution is 2s
 * and the epoch is 1980 — both are the format's, not ours. */
function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Entries → one ZIP archive.
 *
 * Deflated only when deflating helps: already-compressed or tiny payloads
 * come out larger, and a "compressed" entry bigger than its input is a
 * needless way to be wrong about `compressedSize`.
 */
export function zipEntries(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosStamp(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Bytes, not characters: every offset after this one is measured in
    // them, so a name whose UTF-8 encoding is longer than its string length
    // would shift the whole archive out from under its own directory.
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data);
    const compress = deflated.length < entry.data.length;
    const body = compress ? deflated : entry.data;
    const method = compress ? 8 : 0;
    const sum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, the floor for deflate
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk the directory starts on
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, directory, end]);
}
