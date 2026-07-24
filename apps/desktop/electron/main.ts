import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, Menu, session } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** Is this URL the app's own renderer? Everything downstream of this — the
 * navigation lockdown and every state-mutating IPC handler — treats "yes"
 * as "may hold the engine token".
 *
 * It compares ORIGINS, not string prefixes. `startsWith(devUrl)` accepts
 * `http://127.0.0.1:5173@evil.com/`, which WHATWG parses as host evil.com
 * with the dev URL as userinfo; the packaged `startsWith("file://")` form
 * accepted any file on disk. */
function isAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    try {
      return url.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== "file:") return false;
  const root = path.resolve(__dirname, "..", "..", "dist");
  try {
    const file = path.resolve(fileURLToPath(url));
    return file === path.join(root, "index.html") || file.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/** Native-controls overlay colors per theme — backgrounds match the
 * renderer's .titlebar (surface-1). Height is one pixel SHORT of
 * --titlebar-h (38px): the overlay paints on top of the bar, and at full
 * height it covers the bar's 1px bottom border, visibly breaking the
 * divider line under the min/max/close buttons. */
const TITLEBAR = {
  dark: { color: "#16181d", symbolColor: "#a9adb8", height: 37 },
  light: { color: "#ffffff", symbolColor: "#5d5b6b", height: 37 },
} as const;

async function createWindow(): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
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

  // Navigation lockdown: the preload bridge hands out the engine url+token and
  // the pair/keys mutators, so the webContents must never navigate to — or open
  // — content outside the app's own origin, which would inherit that bridge
  // (a redirect, an injected iframe, or an in-bundle XSS).
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  try {
    if (devUrl) {
      await window.loadURL(devUrl);
    } else {
      await window.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
    }
  } catch (error) {
    // A load failure (Vite dev server not up yet, a packaging path slip) must
    // not become an unhandled rejection that leaves the app with no window at
    // all — keep the (blank, reloadable) window and log.
    console.error("[window] failed to load renderer:", error);
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

/** State-mutating IPC (pairing, provider keys) must originate from the app's
 * own top frame. Navigation is already locked down, so this is defense in
 * depth — it also rejects an injected subframe/iframe that loaded foreign
 * content, which will-navigate does not cover. */
function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false; // top frame only, no iframes
  return isAppUrl(frame.url);
}

// Gated like the mutators: this hands out the engine's URL and bearer token,
// which is full authenticated access to every project on the machine.
ipcMain.handle("engine:connection", (event) => {
  if (!trustedSender(event)) throw new Error("untrusted sender");
  return {
    connection: activeConnection(),
    error: engineError,
    remote: remoteConnection !== null,
    // A pairing on disk even if the remote is currently unreachable — so the
    // UI can always offer Disconnect and isn't stranded on a dead box.
    remotePaired: remoteStore.exists(),
  };
});

ipcMain.handle("engine:pair", async (event, code: unknown) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
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

ipcMain.handle("engine:unpair", async (event) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
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

ipcMain.handle("providers:set-keys", (event, input: unknown) => {
  if (!trustedSender(event)) throw new Error("untrusted sender");
  return applyKeyUpdates(sanitizeKeyUpdates(input));
});

ipcMain.handle("providers:key-presence", () => keyStore.presence());

ipcMain.handle("providers:clear-key", (event, id: unknown) => {
  if (!trustedSender(event)) throw new Error("untrusted sender");
  if (typeof id !== "string" || !(PROVIDER_KEY_IDS as readonly string[]).includes(id)) {
    throw new Error(`unknown provider key id: ${String(id)}`);
  }
  return applyKeyUpdates({ [id]: "" });
});

/** GNOME's text-scaling-factor ("Large Text" / Tweaks font scaling) is a
 * font-only multiplier every GTK app honors but Chromium never reads — on
 * desktops that use it, the app renders visibly smaller than everything
 * else. Windows/macOS display scaling is already applied by Chromium, so
 * they (and non-GNOME setups) get 1. Read once; the renderer folds it into
 * its zoom baseline. */
const systemTextScale: Promise<number> =
  process.platform === "linux"
    ? new Promise((resolve) => {
        execFile(
          "gsettings",
          ["get", "org.gnome.desktop.interface", "text-scaling-factor"],
          { timeout: 2000 },
          (error, stdout) => {
            const value = error ? NaN : Number.parseFloat(stdout.trim());
            resolve(Number.isFinite(value) && value >= 0.5 && value <= 3 ? value : 1);
          },
        );
      })
    : Promise.resolve(1);

ipcMain.handle("window:system-text-scale", () => systemTextScale);

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

  // Pin the remote engine's certificate for the RENDERER's traffic too.
  // certificate-error (below) only fires once Chromium's own verification
  // has already failed, so a cert Chromium happens to trust — a public CA,
  // a corporate MITM root, malware-installed root — sailed past the pin
  // while the renderer handed over the engine bearer token. A verify proc
  // runs on every verification, so the pin is authoritative.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const pairing = remoteConnection ?? remoteStore.load();
    const pinnedHost = pairing?.url ? hostOf(pairing.url) : null;
    if (pinnedHost && request.hostname === pinnedHost) {
      const matches =
        !!pairing?.cert &&
        !!request.certificate?.data &&
        pemBody(request.certificate.data) === pemBody(pairing.cert);
      callback(matches ? 0 : -2); // 0 = trust this cert, -2 = reject
      return;
    }
    callback(-3); // anything else: Chromium's own verdict stands
  });
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
