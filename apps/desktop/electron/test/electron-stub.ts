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
  /**
   * Whether `app.dock` exists. Electron defines it on macOS and nowhere else,
   * and main.ts uses exactly that to decide whether to set a Dock icon — so
   * the default is the CI runner's answer (no dock) and a macOS test opts in.
   */
  hasDock: false,
  /**
   * Paths `nativeImage.createFromPath` should answer with an EMPTY image, the
   * way the real one does for a file that is not there. It does not throw, so
   * "the packaging stopped carrying this" has no symptom but a blank icon —
   * listing a path here is how a test reaches the branch that says so.
   */
  missingImages: [] as string[],
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
  state.hasDock = false;
  state.missingImages = [];
  appUserModelIds.length = 0;
  dockIcons.length = 0;
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
  notifications.length = 0;
  notificationSupport.supported = true;
}

/* ------------------------------------------------------------------ app -- */

const appEvents = new Map<string, ((...args: unknown[]) => void)[]>();
let quitCalls = 0;

/** AppUserModelIDs set, in order. Windows' notion of "which app is this". */
export const appUserModelIds: string[] = [];
/** Images handed to `app.dock.setIcon` — only reachable when state.hasDock. */
export const dockIcons: StubImage[] = [];

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
  setAppUserModelId(id: string): void {
    appUserModelIds.push(id);
  },
  /** Present only on macOS, which is the check main.ts makes instead of
   * reading process.platform — so this has to be genuinely absent by
   * default, not an object whose methods happen to be unused. */
  get dock(): { setIcon(image: StubImage): void } | undefined {
    if (!state.hasDock) return undefined;
    return {
      setIcon(image: StubImage): void {
        dockIcons.push(image);
      },
    };
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

  /** Everything main pushed at this window's renderer. */
  readonly sent: { channel: string; args: unknown[] }[] = [];
  /** Taskbar/dock progress, in the order it was set. -1 means "no bar". */
  readonly progressBars: number[] = [];
  /** Window titles, in the order they were set. */
  readonly titles: string[] = [];
  /**
   * How many AppUserModelIDs had been claimed when this window was built.
   *
   * Windows attributes a window to whatever identity is current at the moment
   * it appears, and no later call moves it — so "the id was claimed FIRST" is
   * a property of the window, not something the id list can show on its own.
   */
  readonly appUserModelIdsAtCreation: number = appUserModelIds.length;

  setProgressBar(fraction: number): void {
    this.progressBars.push(fraction);
  }

  setTitle(title: string): void {
    this.titles.push(title);
  }

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
    send: (channel: string, ...args: unknown[]) => {
      this.sent.push({ channel, args });
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
  isFocused(): boolean {
    return this.focused;
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

/* --------------------------------------------------------- nativeImage -- */

/** What `nativeImage.createFromPath` hands back. The path is carried on the
 * image itself so a test can assert WHICH file reached the window, the Dock
 * and the toast — the identity is the whole point, and an opaque handle
 * would let a wrong-path regression pass. */
export interface StubImage {
  readonly path: string;
  isEmpty(): boolean;
}

export const nativeImage = {
  createFromPath(imagePath: string): StubImage {
    // Never throws, exactly like the real one — a path that is not there
    // comes back as an image with nothing in it.
    return { path: imagePath, isEmpty: () => state.missingImages.includes(imagePath) };
  },
};

/* ------------------------------------------------------------ misc APIs -- */

let applicationMenu: unknown;
export interface StubNotification {
  title: string;
  body: string;
  /** The image the toast was given, or null. Linux has no other source for
   * one, so "a notification went out" is not the whole assertion. */
  icon: StubImage | null;
  /** Whether `.show()` was reached — constructing one is not showing it. */
  shown: boolean;
  /** Deliver the user's click, so the "bring the window back" path is real
   * rather than merely registered. */
  click(): void;
}

/** Notifications raised, in order. */
export const notifications: StubNotification[] = [];
/** Flipped by a test to stand in for an OS that has them switched off. */
export const notificationSupport = { supported: true };

export class Notification {
  static isSupported(): boolean {
    return notificationSupport.supported;
  }
  private readonly record: StubNotification;
  private readonly clickListeners: (() => void)[] = [];

  constructor(options: { title?: string; body?: string; icon?: StubImage } = {}) {
    this.record = {
      title: options.title ?? "",
      body: options.body ?? "",
      icon: options.icon ?? null,
      shown: false,
      click: () => {
        for (const listener of this.clickListeners) listener();
      },
    };
    notifications.push(this.record);
  }
  on(event: string, listener: () => void): this {
    if (event === "click") this.clickListeners.push(listener);
    return this;
  }
  show(): void {
    this.record.shown = true;
  }
}

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
/** Push-channel listeners, so a test can deliver an event the way Electron
 * does — raw handler first argument is the IpcRendererEvent — and check what
 * the bridge passes on from it. */
export const ipcListeners: { channel: string; handler: (...args: unknown[]) => void }[] = [];
export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    ipcInvocations.push({ channel, args });
    return Promise.resolve(undefined);
  },
  on(channel: string, handler: (...args: unknown[]) => void): void {
    ipcListeners.push({ channel, handler });
  },
  off(channel: string, handler: (...args: unknown[]) => void): void {
    const at = ipcListeners.findIndex(
      (entry) => entry.channel === channel && entry.handler === handler,
    );
    if (at >= 0) ipcListeners.splice(at, 1);
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
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell,
  webFrame,
};
