import { contextBridge, ipcRenderer, webFrame } from "electron";

/**
 * The renderer gets three things from the shell: where the engine is (and
 * how to authenticate), a write-only surface for provider keys, and the
 * About pane's own errands. Keys flow renderer → main → engine; only
 * presence booleans ever come back. All other data flows over the engine's
 * HTTP/WS API — no filesystem shortcuts.
 *
 * The About errands are here because they are shell facts, not engine
 * facts: the app's log files and the release feed belong to the process
 * that writes and fetches them. Each is deliberately narrow — the renderer
 * names no path and no URL, it only asks for the one folder and the one
 * feed that main already knows about.
 */
contextBridge.exposeInMainWorld("localcut", {
  getEngineConnection: () => ipcRenderer.invoke("engine:connection"),
  // Decode a pairing code without acting on it, so the user can see which
  // host they are about to trust before anything is sent to it.
  inspectPairing: (code: string) => ipcRenderer.invoke("engine:inspect-pairing", code),
  pairEngine: (code: string, options?: { armKeys?: boolean }) =>
    ipcRenderer.invoke("engine:pair", code, options ?? {}),
  unpairEngine: () => ipcRenderer.invoke("engine:unpair"),
  restartEngine: () => ipcRenderer.invoke("engine:restart"),
  // The renderer supplies the words: every user-facing string in this app
  // comes from its i18n catalog, and main having its own copy is how the
  // two come to disagree.
  setShellProgress: (progress: { fraction: number; title: string }) =>
    ipcRenderer.invoke("window:set-progress", progress),
  // Whether it is actually shown is main's call: only it can tell a window
  // in front from a page that merely still holds focus.
  notifyDone: (notice: { title: string; body: string }) =>
    ipcRenderer.invoke("shell:notify", notice),
  /**
   * The only channel that pushes rather than answers.
   *
   * The listener is wrapped rather than handed to `ipcRenderer.on` directly:
   * the raw handler's first argument is the IpcRendererEvent, which carries
   * `sender` — a live handle to the whole IPC surface — and passing that
   * across the bridge would hand the page more than the crash it asked for.
   * Returns its own unsubscribe so a remounting component cannot stack
   * listeners.
   */
  onEngineCrash: (listener: (crash: unknown) => void) => {
    const handler = (_event: unknown, crash: unknown): void => listener(crash);
    ipcRenderer.on("engine:crashed", handler);
    return () => void ipcRenderer.off("engine:crashed", handler);
  },
  armProviderKeys: () => ipcRenderer.invoke("providers:arm-keys"),
  setProviderKeys: (keys: Record<string, string>) =>
    ipcRenderer.invoke("providers:set-keys", keys),
  getProviderKeyPresence: () => ipcRenderer.invoke("providers:key-presence"),
  clearProviderKey: (id: string) => ipcRenderer.invoke("providers:clear-key", id),
  setTitleBarTheme: (theme: "dark" | "light") =>
    ipcRenderer.invoke("window:set-titlebar-theme", theme),
  // Opens the app's own log directory. No argument: a path from the
  // renderer would make this "open any folder on the machine".
  openLogsFolder: () => ipcRenderer.invoke("support:open-logs"),
  // The renderer contributes what only it has — the engine's versions and
  // system report, which reach it over HTTP — and main adds the logs and
  // asks the user where to save.
  exportSupportBundle: (report: { versions: unknown; system: unknown }) =>
    ipcRenderer.invoke("support:export-bundle", report),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  // Whether a release feed was configured at all. Data, not a call: About
  // needs the answer to decide whether to render the button, and a pane
  // that must await an IPC round trip before it can lay itself out would
  // flash a control it then takes away.
  updatesConfigured: !!process.env.LOCALCUT_UPDATE_FEED?.trim(),
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
