import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
} from "electron";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineCrash } from "../src/api/types";
import { EngineManager } from "./engine";
import {
  type KeyPresence,
  PROVIDER_KEY_IDS,
  type ProviderKeyId,
  ProviderKeyStore,
} from "./keys";
import { installLogSink, readLogFiles } from "./logfile";
import { parsePairingCode, type RemotePairing, RemoteEngineStore } from "./remote";
import { capturePinnedCert, engineRequest } from "./request";
import { bundleEntries, zipEntries } from "./support";

// Dev-only: the test rig points userData at a temp dir so a run starts from
// a fresh profile (first-run state, empty layout store) without touching the
// real one. Never honored in packaged builds.
if (!app.isPackaged && process.env.LOCALCUT_USERDATA) {
  app.setPath("userData", process.env.LOCALCUT_USERDATA);
}
// Same rule for the rig's state-seeding hook: preload reads this variable
// to decide whether to expose window.__localcutSeed, so a packaged build
// must never see it — stripping it here covers preload too (same process
// environment).
if (app.isPackaged) {
  delete process.env.LOCALCUT_SEED_HOOK;
}

/**
 * Under userData rather than Electron's own `logs` path, which is
 * `~/Library/Logs/<app>` on macOS and userData/logs everywhere else. One
 * location on all three platforms is what lets "Open logs folder" and the
 * support bundle agree about where the logs are, and it follows the rig's
 * LOCALCUT_USERDATA override for free — so a rig run writes its logs into
 * its own temp profile instead of the developer's real one.
 *
 * Installed here, at module scope, because the lines most worth having are
 * the ones from startup: a failed engine spawn is logged before the window
 * that would ask for a bundle exists.
 */
const LOGS_DIR = path.join(app.getPath("userData"), "logs");
installLogSink(LOGS_DIR);

/**
 * The release feed, opt-in through `LOCALCUT_UPDATE_FEED`. No build sets it:
 * the installers are unsigned, and an in-app update path that fetches one is
 * a way to hand somebody a binary with nothing vouching for it. Empty means
 * the renderer is told updates are not configured and never offers the check.
 *
 * It lives in the main process and never crosses the bridge: the renderer
 * asks *whether* to offer the check and asks for one to run, but never
 * says what URL to fetch. Otherwise anything running in the renderer could
 * point the shell's own network stack at a host of its choosing.
 */
const UPDATE_FEED = process.env.LOCALCUT_UPDATE_FEED?.trim() ?? "";

const engine = new EngineManager();
/**
 * An engine that stopped on its own is the one failure the renderer cannot
 * see for itself: it keeps every bit of its state, so the app looks intact
 * and simply does nothing. Push it, rather than leaving the UI to infer a
 * crash from requests that fail — those also fail while an engine is merely
 * restarting, and the two want different words on screen.
 */
engine.onCrash((crash) => {
  engineError = `engine exited with ${crash.signal ? `signal ${crash.signal}` : `code ${crash.code}`}`;
  // Kept as well as pushed. A crash during LAUNCH has no window to be pushed
  // to — `whenReady` connects the engine before it creates one — so the send
  // below reached nobody and the app came up with the plain error bar, which
  // carries no way back. The renderer asks for this with the connection.
  lastCrash = crash;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("engine:crashed", crash);
  }
});
const keyStore = new ProviderKeyStore();
const remoteStore = new RemoteEngineStore();
let engineError: string | null = null;
/** The last crash, for a renderer that was not alive to be told about it. */
let lastCrash: EngineCrash | null = null;
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
/** A link the system browser can be trusted with. Deliberately a scheme
 * allowlist rather than a denylist of the dangerous ones: the set of
 * protocol handlers registered on a machine is not knowable from here. */
const isWebUrl = (raw: string): boolean => {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const isActiveEngineUrl = (raw: string): boolean => {
  const connection = activeConnection();
  if (!connection) return false;
  try {
    return new URL(raw).origin === new URL(connection.url).origin;
  } catch {
    return false;
  }
};

/** The app directory, relative to the compiled main module, which sits at
 * dist-electron/electron/. Every path below that reaches out of the main
 * bundle counts these same two levels — the renderer load, the file:// origin
 * check, the app icon — so a change to the electron tsc layout has to move
 * one expression rather than being noticed at three call sites, one of which
 * (the icon) fails silently. */
const BUNDLE_ROOT = path.resolve(__dirname, "..", "..");

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
  const root = path.join(BUNDLE_ROOT, "dist");
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

/** The window's title with nothing rendering. One constant, because the
 * progress handler restores it: two copies drift the moment one is edited,
 * and the symptom is a window stuck under the old name after a render. */
const IDLE_TITLE = "LocalCut AI";

/** Windows identifies an app to the shell by AppUserModelID — it is what
 * groups taskbar buttons, what a pinned shortcut points at, and what a toast
 * notification draws its icon and name from. This MUST equal `appId` in
 * electron-builder.yml, which is the id stamped on the installed shortcut:
 * disagree and the pinned tile and the running window become two different
 * apps to the taskbar. `appId.contract.test.ts` holds the two together.
 *
 * Called unconditionally — it is a no-op off Windows, and a platform guard
 * here would only make the call untestable on the Linux CI runner. */
const APP_USER_MODEL_ID = "ai.localcut.desktop";

/** A file the generator writes into public/, resolved where it actually is.
 *
 * Packaged, Vite has copied public/ into dist/, so it rides inside app.asar
 * next to index.html and nativeImage reads it straight out of the archive.
 * Unpackaged the copy in public/ is the one certain to be there, since dist/
 * is a build artifact a fresh checkout has never produced and a stale one can
 * disagree with the mark. */
const bundleFile = (...parts: string[]): string =>
  path.join(BUNDLE_ROOT, app.isPackaged ? "dist" : "public", ...parts);

/** An image shipped in the bundle, loaded once.
 *
 * `app.isPackaged` cannot change after startup, so the file behind a given
 * name is fixed for the life of the process — and `createFromPath` is a
 * blocking read plus a PNG decode that the notify handler would otherwise pay
 * again on every single toast.
 *
 * NOT build/icon.ico for the Windows case, despite that being the richer
 * multi-size file: nativeImage collapses an .ico to its single largest frame.
 * And NOT build/ at all — electron-builder treats that directory as build
 * resources and excludes it from the package, so a path into it resolves in
 * dev and is missing in the shipped app. */
const images = new Map<string, Electron.NativeImage>();
function bundledImage(name: string): Electron.NativeImage {
  const cached = images.get(name);
  if (cached) return cached;
  const file = bundleFile(name);
  const image = nativeImage.createFromPath(file);
  // createFromPath answers a file that is not there with an EMPTY image
  // rather than throwing, and every surface below then draws nothing at all —
  // indistinguishable on screen from the missing-icon bug this replaced, and
  // silent. A packaging change that stops carrying the file says so here.
  if (image.isEmpty()) console.error(`[icon] no image at ${file}; surfaces using it will be blank`);
  images.set(name, image);
  return image;
}

/** The mark as every surface but the macOS Dock wants it: full-bleed. */
const appIcon = (): Electron.NativeImage => bundledImage("icon.png");

/** The icon a new window carries, or `undefined` to leave it to the OS.
 *
 * Electron applies this through WM_SETICON, which DISPLACES the icon Windows
 * would otherwise read out of the exe — and a NativeImage built from a PNG
 * has one 512px representation, so the 16 and 24px the taskbar and Alt-Tab
 * actually draw would become a runtime downscale of it instead of the frames
 * build/icon.ico carries for exactly those sizes. A packaged Windows build
 * therefore passes nothing and keeps the richer resource.
 *
 * Everywhere else there is no resource to fall back to, and the window shows
 * Electron's default atom without this: every Linux window, a directly-run
 * AppImage with no installed .desktop entry to associate with, and the dev
 * run on any platform. */
const windowIcon = (): Electron.NativeImage | undefined =>
  process.platform === "win32" && app.isPackaged ? undefined : appIcon();

async function createWindow(): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: initialTheme() === "dark" ? "#0E0F12" : "#ffffff",
    title: IDLE_TITLE,
    // Covers what electron-builder does not: see `windowIcon` for why a
    // packaged Windows build is the one case that deliberately passes none.
    icon: windowIcon(),
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
  // Never a second window — that one would inherit this one's preload
  // bridge, which is the whole point of the lockdown above. A web link goes
  // to the system browser instead, which inherits nothing.
  //
  // http(s) and nothing else, because `openExternal` hands the string to the
  // OS and the OS launches whatever is registered for the scheme: `file:` a
  // local executable, `ms-msdt:` a Windows diagnostic host. One of these
  // URLs arrives from the release feed, so the scheme check is what keeps a
  // tampered feed from starting a program. Anything else is a denied open
  // with nowhere to go, which is inert.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  try {
    if (devUrl) {
      await window.loadURL(devUrl);
    } else {
      await window.loadFile(path.join(BUNDLE_ROOT, "dist", "index.html"));
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
async function connectEngine({ waitForPort = true } = {}): Promise<void> {
  engineError = null;
  remoteConnection = null;
  const pairing = remoteStore.load();
  if (pairing) {
    await verifyPairing(pairing);
    remoteStore.save(pairing); // persist a freshly-captured cert
    remoteConnection = pairing;
    forgetLastCrash();
    return;
  }
  await engine.start({ waitForPort });
  forgetLastCrash();
}

/**
 * A crash the app has now recovered from.
 *
 * `lastCrash` outlives the connection it describes, and `engine:connection`
 * hands it to any renderer that finds no engine — so kept past the start that
 * fixed it, it comes back as the banner for the NEXT thing that goes wrong,
 * dated an hour ago with a report to paste about a different fault.
 *
 * On the way UP, though, not on the way in: an attempt that then fails has
 * not recovered from anything, and clearing this first would destroy the
 * record of the very crash the user is trying to come back from. The banner
 * they are looking at survives in the renderer that already has it, but a
 * window created afterwards would come up with the plain bar — which offers
 * nothing, which is the whole failure this crash was kept for.
 */
function forgetLastCrash(): void {
  lastCrash = null;
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

/** Long enough for any project title, short enough that a hostile string
 * cannot be used to grow the taskbar tooltip without bound. */
const TITLE_MAX = 200;

/**
 * The taskbar bar and the window title, which report to someone who is not
 * looking at the app.
 *
 * The renderer decides *what it says* — every user-facing string in this app
 * lives in its i18n catalog, and a second copy of "Rendering {done}/{total}"
 * over here is the drift that guarantees they disagree. Main decides only
 * which window it lands on.
 */
ipcMain.handle("window:set-progress", (event, payload: unknown) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { ok: false, error: "no window" };
  const value = (payload ?? {}) as { fraction?: unknown; title?: unknown };
  // -1 is Electron's own sentinel for "remove the bar", so negatives pass
  // through as -1 rather than being clamped up to 0 — clamping them is how
  // "clear the bar" becomes "draw an empty one", which then never goes away.
  // Anything that is not a usable number becomes -1 for the same reason: NaN
  // paints a bar stuck at the left edge rather than no bar at all.
  const fraction =
    typeof value.fraction === "number" && Number.isFinite(value.fraction)
      ? value.fraction < 0
        ? -1
        : Math.min(1, value.fraction)
      : -1;
  window.setProgressBar(fraction);
  const title = typeof value.title === "string" ? value.title.slice(0, TITLE_MAX).trim() : "";
  window.setTitle(title || IDLE_TITLE);
  return { ok: true, error: null };
});

/**
 * Tell the user a render finished, if they are not already watching it.
 *
 * The focus check belongs here rather than in the renderer: `document
 * .hasFocus()` answers a question about the page, and the one that matters
 * is whether the WINDOW is in front — a minimised app whose page still holds
 * focus would otherwise decide it had been seen. Main is also the only side
 * that can know the OS refused to show notifications at all.
 *
 * A notification for something already on screen is worse than none: it is
 * the app interrupting to report what the user is looking at.
 */
ipcMain.handle("shell:notify", (event, payload: unknown) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { ok: false, error: "no window" };
  if (window.isFocused()) return { ok: true, shown: false, error: null };
  if (!Notification.isSupported()) return { ok: true, shown: false, error: null };
  const value = (payload ?? {}) as { title?: unknown; body?: unknown };
  const title = typeof value.title === "string" ? value.title.slice(0, TITLE_MAX) : "";
  const body = typeof value.body === "string" ? value.body.slice(0, TITLE_MAX) : "";
  if (!title) return { ok: false, error: "no title" };
  // Linux has nowhere else to get one: the toast is drawn by the desktop's
  // notification daemon, which knows nothing about the window that asked for
  // it. The other two do honour this rather than ignore it — Windows renders
  // it as the toast's appLogoOverride image (the sender name and the small
  // attribution logo still come from the AppUserModelID) and macOS attaches
  // it to the banner — so all three carry the mark, which is what was wanted.
  const notification = new Notification({ title, body, icon: appIcon() });
  // Clicking it is a request to come back to the work it is about.
  notification.on("click", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  notification.show();
  return { ok: true, shown: true, error: null };
});

/**
 * Bring the engine back after it stopped without being asked to.
 *
 * `connectEngine`, not `engine.start`: a paired remote is still the engine
 * the user chose, and restarting a local one instead would silently move
 * their work onto this machine.
 */
ipcMain.handle("engine:restart", async (event) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  try {
    await connectEngine();
    // The engine holds BYOK keys in memory only, so the child just spawned
    // has none of them. Without this, a crash-restart leaves every cloud
    // provider failing for the rest of the session while Settings still
    // reports the keys as configured — and the banner's promise that you
    // can carry on would be false for anyone using one.
    await armStoredKeys();
    engineError = null;
    return { ok: true, error: null };
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
    console.error("[engine] restart failed:", engineError);
    return { ok: false, error: engineError };
  }
});

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
      crash: null,
      remote: false,
      remotePaired: false,
      keysArmed: false,
    };
  return {
    connection: activeConnection(),
    error: engineError,
    // Only while there is nothing to connect to. A crash the app recovered
    // from is history, and a banner about it over a working engine is the
    // same lie the late-exit guards in engine.ts exist to prevent.
    crash: activeConnection() ? null : lastCrash,
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
    // Pairing is a recovery too, so it clears the crash for the same reason
    // `connectEngine` does: the local engine's last words outlive the
    // connection they describe, and kept past the engine that replaced them
    // they come back as the banner for whatever goes wrong after the next
    // Disconnect — dated hours ago, with a report to paste about a fault the
    // user has already moved on from.
    forgetLastCrash();
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
    // Cleared on the way up, the way `engine:restart` does it and for the
    // same reason: `connectEngine` clears this before the start, so a crash
    // reported DURING the start that then recovered would leave
    // `engine:connection` answering with a live connection and an error
    // beside it — a shape nothing downstream expects.
    engineError = null;
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

/* ------------------------------------------------- About → Support -- */

// Gated like the mutators. None of these hands out a secret, but each has a
// side effect a page has no business causing on its own: a file manager
// window, a native save dialog over the app, and an outbound request.
ipcMain.handle("support:open-logs", async (event) => {
  if (!trustedSender(event)) return { ok: false, error: "untrusted sender" };
  // openPath returns a REASON string on failure and "" on success — the
  // one Electron API that reports trouble by resolving rather than
  // rejecting, so an unchecked `await` here reads as always working.
  const failure = await shell.openPath(LOGS_DIR);
  return { ok: !failure, error: failure || null };
});

/** A bundle is a handful of JSON objects and two capped log files. This
 * bounds the half that comes from the renderer, so nothing running there
 * can turn "export my diagnostics" into a multi-gigabyte write. */
const MAX_REPORT_BYTES = 256 * 1024;

const bounded = (value: unknown): unknown => {
  const text = JSON.stringify(value ?? null) ?? "null";
  // byteLength, not length: the cap is named in bytes, and a string of
  // non-ASCII counts up to three of them per unit it reports.
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > MAX_REPORT_BYTES ? { truncated: bytes } : value ?? null;
};

ipcMain.handle("support:export-bundle", async (event, report: unknown) => {
  if (!trustedSender(event)) return { path: null, error: "untrusted sender" };
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return { path: null, error: "no window" };
  const input = (report ?? {}) as { versions?: unknown; system?: unknown };

  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    defaultPath: `localcut-support-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  // Cancelling is an outcome, not a failure: the caller shows an error for
  // every non-null reason it gets back, and "you changed your mind" is not
  // something to apologize for.
  if (canceled || !filePath) return { path: null, error: null };

  try {
    const zip = zipEntries(
      bundleEntries({
        versions: bounded(input.versions),
        system: bounded(input.system),
        logs: readLogFiles(LOGS_DIR),
      }),
    );
    writeFileSync(filePath, zip);
    return { path: filePath, error: null };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : String(error) };
  }
});

/* --------------------------------------------------- About → Updates -- */

/** Whatever the feed calls it, reduced to the two things About shows. Both
 * shapes are accepted so the feed decision (GitHub releases vs a static
 * JSON file) does not have to be made before this ships. */
function readFeed(body: unknown): { version: string; url: string } | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const version = typeof row.tag_name === "string" ? row.tag_name : row.version;
  const url = typeof row.html_url === "string" ? row.html_url : row.url;
  if (typeof version !== "string" || !version.trim()) return null;
  return { version: version.trim().replace(/^v/i, ""), url: typeof url === "string" ? url : "" };
}

ipcMain.handle("update:check", async (event) => {
  if (!trustedSender(event)) return { latest: null, url: null, error: "untrusted sender" };
  if (!UPDATE_FEED) return { latest: null, url: null, error: "updates are not configured" };
  try {
    // No credentials, no cookies: this is an anonymous read of a public
    // file, and the check is the only network call the app makes that the
    // user did not start by downloading a model.
    const response = await fetch(UPDATE_FEED, {
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { latest: null, url: null, error: `HTTP ${response.status}` };
    const release = readFeed(await response.json());
    if (!release) return { latest: null, url: null, error: "the release feed made no sense" };
    return { latest: release.version, url: release.url, error: null };
  } catch (error) {
    return {
      latest: null,
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

app.whenReady().then(async () => {
  // Before anything can put a window or a toast on screen, since this is the
  // identity Windows attributes both to.
  app.setAppUserModelId(APP_USER_MODEL_ID);

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

  // A packaged macOS app takes its Dock icon from the bundle; `electron .`
  // has no bundle of its own and shows Electron's default instead. Keyed on
  // `app.dock` rather than the platform because that property IS the macOS
  // test — it is undefined everywhere else, so no platform branch is needed.
  //
  // The INSET copy, not the full-bleed one: the Dock sizes every icon against
  // Apple's 824/1024 grid, so the tile the other surfaces want would render
  // visibly larger than everything beside it — the exact defect the bundle's
  // .icns is generated inset to avoid, and the bundle is not what is read here.
  if (!app.isPackaged) app.dock?.setIcon(bundledImage("icon-mac.png"));

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
    // waitForPort: false — nothing is on screen yet. A launch that lands
    // inside the minute a crashed engine's port stays reserved would
    // otherwise sit here with no window at all, which reads as a hung app.
    // Fail fast, put the window up, and let the crash banner do the waiting
    // where it can say what it is doing.
    await connectEngine({ waitForPort: false });
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
