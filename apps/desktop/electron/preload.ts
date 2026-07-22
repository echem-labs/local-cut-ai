import { contextBridge, ipcRenderer, webFrame } from "electron";

/**
 * The renderer gets exactly two things from the shell: where the engine is
 * (and how to authenticate), and a write-only surface for provider keys.
 * Keys flow renderer → main → engine; only presence booleans ever come
 * back. All other data flows over the engine's HTTP/WS API — no
 * filesystem shortcuts.
 */
contextBridge.exposeInMainWorld("localcut", {
  getEngineConnection: () => ipcRenderer.invoke("engine:connection"),
  pairEngine: (code: string) => ipcRenderer.invoke("engine:pair", code),
  unpairEngine: () => ipcRenderer.invoke("engine:unpair"),
  setProviderKeys: (keys: Record<string, string>) =>
    ipcRenderer.invoke("providers:set-keys", keys),
  getProviderKeyPresence: () => ipcRenderer.invoke("providers:key-presence"),
  clearProviderKey: (id: string) => ipcRenderer.invoke("providers:clear-key", id),
  setTitleBarTheme: (theme: "dark" | "light") =>
    ipcRenderer.invoke("window:set-titlebar-theme", theme),
  getSystemTextScale: () => ipcRenderer.invoke("window:system-text-scale"),
  setUiZoom: (factor: number) => {
    const value = Number(factor);
    webFrame.setZoomFactor(Number.isFinite(value) ? Math.min(3, Math.max(0.5, value)) : 1);
  },
});
