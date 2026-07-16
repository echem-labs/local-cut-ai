import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { EngineManager } from "./engine";

const engine = new EngineManager();
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
    await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("engine:connection", () => ({
  connection: engine.connection,
  error: engineError,
}));

app.whenReady().then(async () => {
  try {
    await engine.start();
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
