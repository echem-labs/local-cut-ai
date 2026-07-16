import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer gets exactly one thing from the shell: where the engine is
 * and how to authenticate. All data flows over the engine's HTTP/WS API —
 * no filesystem shortcuts.
 */
contextBridge.exposeInMainWorld("localcut", {
  getEngineConnection: () => ipcRenderer.invoke("engine:connection"),
});
