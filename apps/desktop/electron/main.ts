import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { EngineManager } from "./engine";
import { PROVIDER_KEY_IDS, type ProviderKeyId, ProviderKeyStore } from "./keys";

const engine = new EngineManager();
const keyStore = new ProviderKeyStore();
let engineError: string | null = null;

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

/** PUT key fields to the engine, which holds them in memory only. An empty
 * string clears the key engine-side, mirroring the store. */
async function pushKeysToEngine(keys: Partial<Record<ProviderKeyId, string>>): Promise<void> {
  const connection = engine.connection;
  if (!connection) throw new Error("engine not connected");
  const body: Record<string, string> = {};
  for (const id of PROVIDER_KEY_IDS) {
    const value = keys[id];
    if (value !== undefined) body[`${id}_key`] = value;
  }
  const response = await fetch(`${connection.url}/providers/keys`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`engine rejected provider keys: ${response.status}`);
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
  connection: engine.connection,
  error: engineError,
}));

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
    await engine.start();
    // The engine never persists keys — re-arm cloud providers from the
    // encrypted store on every start.
    const stored = keyStore.load();
    if (Object.keys(stored).length > 0) {
      await pushKeysToEngine(stored).catch((err) =>
        console.warn("[keys] re-arming engine failed:", err),
      );
    }
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
