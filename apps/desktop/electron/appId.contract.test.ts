/**
 * One id, written down twice.
 *
 * `appId` in electron-builder.yml is what the NSIS installer stamps on the
 * Start Menu shortcut it creates. `APP_USER_MODEL_ID` in main.ts is what the
 * running process claims to be. Windows matches the two to decide that a
 * running window and a pinned tile are the same application — so when they
 * disagree, nothing errors: the app just pins as one entry and runs as
 * another, and toasts come from an unnamed sender with no icon.
 *
 * Neither file can see the other and no build step reconciles them, which is
 * exactly the shape CLAUDE.md says gets a contract test.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

/** Deliberately a regex over the text rather than a YAML parse: the point is
 * to read the same bytes electron-builder does, without a dependency that
 * could normalise away a difference this test exists to see. */
const declaredAppId = (yaml: string): string | null =>
  /^appId:[ \t]*(\S+)[ \t]*$/m.exec(yaml)?.[1] ?? null;

const declaredModelId = (source: string): string | null =>
  /^const APP_USER_MODEL_ID = "([^"]+)";$/m.exec(source)?.[1] ?? null;

describe("the Windows application id", () => {
  it("is the same in the installer config and the running app", () => {
    const appId = declaredAppId(read("electron-builder.yml"));
    const modelId = declaredModelId(read("electron", "main.ts"));

    // Guard the regexes themselves: a rename that made either return null
    // would otherwise pass as null === null.
    expect(appId).toBeTruthy();
    expect(modelId).toBeTruthy();
    expect(modelId).toBe(appId);
  });
});
