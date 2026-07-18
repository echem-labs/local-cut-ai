import { app, BrowserWindow, ipcMain, Menu } from "electron";
import path from "node:path";
import { EngineManager } from "./engine";
import { PROVIDER_KEY_IDS, type ProviderKeyId, ProviderKeyStore } from "./keys";
import { parsePairingCode, type RemotePairing, RemoteEngineStore } from "./remote";
import { capturePinnedCert, engineRequest } from "./request";

const engine = new EngineManager();
const keyStore = new ProviderKeyStore();
const remoteStore = new RemoteEngineStore();
let engineError: string | null = null;
// Set only after the remote engine answered a pinned, authed request.
let remoteConnection: RemotePairing | null = null;

const activeConnection = (): RemotePairing | { url: string; token: string } | null =>
  remoteConnection ?? engine.connection;

/** The base64 body of a PEM cert, whitespace/format-independent, for an
 * exact-cert compare that doesn't depend on fingerprint string encoding. */
const pemBody = (pem: string): string =>
  pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");

const authorityOf = (url: string): string | null => {
  try {
    return new URL(url).host; // host:port — identical across https/wss
  } catch {
    return null;
  }
};

/** Native-controls overlay colors per theme — backgrounds match the
 * renderer's .titlebar (surface-1), heights must match --titlebar-h. */
const TITLEBAR = {
  dark: { color: "#16181d", symbolColor: "#a9adb8", height: 38 },
  light: { color: "#ffffff", symbolColor: "#5d5b6b", height: 38 },
} as const;

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0E0F12",
    title: "LocalCut AI",
    // Frameless: the renderer draws a slim branded title bar; the OS
    // min/max/close buttons float on top via the overlay.
    titleBarStyle: "hidden",
    titleBarOverlay: TITLEBAR.dark,
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

// Chromium-side pinning for the renderer's fetch/WebSocket/media requests.
// Match by authority (so wss://host:port maps to the https://host:port
// pairing) and accept ONLY the exact pinned certificate — an origin match
// alone is never sufficient.
app.on("certificate-error", (event, _webContents, url, _error, certificate, callback) => {
  // Prefer the in-memory verified pairing (with its captured cert) to avoid a
  // synchronous disk read on every TLS request in remote mode; fall back to
  // the store only before the connection is established.
  const pairing = remoteConnection ?? remoteStore.load();
  const paired = pairing?.url ? authorityOf(pairing.url) : null;
  if (
    pairing?.cert &&
    paired &&
    authorityOf(url) === paired &&
    certificate.data &&
    pemBody(certificate.data) === pemBody(pairing.cert)
  ) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

/** Ensure the pairing carries its pinned certificate, capturing it (and
 * verifying its fingerprint against the trusted pairing code) if absent.
 * No token is sent during capture, so a MITM is caught before anything
 * sensitive leaves the process. Mutates and returns the pairing. */
async function ensurePinned(pairing: RemotePairing): Promise<RemotePairing> {
  const secure = (() => {
    try {
      return new URL(pairing.url).protocol === "https:";
    } catch {
      return false;
    }
  })();
  if (secure && !pairing.cert) {
    pairing.cert = await capturePinnedCert(pairing);
  }
  return pairing;
}

/** Prove a pairing works before trusting it: pinned TLS, live engine, and
 * a token the engine actually accepts. */
async function verifyPairing(pairing: RemotePairing): Promise<void> {
  await ensurePinned(pairing);
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
    remoteStore.save(pairing); // persist a freshly-captured cert
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
  // A pairing on disk even if the remote is currently unreachable — so the
  // UI can always offer Disconnect and isn't stranded on a dead box.
  remotePaired: remoteStore.exists(),
}));

ipcMain.handle("engine:pair", async (_event, code: unknown) => {
  if (typeof code !== "string") return { ok: false, error: "pairing code must be text" };
  try {
    const pairing = parsePairingCode(code);
    await verifyPairing(pairing); // captures + pins the cert, checks the token
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

// Retint the native window-control overlay when the renderer's theme
// resolves or changes (setTitleBarOverlay is Windows-only).
ipcMain.handle("window:set-titlebar-theme", (event, theme: unknown) => {
  if (theme !== "dark" && theme !== "light") return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (process.platform === "win32") window?.setTitleBarOverlay(TITLEBAR[theme]);
});

app.whenReady().then(async () => {
  // The frameless window hides the stock File/Edit/View bar; null the menu
  // in packaged builds so Alt can't summon it either. Dev keeps it for the
  // reload/devtools accelerators.
  if (app.isPackaged) Menu.setApplicationMenu(null);
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
