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
import { describe, expect, it } from "vitest";
import { claimsDeclaredModelId, declaredAppId, declaredModelId } from "./test/appId";

describe("the Windows application id", () => {
  it("is the same in the installer config and the running app", () => {
    const appId = declaredAppId();
    const modelId = declaredModelId();

    // Guard the readers themselves: a rename that made either return null
    // would otherwise pass as null === null.
    expect(appId).toBeTruthy();
    expect(modelId).toBeTruthy();
    expect(modelId).toBe(appId);
  });

  it("is the constant main.ts hands to Electron, not merely one it declares", () => {
    // The reader above matches a literal. Replacing the call with
    // `app.setAppUserModelId(app.getName())` would leave that literal — and
    // this whole contract — green while the process claimed something else.
    expect(claimsDeclaredModelId()).toBe(true);
  });
});
