/**
 * A stand-in for the `electron` module, aliased over it for main-process tests.
 *
 * The real `electron` package resolves in Node to a *string* — the path to the
 * Electron binary — so `import { app } from "electron"` outside an Electron
 * runtime yields undefined and every main-process file fails at first use.
 * That is the whole reason this code went untested. Aliasing the specifier at
 * the resolver (see the `main` project in vitest.config.ts) is enough: the
 * modules under test are ordinary TypeScript, and only the handful of Electron
 * surfaces below are actually reached.
 *
 * Test files import this by path to drive `state`; the code under test imports
 * "electron" and gets the same module instance through the alias.
 *
 * Deliberately hand-written rather than `vi.mock`ed: these fakes carry real
 * behaviour (safeStorage seals and refuses to open a blob from another
 * keychain; the IPC registry replays handlers), and an auto-mock returning
 * undefined everywhere would let a test pass against code that never ran.
 */

/** Everything a test can vary. Reset between tests via `resetElectron()`. */
export const state = {
  /** Backs `app.getPath("userData")` — point this at a tmp dir. */
  userData: "",
  isPackaged: false,
  /** `false` makes the whenReady body quit early, so importing main.ts is inert. */
  singleInstanceLock: false,
  encryptionAvailable: true,
  /** Linux-only; `basic_text` is Chromium's hardcoded-password fallback. */
  storageBackend: "gnome_libsecret" as string,
  /**
   * Identity of the "keychain". Changing it between a seal and an open makes
   * decryptString throw exactly as a rotated OS keychain does.
   */
  keychainId: "keychain-1",
  shouldUseDarkColors: false,
};

/** Delimiter around the keychain identity in a sealed blob. Any marker no
 * real API key would contain does; it just has to survive a round-trip and
 * be visible in a diff — NUL bytes make git treat the file as binary. */
const SEAL = "::sealed::";

export function resetElectron(): void {
  state.userData = "";
  state.isPackaged = false;
  state.singleInstanceLock = false;
  state.encryptionAvailable = true;
  state.storageBackend = "gnome_libsecret";
  state.keychainId = "keychain-1";
  state.shouldUseDarkColors = false;
  ipcHandlers.clear();
  appEvents.clear();
  openedPaths.length = 0;
  openedExternally.length = 0;
  saveDialogs.length = 0;
  shell.openPathFailure = "";
  dialog.result = { canceled: false, filePath: "" };
  windows.length = 0;
  certificateVerifyProc = null;
  quitCalls = 0;
  applicationMenu = undefined;
}

/* ------------------------------------------------------------------ app -- */

const appEvents = new Map<string, ((...args: unknown[]) => void)[]>();
let quitCalls = 0;

export const app = {
  getPath(name: string): string {
    if (name !== "userData") throw new Error(`stub app.getPath: unhandled ${name}`);
    if (!state.userData) throw new Error("stub app.getPath: set state.userData first");
    return state.userData;
  },
  // main.ts calls this at module scope for the rig's fresh-profile override.
  // Missing here, `LOCALCUT_USERDATA` merely being exported in the shell took
  // out every test in this suite with "app.setPath is not a function".
  setPath(name: string, value: string): void {
    if (name !== "userData") throw new Error(`stub app.setPath: unhandled ${name}`);
    state.userData = value;
  },
  get isPackaged(): boolean {
    return state.isPackaged;
  },
  whenReady(): Promise<void> {
    return Promise.resolve();
  },
  requestSingleInstanceLock(): boolean {
    return state.singleInstanceLock;
  },
  quit(): void {
    quitCalls += 1;
  },
  // Electron returns the App for chaining; nothing here chains, and saying so
  // would make `app` self-referential and untypeable.
  on(event: string, listener: (...args: unknown[]) => void): void {
    appEvents.set(event, [...(appEvents.get(event) ?? []), listener]);
  },
};

export const quitCount = (): number => quitCalls;

/** Fire an `app.on(...)` listener the way Electron would. */
export function emitApp(event: string, ...args: unknown[]): void {
  for (const listener of appEvents.get(event) ?? []) listener(...args);
}

export const hasAppListener = (event: string): boolean => (appEvents.get(event)?.length ?? 0) > 0;

/* ----------------------------------------------------------- safeStorage -- */

export const safeStorage = {
  isEncryptionAvailable: (): boolean => state.encryptionAvailable,
  getSelectedStorageBackend: (): string => state.storageBackend,
  encryptString(plain: string): Buffer {
    if (!state.encryptionAvailable) throw new Error("stub safeStorage: encryption unavailable");
    return Buffer.from(`${SEAL}${state.keychainId}${SEAL}${plain}`, "utf8");
  },
  decryptString(blob: Buffer): string {
    const text = blob.toString("utf8");
    const parts = text.split(SEAL);
    // A plaintext blob has no seal — opening one must fail, or a test could
    // not tell "re-encoded on a mode change" from "left the old bytes alone".
    if (parts.length !== 3 || parts[0] !== "") throw new Error("stub safeStorage: not a blob");
    if (parts[1] !== state.keychainId) throw new Error("stub safeStorage: keychain changed");
    return parts[2];
  },
};

/** Whether a stored base64 blob is sealed (vs. plain base64 of the value). */
export const isSealed = (base64: string): boolean =>
  Buffer.from(base64, "base64").toString("utf8").startsWith(SEAL);

/* --------------------------------------------------------------- ipcMain -- */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const ipcHandlers = new Map<string, IpcHandler>();

export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    ipcHandlers.set(channel, handler);
  },
};

export const ipcChannels = (): string[] => [...ipcHandlers.keys()];

/** Invoke a registered handler as the renderer would. */
export function invokeIpc(channel: string, event: unknown, ...args: unknown[]): unknown {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`stub ipcMain: nothing registered for ${channel}`);
  return handler(event, ...args);
}

/** An `IpcMainInvokeEvent` whose sender frame is the app's own top frame. */
export const senderFrom = (url: string, parent: unknown = null) => ({
  senderFrame: { url, parent },
  sender: {},
});

/* --------------------------------------------------------- BrowserWindow -- */

export class BrowserWindow {
  static readonly instances: BrowserWindow[] = [];
  readonly options: Record<string, unknown>;
  readonly loaded: string[] = [];
  readonly overlays: unknown[] = [];
  /** URLs handed to webContents.downloadURL by the navigation handler. */
  readonly downloads: string[] = [];
  minimized = false;
  focused = false;
  restored = false;
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
  private readonly navigationListeners: ((event: { preventDefault(): void }, url: string) => void)[] =
    [];

  readonly webContents = {
    on: (event: string, listener: (e: { preventDefault(): void }, url: string) => void) => {
      if (event === "will-navigate") this.navigationListeners.push(listener);
    },
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
      this.windowOpenHandler = handler;
    },
    downloadURL: (url: string) => {
      this.downloads.push(url);
    },
  };

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    windows.push(this);
  }

  /** Run the will-navigate listeners; returns whether navigation was allowed. */
  navigateTo(url: string): boolean {
    let prevented = false;
    for (const listener of this.navigationListeners) {
      listener({ preventDefault: () => (prevented = true) }, url);
    }
    return !prevented;
  }

  async loadURL(url: string): Promise<void> {
    this.loaded.push(url);
  }
  async loadFile(file: string): Promise<void> {
    this.loaded.push(file);
  }
  setTitleBarOverlay(overlay: unknown): void {
    this.overlays.push(overlay);
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.restored = true;
  }
  focus(): void {
    this.focused = true;
  }

  static getAllWindows(): BrowserWindow[] {
    return windows;
  }
  static fromWebContents(contents: unknown): BrowserWindow | null {
    return windows.find((w) => w.webContents === contents) ?? null;
  }
}

const windows: BrowserWindow[] = BrowserWindow.instances;

/* ------------------------------------------------------------ misc APIs -- */

let applicationMenu: unknown;
export const Menu = {
  setApplicationMenu(menu: unknown): void {
    applicationMenu = menu;
  },
};
export const applicationMenuValue = (): unknown => applicationMenu;

export const nativeTheme = {
  get shouldUseDarkColors(): boolean {
    return state.shouldUseDarkColors;
  },
};

type VerifyRequest = { hostname: string; certificate?: { data?: string } };
type VerifyProc = (request: VerifyRequest, callback: (verdict: number) => void) => void;
let certificateVerifyProc: VerifyProc | null = null;

export const session = {
  defaultSession: {
    setCertificateVerifyProc(proc: VerifyProc): void {
      certificateVerifyProc = proc;
    },
  },
};

/** Run the registered verify proc and return its verdict (0 / -2 / -3). */
export function verifyCertificate(request: VerifyRequest): number {
  if (!certificateVerifyProc) throw new Error("stub session: no verify proc registered");
  let verdict: number | undefined;
  certificateVerifyProc(request, (value) => (verdict = value));
  if (verdict === undefined) throw new Error("stub session: verify proc never called back");
  return verdict;
}

/* ---------------------------------------------------- renderer-side APIs -- */

export const exposedBridges = new Map<string, Record<string, (...args: never[]) => unknown>>();
export const contextBridge = {
  exposeInMainWorld(key: string, api: Record<string, (...args: never[]) => unknown>): void {
    exposedBridges.set(key, api);
  },
};

export const ipcInvocations: { channel: string; args: unknown[] }[] = [];
export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    ipcInvocations.push({ channel, args });
    return Promise.resolve(undefined);
  },
};

/* ----------------------------------------------------- shell and dialog -- */

/** Paths handed to shell.openPath, and the reason the next call returns.
 * Electron reports failure here by RESOLVING with a message — "" is
 * success — so a test that only checks the call happened would miss it. */
export const openedPaths: string[] = [];
/** URLs handed to the OS. Kept separate from `openedPaths` because the two
 * carry different risk: a folder is one this process chose, a URL can have
 * come from a release feed. */
export const openedExternally: string[] = [];
export const shell = {
  openPathFailure: "" as string,
  openPath(target: string): Promise<string> {
    openedPaths.push(target);
    return Promise.resolve(shell.openPathFailure);
  },
  openExternal(url: string): Promise<void> {
    openedExternally.push(url);
    return Promise.resolve();
  },
};

/** What the next save dialog answers, and what it was asked. */
export const saveDialogs: unknown[] = [];
interface SaveResult {
  canceled: boolean;
  filePath: string;
}
export const dialog = {
  result: { canceled: false, filePath: "" } as SaveResult,
  showSaveDialog(_window: unknown, options: unknown): Promise<SaveResult> {
    saveDialogs.push(options);
    return Promise.resolve(dialog.result);
  },
};

export const zoomFactors: number[] = [];
export const webFrame = {
  /** The stub's live zoom — read by the redundant-set guard. */
  currentZoom: 1,
  setZoomFactor(factor: number): void {
    zoomFactors.push(factor);
    webFrame.currentZoom = factor;
  },
  getZoomFactor(): number {
    return webFrame.currentZoom;
  },
};

export default {
  app,
  BrowserWindow,
  contextBridge,
  dialog,
  ipcMain,
  ipcRenderer,
  Menu,
  nativeTheme,
  safeStorage,
  session,
  shell,
  webFrame,
};
