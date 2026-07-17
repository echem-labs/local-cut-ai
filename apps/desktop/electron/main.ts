import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { EngineManager } from "./engine";
import { PROVIDER_KEY_IDS, type ProviderKeyId, ProviderKeyStore } from "./keys";
import { parsePairingCode, type RemotePairing, RemoteEngineStore } from "./remote";
import { engineRequest } from "./request";

const engine = new EngineManager();
const keyStore = new ProviderKeyStore();
const remoteStore = new RemoteEngineStore();
let engineError: string | null = null;
// Set only after the remote engine answered a pinned, authed request.
let remoteConnection: RemotePairing | null = null;

const activeConnection = (): RemotePairing | { url: string; token: string } | null =>
  remoteConnection ?? engine.connection;

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0E0F12",
    title: "LocalCut",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
  } else {
    await window.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }
}

// Chromium-side pinning for the renderer's fetch/WebSocket/media requests:
// accept exactly the paired engine's self-signed certificate, nothing else.
app.on("certificate-error", (event, _webContents, url, _error, certificate, callback) => {
  const pairing = remoteStore.load();
  if (pairing?.fingerprint && url.startsWith(pairing.url)) {
    const presented = Buffer.from(
      certificate.fingerprint.replace(/^sha256\//, ""),
      "base64",
    ).toString("hex");
    if (presented === pairing.fingerprint) {
      event.preventDefault();
      callback(true);
      return;
    }
  }
  callback(false);
});

/** Prove a pairing works before trusting it: pinned TLS, live engine, and
 * a token the engine actually accepts. */
async function verifyPairing(pairing: RemotePairing): Promise<void> {
  let health;
  try {
    health = await engineRequest(pairing, "health");
  } catch (err) {
    throw new Error(
      `engine at ${pairing.url} is unreachable: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (health.status !== 200) throw new Error(`engine at ${pairing.url} is not healthy`);
  const authed = await engineRequest(pairing, "projects");
  if (authed.status === 401) throw new Error("the engine rejected the pairing token");
}

/** Remote pairing (when present and healthy) wins; otherwise the local
 * auto-spawned engine. A dead remote is an error, not a silent local
 * fallback — the user picked the GPU box for a reason. */
async function connectEngine(): Promise<void> {
  engineError = null;
  remoteConnection = null;
  const pairing = remoteStore.load();
  if (pairing) {
    await verifyPairing(pairing);
    remoteConnection = pairing;
    return;
  }
  await engine.start();
}

/** PUT key fields to the engine, which holds them in memory only. An empty
 * string clears the key engine-side, mirroring the store. */
async function pushKeysToEngine(keys: Partial<Record<ProviderKeyId, string>>): Promise<void> {
  const connection = activeConnection();
  if (!connection) throw new Error("engine not connected");
  const body: Record<string, string> = {};
  for (const id of PROVIDER_KEY_IDS) {
    const value = keys[id];
    if (value !== undefined) body[`${id}_key`] = value;
  }
  const response = await engineRequest(connection, "providers/keys", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`engine rejected provider keys: ${response.status}`);
  }
}

/** Re-arm BYOK keys after any (re)connect — the engine never persists them. */
async function armStoredKeys(): Promise<void> {
  const stored = keyStore.load();
  if (Object.keys(stored).length > 0) {
    await pushKeysToEngine(stored).catch((err) =>
      console.warn("[keys] re-arming engine failed:", err),
    );
  }
}

// IPC payloads come from the renderer — treat them as untrusted.
function sanitizeKeyUpdates(input: unknown): Partial<Record<ProviderKeyId, string>> {
  const updates: Partial<Record<ProviderKeyId, string>> = {};
  if (typeof input !== "object" || input === null) return updates;
  for (const id of PROVIDER_KEY_IDS) {
    const value = (input as Record<string, unknown>)[id];
    if (typeof value === "string") updates[id] = value;
  }
  return updates;
}

/** Persist (encrypted) first, then arm the engine. A PUT failure is
 * reported but never loses the stored key — startup re-arms it later. */
async function applyKeyUpdates(updates: Partial<Record<ProviderKeyId, string>>) {
  keyStore.set(updates);
  let error: string | null = null;
  if (Object.keys(updates).length > 0) {
    try {
      await pushKeysToEngine(updates);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { presence: keyStore.presence(), error };
}

ipcMain.handle("engine:connection", () => ({
  connection: activeConnection(),
  error: engineError,
  remote: remoteConnection !== null,
}));

ipcMain.handle("engine:pair", async (_event, code: unknown) => {
  if (typeof code !== "string") return { ok: false, error: "pairing code must be text" };
  try {
    const pairing = parsePairingCode(code);
    await verifyPairing(pairing);
    remoteStore.save(pairing);
    remoteConnection = pairing;
    engineError = null;
    engine.stop(); // the GPU box renders now; no reason to keep a local engine
    await armStoredKeys();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("engine:unpair", async () => {
  remoteStore.clear();
  remoteConnection = null;
  try {
    await connectEngine();
    await armStoredKeys();
    return { ok: true, error: null };
  } catch (err) {
    engineError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: engineError };
  }
});

ipcMain.handle("providers:set-keys", (_event, input: unknown) =>
  applyKeyUpdates(sanitizeKeyUpdates(input)),
);

ipcMain.handle("providers:key-presence", () => keyStore.presence());

ipcMain.handle("providers:clear-key", (_event, id: unknown) => {
  if (typeof id !== "string" || !(PROVIDER_KEY_IDS as readonly string[]).includes(id)) {
    throw new Error(`unknown provider key id: ${String(id)}`);
  }
  return applyKeyUpdates({ [id]: "" });
});

app.whenReady().then(async () => {
  try {
    await connectEngine();
    await armStoredKeys();
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
    console.error("[engine] startup failed:", engineError);
  }
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => engine.stop());
