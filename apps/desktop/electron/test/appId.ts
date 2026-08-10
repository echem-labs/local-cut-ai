/**
 * Reads the Windows application id out of the two files that declare it.
 *
 * Shared so no third copy of the literal exists: `appId.contract.test.ts`
 * holds the two declarations against each other, and `main.test.ts` checks
 * that the running process claims that same id — writing it out again there
 * would mean a correct rename fails as an icon test with a puzzling message.
 *
 * Deliberately regexes over the text rather than a YAML parse: the point is
 * to read the same bytes electron-builder does, without a dependency that
 * could normalise away a difference these tests exist to see.
 */
import fs from "node:fs";
import path from "node:path";

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");

/** `appId` in electron-builder.yml — what the NSIS installer stamps on the
 * Start Menu shortcut. Tolerates the forms that mean the same thing to a YAML
 * reader: a quoted scalar and a trailing comment, neither of which is drift. */
export function declaredAppId(): string | null {
  const raw = /^appId:[ \t]+(.+?)[ \t]*(?:#.*)?$/m.exec(read("electron-builder.yml"))?.[1];
  return raw ? raw.replace(/^(["'])(.*)\1$/, "$2") : null;
}

/** `APP_USER_MODEL_ID` in main.ts — what the running process claims to be. */
export function declaredModelId(): string | null {
  return /^const APP_USER_MODEL_ID = "([^"]+)";$/m.exec(read("electron", "main.ts"))?.[1] ?? null;
}

/** Whether main.ts hands that constant to Electron, rather than merely
 * declaring it. Without this the contract passes for a build that claims
 * something else entirely and leaves the constant sitting unused. */
export const claimsDeclaredModelId = (): boolean =>
  /\bapp\.setAppUserModelId\(APP_USER_MODEL_ID\)/.test(read("electron", "main.ts"));
