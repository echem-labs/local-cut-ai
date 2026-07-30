import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeTheme,
  session,
} from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineManager } from "./engine";
import {
  type KeyPresence,
  PROVIDER_KEY_IDS,
  type ProviderKeyId,
  ProviderKeyStore,
} from "./keys";
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

/** Hostname without IPv6 brackets. `URL.hostname` keeps them ("[fd00::5]"),
 * but Chromium hands the certificate verify proc the bare form — so a
 * bracketed compare never matches and an IPv6 engine goes silently unpinned
 * while the renderer still hands over the bearer token. */
const bareHost = (url: string): string | null => hostOf(url)?.replace(/^\[|\]$/g, "") ?? null;

/** The pairing the TLS paths consult. The verify proc runs on the UI thread
 * for EVERY certificate verification, and remoteStore.load() is a synchronous
 * read that throws ENOENT in the common unpaired case — so the disk is read
 * once and the answer cached until we ourselves change it. */
let storedPairing: RemotePairing | null | undefined;
const currentPairing = (): RemotePairing | null => {
  if (remoteConnection) return remoteConnection;
  if (storedPairing === undefined) storedPairing = remoteStore.load();
  return storedPairing;
};
const forgetStoredPairing = (): void => {
  storedPairing = undefined;
};

/** Does this URL belong to the engine the renderer is actually talking to?
 * Origin-compared against the ACTIVE connection only: a paired remote makes
 * the idle local spawn (and any previously paired engine) a stranger. */
const isActiveEngineUrl = (raw: string): boolean => {
  const connection = activeConnection();
  if (!connection) return false;
  try {
    return new URL(raw).origin === new URL(connection.url).origin;
  } catch {
    return false;
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

/** The overlay is a Windows/Linux feature; macOS draws its own traffic
 * lights over the hidden title bar and has nothing to retint. */
const canRetintOverlay = process.platform === "win32" || process.platform === "linux";

/** Best guess at the theme before the renderer has stamped one. The default
 * preference is "system", so the OS answer is right in the common case and
 * the renderer corrects a forced light/dark within a frame — without this,
 * every launch flashes dark chrome at a light-mode user. */
const initialTheme = (): "dark" | "light" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

async function createWindow(): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: initialTheme() === "dark" ? "#0E0F12" : "#ffffff",
    title: "LocalCut AI",
    // Frameless: the renderer draws a slim branded title bar; the OS
    // min/max/close buttons float on top via the overlay.
    titleBarStyle: "hidden",
    titleBarOverlay: TITLEBAR[initialTheme()],
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
  //
  // Download links are the one legitimate way a click leaves the app: every
  // <a download href=…> points at the engine, which is cross-origin to the
  // renderer, and Chromium ignores the download attribute on cross-origin
  // anchors — the click arrives here as a navigation. Blocking it outright
  // makes every Download button a silent no-op, so the active engine's own
  // URLs become downloads instead. Nothing else is exempted.
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isActiveEngineUrl(url)) window.webContents.downloadURL(url);
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
  const pairing = currentPairing();
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

/** Re-arm BYOK keys after any (re)connect — the engine never persists them.
 *
 * Skipped for a remote engine the user did not agree to send keys to. The
 * agreement is per-host and lives on the pairing, because this runs on every
 * launch: without the check, declining at pair time would be silently undone
 * by the next app start. A LOCAL engine is always armed — it is this
 * machine, and the keys are already on it. */
async function armStoredKeys(): Promise<void> {
  if (remoteConnection && remoteConnection.armKeys !== true) {
    console.log("[keys] remote engine is not key-armed; skipping");
    return;
  }
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
  // Same gate as armStoredKeys: entering a key must not become an implicit
  // "…and send it to the GPU box" for a remote the user never armed.
  const armed = !remoteConnection || remoteConnection.armKeys === true;
  if (Object.keys(updates).length > 0 && armed) {
    try {
      await pushKeysToEngine(updates);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { presence: keyStore.presence(), error, armed };
}

/** State-mutating IPC (pairing, provider keys) must originate from the app's
 * own top frame. Navigation is already locked down, so this is defense in
 * depth — it also rejects an injected subframe/iframe that loaded foreign
 * content, which will-navigate does not cover. */
function trustedSender(event: IpcMainInvokeEvent): boolean {
  try {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false; // top frame only, no iframes
    return isAppUrl(frame.url);
  } catch {
    // WebFrameMain property access throws once the frame is disposed (a
    // reload racing an in-flight invoke). Untrusted is the safe answer.
    return false;
  }
}

// Gated like the mutators: this hands out the engine's URL and bearer token,
// which is full authenticated access to every project on the machine.
ipcMain.handle("engine:connection", (event) => {
  // Reported, not thrown: the renderer awaits this during startup with no
  // catch, so a rejection would strand the app on "Connecting…" forever with
  // nothing shown. The null connection + error is a shape it already renders.
  if (!trustedSender(event))
    return {
      connection: null,
      error: "untrusted sender",
      remote: false,
      remotePaired: false,
      keysArmed: false,
    };
  return {
    connection: activeConnection(),
    error: engineError,
    remote: remoteConnection !== null,
    // A pairing on disk even if the remote is currently unreachable — so the
    // UI can always offer Disconnect and isn't stranded on a dead box.
    remotePaired: remoteStore.exists(),
    // Whether THIS engine is allowed the provider keys. A local engine always
    // is (it is this machine, and the keys are already on it); a remote one
    // only if the user said so. Without this the renderer cannot tell an
    // unarmed remote from an armed one, so it cannot offer to arm it — which
    // left the arm-keys path implemented on both sides and reachable from
    // neither.
    keysArmed: remoteConnection ? remoteConnection.armKeys === true : true,
  };
});

/** Decode a pairing code WITHOUT acting on it, so the renderer can show the
 * user which host they are about to trust. A pairing code is an opaque blob:
 * nothing in it is legible until it is decoded, so without this step
 * "accepting a pairing code" is an unreviewable action. */
ipcMain.handle("engine:inspect-pairing", (event, code: unknown) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  if (typeof code !== "string") return { ok: false, error: "pairing code must be text" };
  try {
    const pairing = parsePairingCode(code);
    const url = new URL(pairing.url);
    return {
      ok: true,
      error: null,
      host: url.host,
      url: pairing.url,
      // Grouped in pairs, the way the engine prints it, so the user can
      // compare it against what the GPU box showed them.
      fingerprint: pairing.fingerprint
        ? (pairing.fingerprint.match(/../g) ?? []).join(":")
        : null,
      // Which keys this pairing would hand over if armed. Named, not
      // counted: "3 keys" is not something anyone can reason about.
      keys: keyStore.presence(),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("engine:pair", async (event, code: unknown, options: unknown) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  if (typeof code !== "string") return { ok: false, error: "pairing code must be text" };
  // Arming is now an explicit, separate decision. Accepting a pairing code
  // used to push every stored provider key (Anthropic, OpenAI, Gemini, fal)
  // to whatever host the code named — and the certificate pin is no defence,
  // because the same code supplies both the certificate and its fingerprint,
  // so a hostile code pins its own certificate and passes. The renderer shows
  // the decoded host and asks; only an explicit yes reaches here.
  const armKeys = typeof options === "object" && options !== null
    ? (options as { armKeys?: unknown }).armKeys === true
    : false;
  try {
    const pairing = { ...parsePairingCode(code), armKeys };
    await verifyPairing(pairing); // captures + pins the cert, checks the token
    remoteStore.save(pairing);
    forgetStoredPairing();
    remoteConnection = pairing;
    engineError = null;
    engine.stop(); // the GPU box renders now; no reason to keep a local engine
    if (armKeys) await armStoredKeys();
    return { ok: true, error: null, keysArmed: armKeys };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Arm the stored provider keys against the engine that is connected NOW.
 * Separate from pairing so "connect to my GPU box" and "send my API keys to
 * my GPU box" are two decisions, not one. */
ipcMain.handle("providers:arm-keys", async (event) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  try {
    // Send first, record second. Persisting the agreement ahead of a push
    // that then failed left consent on disk while the pane still reported
    // the engine unarmed: the user saw the refusal and believed nothing had
    // been sent, and the next launch armed that host silently.
    const stored = keyStore.load();
    if (Object.keys(stored).length > 0) await pushKeysToEngine(stored);
    // Against this exact pairing: the decision has to survive the next
    // launch, or startup would ask again (or, worse, arm anyway).
    if (remoteConnection) {
      remoteConnection = { ...remoteConnection, armKeys: true };
      remoteStore.save(remoteConnection);
    }
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("engine:unpair", async (event) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  remoteStore.clear();
  forgetStoredPairing();
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

// Gated like engine:connection and the mutators: which BYOK providers are
// configured (and whether a keychain actually backs them) is reconnaissance,
// not public state. Reported rather than thrown — the settings pane awaits
// this and renders the all-false shape without a catch.
ipcMain.handle("providers:key-presence", (event) => {
  if (!trustedSender(event)) {
    // Annotated, not a bare literal: adding a provider to KeyPresence has to
    // fail the build here rather than leave this path answering `undefined`
    // for the new one, which reads as false but is not typed as anything.
    const denied: KeyPresence = {
      anthropic: false,
      openai: false,
      gemini: false,
      fal: false,
      encrypted: false,
    };
    return denied;
  }
  return keyStore.presence();
});

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
// resolves or changes. Linux supports this as well as Windows: gating it on
// win32 alone left the overlay stuck at its creation color, so a light-mode
// Linux user got black min/max/close buttons in the corner of a white bar.
ipcMain.handle("window:set-titlebar-theme", (event, theme: unknown) => {
  if (theme !== "dark" && theme !== "light") return;
  if (!canRetintOverlay) return;
  BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(TITLEBAR[theme]);
});

app.whenReady().then(async () => {
  // One instance per machine. A second one spawns a second engine against the
  // same data dir: two schedulers popping the same queue rows (the VRAM-serial
  // invariant broken, both rendering the same job), and two writers on
  // project.json where the last save silently discards the other's edits.
  // Hand focus to the window that already exists instead.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

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
    const pairing = currentPairing();
    // Only a pairing that actually captured a certificate defines a pin.
    // parsePairingCode also accepts http (an SSH-forwarded remote), which
    // never captures one — pinning on that would hard-fail every unrelated
    // https connection to the same hostname with no fallback path.
    const pinnedHost = pairing?.cert ? bareHost(pairing.url) : null;
    if (pinnedHost && pairing?.cert && request.hostname === pinnedHost) {
      const matches =
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

// Quitting must not outrun the engine teardown. `engine.stop()` only sends
// SIGTERM, and its SIGKILL backstop is an unref'd timer that a quitting app
// never lives long enough to fire — so an engine slow to honour SIGTERM was
// orphaned holding the data dir and a few hundred MB of RSS. Hold the quit
// open until the process tree is gone, then re-issue it.
let engineTornDown = false;
app.on("before-quit", (event: Electron.Event) => {
  if (engineTornDown) return; // the re-issued quit; let it through
  engineTornDown = true;
  event.preventDefault();
  void engine
    .stopAndWait()
    .catch((err) => console.error("[engine] teardown failed:", err))
    .finally(() => app.quit());
});
