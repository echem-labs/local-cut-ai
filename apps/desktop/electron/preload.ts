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
  // Decode a pairing code without acting on it, so the user can see which
  // host they are about to trust before anything is sent to it.
  inspectPairing: (code: string) => ipcRenderer.invoke("engine:inspect-pairing", code),
  pairEngine: (code: string, options?: { armKeys?: boolean }) =>
    ipcRenderer.invoke("engine:pair", code, options ?? {}),
  unpairEngine: () => ipcRenderer.invoke("engine:unpair"),
  armProviderKeys: () => ipcRenderer.invoke("providers:arm-keys"),
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
