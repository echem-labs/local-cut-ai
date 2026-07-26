/**
 * The preload bridge — the renderer's entire view of the shell.
 *
 * Two things are worth holding still. The surface itself: anything added here
 * is reachable from any script that ends up running in the renderer, so the
 * exposed set is asserted exhaustively rather than key by key. And the one
 * piece of logic on this side of the wall, `setUiZoom`'s clamp, which is what
 * stops a bad persisted value from rendering the app unusable at 0.01×.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { exposedBridges, ipcInvocations, zoomFactors } from "./test/electron-stub";

type Bridge = Record<string, (...args: never[]) => unknown>;
let bridge: Bridge;

beforeAll(async () => {
  await import("./preload");
  bridge = exposedBridges.get("localcut")!;
});

describe("the exposed surface", () => {
  it("is published under `localcut` and nothing else", () => {
    expect([...exposedBridges.keys()]).toEqual(["localcut"]);
  });

  it("exposes exactly the documented methods", () => {
    // A new entry here is a new capability handed to renderer-side code;
    // failing this test is the prompt to decide whether that is intended.
    expect(Object.keys(bridge).sort()).toEqual([
      "armProviderKeys",
      "clearProviderKey",
      "getEngineConnection",
      "getProviderKeyPresence",
      "getSystemTextScale",
      "inspectPairing",
      "pairEngine",
      "setProviderKeys",
      "setTitleBarTheme",
      "setUiZoom",
      "unpairEngine",
    ]);
  });
});

describe("channel routing", () => {
  const cases: [string, unknown[], string, unknown[]][] = [
    ["getEngineConnection", [], "engine:connection", []],
    ["inspectPairing", ["code"], "engine:inspect-pairing", ["code"]],
    ["pairEngine", ["code", { armKeys: true }], "engine:pair", ["code", { armKeys: true }]],
    ["unpairEngine", [], "engine:unpair", []],
    ["armProviderKeys", [], "providers:arm-keys", []],
    ["setProviderKeys", [{ anthropic: "sk" }], "providers:set-keys", [{ anthropic: "sk" }]],
    ["getProviderKeyPresence", [], "providers:key-presence", []],
    ["clearProviderKey", ["openai"], "providers:clear-key", ["openai"]],
    ["setTitleBarTheme", ["dark"], "window:set-titlebar-theme", ["dark"]],
    ["getSystemTextScale", [], "window:system-text-scale", []],
  ];

  it.each(cases)("%s invokes %s", async (method, args, channel, expected) => {
    ipcInvocations.length = 0;
    await (bridge[method] as (...a: unknown[]) => unknown)(...args);
    expect(ipcInvocations).toEqual([{ channel, args: expected }]);
  });

  it("defaults pairEngine's options to an empty object", () => {
    // ipcRenderer.invoke cannot serialize `undefined` as a distinct value in
    // every Electron version; send the shape the handler expects.
    ipcInvocations.length = 0;
    void (bridge.pairEngine as (code: string) => unknown)("code");
    expect(ipcInvocations).toEqual([{ channel: "engine:pair", args: ["code", {}] }]);
  });
});

describe("setUiZoom", () => {
  it.each([
    ["passes a sane factor through", 1.25, 1.25],
    ["clamps below 0.5", 0.01, 0.5],
    ["clamps above 3", 12, 3],
    ["falls back to 1 for a non-number", "large", 1],
    ["falls back to 1 for NaN", Number.NaN, 1],
    ["falls back to 1 for Infinity", Number.POSITIVE_INFINITY, 1],
  ])("%s", (_label, input, expected) => {
    zoomFactors.length = 0;
    (bridge.setUiZoom as (factor: unknown) => void)(input);
    expect(zoomFactors).toEqual([expected]);
  });

  it("goes straight to webFrame, without an IPC round-trip", () => {
    ipcInvocations.length = 0;
    (bridge.setUiZoom as (factor: unknown) => void)(1);
    expect(ipcInvocations).toEqual([]);
  });
});
