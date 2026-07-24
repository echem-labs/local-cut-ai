/**
 * Durable little JSON files under userData (provider keys, the remote
 * pairing). Both hold credentials the user cannot re-derive from anywhere
 * else, so neither a torn write nor a corrupt read may silently discard
 * them — the failure mode is "my keys vanished", with nothing to restore.
 */
import fs from "node:fs";
import path from "node:path";

/** Write via a sibling temp file and rename, so a crash or a full disk
 * leaves either the old file or the new one — never a truncated file that
 * the next read discards as corrupt. Mode 0600 is set at create time: a
 * write-then-chmod would publish credentials world-readable in between. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(handle, JSON.stringify(value, null, 2));
    fs.fsyncSync(handle); // rename must not land ahead of the bytes
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(tmp, { force: true });
  }
}

/** Parse the file, or return null when it isn't there.
 *
 * A file that exists but does not parse is moved aside rather than ignored.
 * Treating corruption as "no keys yet" is what turns one bad write into
 * permanent loss: the caller reads an empty set, the user re-enters one
 * key, and the read-modify-write cycle writes that single key over the
 * others. The quarantined copy keeps the bytes recoverable by hand. */
export function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // not written yet, or unreadable — same empty answer
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, quarantine);
      console.error(`[store] ${path.basename(file)} was corrupt; kept at ${quarantine}`, error);
    } catch (renameError) {
      console.error(`[store] ${path.basename(file)} is corrupt and could not be kept`, renameError);
    }
    return null;
  }
}
