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
    const clamped = Number.isFinite(value) ? Math.min(3, Math.max(0.5, value)) : 1;
    // Skip a set that changes nothing. Not just an optimization: on a
    // scaled Windows display under --force-device-scale-factor (the
    // parity rig), a redundant setZoomFactor makes Chromium renegotiate
    // page scale against the OS scale and the layout viewport comes back
    // 1.25x the window — the app suddenly renders wider than itself.
    if (Math.abs(webFrame.getZoomFactor() - clamped) < 0.001) return;
    webFrame.setZoomFactor(clamped);
  },
  // True only when the rig exported LOCALCUT_SEED_HOOK for a dev run —
  // main.ts strips the variable in packaged builds, so a shipped app can
  // never expose the state-injection hook however its environment is set.
  seedHookEnabled: process.env.LOCALCUT_SEED_HOOK === "1",
});
