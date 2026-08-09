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
import {
  exposedBridges,
  ipcInvocations,
  ipcListeners,
  webFrame,
  zoomFactors,
} from "./test/electron-stub";

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
      "checkForUpdates",
      "clearProviderKey",
      "exportSupportBundle",
      "getEngineConnection",
      "getProviderKeyPresence",
      "getSystemTextScale",
      "inspectPairing",
      "notifyDone",
      "onEngineCrash",
      "openLogsFolder",
      "pairEngine",
      "restartEngine",
      "seedHookEnabled",
      "setProviderKeys",
      "setShellProgress",
      "setTitleBarTheme",
      "setUiZoom",
      "unpairEngine",
      "updatesConfigured",
    ]);
  });

  it("passes on the crash without the IPC event that carried it", () => {
    // The one channel that pushes. Electron calls the raw handler with the
    // IpcRendererEvent first, and that object carries `sender` — a live
    // handle to the whole IPC surface. Handing the listener straight to
    // `ipcRenderer.on` would put it in reach of any script in the page.
    const seen: unknown[] = [];
    const subscribe = bridge.onEngineCrash as unknown as (
      listener: (crash: unknown) => void,
    ) => () => void;
    const unsubscribe = subscribe((crash) => seen.push(crash));

    const entry = ipcListeners.find((listener) => listener.channel === "engine:crashed")!;
    entry.handler({ sender: "the whole ipc surface" }, { code: 1, tail: [] });

    expect(seen).toEqual([{ code: 1, tail: [] }]);

    // And it takes itself off again, so a remounting component cannot stack
    // listeners that each fire the banner.
    unsubscribe();
    expect(ipcListeners.some((listener) => listener.channel === "engine:crashed")).toBe(false);
  });

  // Both take no path and no URL. The point of routing these through main
  // is that main decides WHICH folder and WHICH feed — a renderer-supplied
  // argument would turn them into "open anything" and "fetch anything".
  it("gives the shell errands nothing to aim", () => {
    expect((bridge.openLogsFolder as () => unknown).length).toBe(0);
    expect((bridge.checkForUpdates as () => unknown).length).toBe(0);
  });

  // seedHookEnabled gates window.__localcutSeed — arbitrary state
  // injection. It must be data (no IPC, nothing callable) and false unless
  // the rig's environment variable was present at preload time.
  it("exposes seedHookEnabled as plain data, false without the env flag", () => {
    expect(bridge.seedHookEnabled).toBe(false);
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
    ["openLogsFolder", [], "support:open-logs", []],
    [
      "exportSupportBundle",
      [{ versions: { app: "0.1.0" }, system: null }],
      "support:export-bundle",
      [{ versions: { app: "0.1.0" }, system: null }],
    ],
    ["checkForUpdates", [], "update:check", []],
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
    // The fallbacks resolve to 1 — asserted from a non-1 zoom, because a
    // resolve-to-current is deliberately not applied at all (below).
    ["falls back to 1 for a non-number", "large", 1],
    ["falls back to 1 for NaN", Number.NaN, 1],
    ["falls back to 1 for Infinity", Number.POSITIVE_INFINITY, 1],
  ])("%s", (_label, input, expected) => {
    webFrame.currentZoom = 2; // never the target, so the set always fires
    zoomFactors.length = 0;
    (bridge.setUiZoom as (factor: unknown) => void)(input);
    expect(zoomFactors).toEqual([expected]);
  });

  it("skips a set that changes nothing", () => {
    // Not just thrift: on a scaled display under a forced device scale, a
    // redundant setZoomFactor makes Chromium renegotiate page scale and
    // the layout viewport comes back wrong (see preload.ts).
    webFrame.currentZoom = 1.25;
    zoomFactors.length = 0;
    (bridge.setUiZoom as (factor: unknown) => void)(1.25);
    expect(zoomFactors).toEqual([]);
  });

  it("goes straight to webFrame, without an IPC round-trip", () => {
    webFrame.currentZoom = 2;
    ipcInvocations.length = 0;
    (bridge.setUiZoom as (factor: unknown) => void)(1);
    expect(ipcInvocations).toEqual([]);
  });
});
