import { create } from "zustand";
import { EngineClient } from "./api/client";
import { t } from "./i18n";
import type {
  Board,
  Checkpoint,
  EditResult,
  EngineEvent,
  Job,
  ModelRow,
  NodeState,
  Project,
  StorageInfo,
  SystemInfo,
  ToolKind,
} from "./api/types";

/** Key ids as the shell stores them — note google's key is `gemini`. */
export type ProviderKeyId = "anthropic" | "openai" | "gemini" | "fal";

/** What the shell tells the renderer about stored keys — presence only,
 * never the key material itself. */
export interface ProviderKeyPresence {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  fal: boolean;
  // false = safeStorage found no OS keychain; keys are merely obfuscated.
  encrypted: boolean;
}

declare global {
  interface Window {
    localcut: {
      getEngineConnection: () => Promise<{
        connection: { url: string; token: string } | null;
        error: string | null;
        remote?: boolean;
        remotePaired?: boolean;
      }>;
      pairEngine: (code: string) => Promise<{ ok: boolean; error: string | null }>;
      unpairEngine: () => Promise<{ ok: boolean; error: string | null }>;
      setProviderKeys: (
        keys: Partial<Record<ProviderKeyId, string>>,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
      getProviderKeyPresence: () => Promise<ProviderKeyPresence>;
      clearProviderKey: (
        id: ProviderKeyId,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
      setTitleBarTheme: (theme: "dark" | "light") => Promise<void>;
    };
  }
}

/** A failed user action, tagged so the screen that started it can show
 * the message next to its own button. */
export interface ActionError {
  scope: "create" | "tool" | "promote" | "approve";
  message: string;
}

/** Baseline for new videos (Settings → Defaults). Home's live changes
 * overwrite it — Premiere's remember-last behavior. */
export interface HomeDefaults {
  aspect: string;
  duration: number;
  mode: "prompt" | "beginner";
  voice: string;
  /** Applied at Create-final-video time (finalize clip model). */
  videoModel: string | null;
}

/** The Home composer's unsent draft — survives Settings round-trips and
 * restarts; cleared on a successful generate. */
export interface HomeDraft {
  prompt: string;
  tool: ToolKind | null;
  toolInput: string;
  voice: string;
  motion: string;
}

interface AppState {
  client: EngineClient | null;
  engineError: string | null;
  actionError: ActionError | null;
  system: SystemInfo | null;
  projects: Project[];
  currentProject: Project | null;
  board: Board | null;
  jobs: Job[];
  /** Unfiltered queue across all projects — Home tile status dots. */
  allJobs: Job[];
  storage: StorageInfo | null;
  engineVersions: { engine_version: string; api_version: number } | null;
  defaults: HomeDefaults;
  homeDraft: HomeDraft;
  selectedNode: string | null;
  models: ModelRow[];
  // model id → last download failure, cleared on retry/success.
  downloadErrors: Record<string, string>;
  firstRunDone: boolean;
  settingsOpen: boolean;
  // Which Settings tab is showing — deep-linkable (engine chip → "engine",
  // the prompt bar's model button → "models").
  settingsTab: string;
  // One natural-language edit at a time — the LLM call is slow and a second
  // plan compiled against the pre-edit view would fight the first.
  editBusy: boolean;
  // True when the connection points at a *verified* remote engine (GPU box).
  remoteEngine: boolean;
  // True when a pairing exists on disk even if the remote is unreachable —
  // so the UI can always offer Disconnect rather than stranding on a dead box.
  remotePaired: boolean;

  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  refreshHome: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  createFromPrompt: (
    prompt: string,
    duration: number,
    aspect: string,
    mode: "prompt" | "beginner",
  ) => Promise<void>;
  createTool: (
    tool: ToolKind,
    input: { prompt?: string; text?: string; voice?: string; motion?: string },
  ) => Promise<void>;
  promote: () => Promise<void>;
  approve: (checkpoint: Checkpoint) => Promise<void>;
  refreshBoard: () => Promise<void>;
  regenerate: (nodeId: string) => Promise<void>;
  applyNode: (
    nodeId: string,
    changes: { params?: Record<string, unknown>; seed?: number; model?: string | null },
  ) => Promise<void>;
  togglePin: (nodeId: string, pin: boolean) => Promise<void>;
  edit: (instruction: string, scope?: string) => Promise<EditResult | null>;
  cancelJob: (jobId: string) => Promise<void>;
  conditionScene: (sceneId: string, file: File) => Promise<void>;
  applyClonedVoice: (file: File) => Promise<void>;
  applyTimeline: (params: Record<string, unknown>) => void;
  applyExport: (params: Record<string, unknown>) => void;
  finalize: () => Promise<void>;
  select: (nodeId: string | null) => void;
  refreshModels: () => Promise<void>;
  startDownload: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  pairRemote: (code: string) => Promise<string | null>;
  unpairRemote: () => Promise<string | null>;
  finishFirstRun: () => void;
  resetFirstRun: () => void;
  openSettings: (tab?: string) => void;
  setSettingsTab: (tab: string) => void;
  closeSettings: () => void;
  /** Lifecycle actions return the error message to show, or null on success. */
  deleteProject: (id: string) => Promise<string | null>;
  renameProject: (id: string, title: string) => Promise<string | null>;
  duplicateProject: (id: string) => Promise<string | null>;
  refreshStorage: () => Promise<void>;
  cleanupStorage: () => Promise<number | null>;
  addCustomModel: (body: {
    name: string;
    task: string;
    source: "url" | "file";
    ref: string;
    vram_gb?: number;
    workflow_template?: string;
  }) => Promise<string | null>;
  deleteCustomModel: (modelId: string) => Promise<void>;
  setDefaults: (patch: Partial<HomeDefaults>) => void;
  setHomeDraft: (patch: Partial<HomeDraft>) => void;
}

const FIRST_RUN_KEY = "localcut.firstRunDone";
const DEFAULTS_KEY = "localcut.defaults.v1";
const DRAFT_KEY = "localcut.home.draft";
const REFRESH_DEBOUNCE_MS = 150;
const HOME_REFRESH_DEBOUNCE_MS = 600;
const RECONNECT_DELAY_MS = 3000;
const PATCH_DEBOUNCE_MS = 300;

const FALLBACK_DEFAULTS: HomeDefaults = {
  aspect: "9:16",
  duration: 60,
  mode: "prompt",
  voice: "",
  videoModel: null,
};

const EMPTY_DRAFT: HomeDraft = { prompt: "", tool: null, toolInput: "", voice: "", motion: "" };

function loadPersisted<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}
// A stale /models snapshot can lag a terminal download event — refetch
// once more after the engine has settled.
const DOWNLOAD_SETTLE_MS = 1500;

interface PendingPatch {
  projectId: string;
  params: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
  // In-flight PATCH. The entry stays in the map until it resolves so
  // withPending keeps shielding refreshes that raced the request.
  sent?: Promise<void>;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshQueued = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
// One in-flight establish, shared by connect and reconnect: StrictMode
// double-mount must not open two sockets.
let establishing: Promise<void> | null = null;
// Bumped on every establish; a stale establish (superseded by an engine
// switch mid-flight) sees the mismatch and bails instead of pointing the
// store back at the old engine.
let establishGen = 0;
const pendingPatches = new Map<string, PendingPatch>();
// Download bookkeeping — the WS is fresher than any /models snapshot.
// wsProgress holds the latest bytes per model; terminalDownloads marks
// models whose download already ended so a stale row can't resurrect it.
const wsProgress = new Map<string, { done: number; total: number }>();
const terminalDownloads = new Set<string>();

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Drop all per-engine module state — pending edits, download bookkeeping —
// when the engine itself changes (pair/unpair). Otherwise the old engine's
// in-flight PATCH fires at the new one, and its download bytes/errors bleed
// into the new engine's model list.
const resetEngineScopedState = () => {
  for (const pending of pendingPatches.values()) clearTimeout(pending.timer);
  pendingPatches.clear();
  wsProgress.clear();
  terminalDownloads.clear();
};

export const useApp = create<AppState>((set, get) => {
  // Home's tiles show live status for EVERY project (dots + fresh thumbs),
  // so off-project job events refresh the light home read model, debounced.
  let homeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHomeRefresh = () => {
    if (homeRefreshTimer) return;
    homeRefreshTimer = setTimeout(() => {
      homeRefreshTimer = null;
      get()
        .refreshHome()
        .catch((err) => console.warn("home refresh failed:", err));
    }, HOME_REFRESH_DEBOUNCE_MS);
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) return; // one pending attempt, no matter how many drops
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void get().reconnect();
    }, RECONNECT_DELAY_MS);
  };

  // Leading + trailing debounce: refresh right away, and once more after the
  // window if further events arrived — a continuous stream can't starve it.
  const scheduleRefresh = () => {
    const refresh = () =>
      get()
        .refreshBoard()
        .catch((err) => console.warn("board refresh failed:", err));
    if (refreshTimer) {
      refreshQueued = true;
      return;
    }
    void refresh();
    const arm = () => {
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
          arm();
        }
      }, REFRESH_DEBOUNCE_MS);
    };
    arm();
  };

  // Patch progress into the board and queue in place — no HTTP refetch.
  const applyProgress = (event: { job_id: string; node_id: string; progress: number }) => {
    const { board, jobs } = get();
    const patch = <T extends NodeState | null>(node: T): T =>
      node && node.node_id === event.node_id
        ? ({ ...node, progress: event.progress } as T)
        : node;
    set({
      board: board
        ? {
            scenes: board.scenes.map((scene) => ({
              ...scene,
              keyframe: patch(scene.keyframe),
              clip: patch(scene.clip),
              narration: patch(scene.narration),
            })),
            aux: Object.fromEntries(
              Object.entries(board.aux).map(([name, node]) => [name, patch(node)]),
            ),
          }
        : board,
      jobs: jobs.map((job) =>
        job.id === event.job_id ? { ...job, progress: event.progress } : job,
      ),
    });
  };

  // Download bars update in place from WS bytes — no HTTP refetch per tick.
  const applyDownloadProgress = (event: { model: string; done: number; total: number }) => {
    // A progress tick means the download is live (again).
    terminalDownloads.delete(event.model);
    wsProgress.set(event.model, { done: event.done, total: event.total });
    set({
      models: get().models.map((row) =>
        row.id === event.model
          ? { ...row, downloading: true, progress: { done: event.done, total: event.total } }
          : row,
      ),
    });
  };

  // A /models response can be older than the WS stream it races: it may
  // still say `downloading` after the terminal event, or carry byte counts
  // behind the last progress tick. Never let it move a bar backward or
  // resurrect a finished download.
  const reconcileModels = (rows: ModelRow[]): ModelRow[] =>
    rows.map((row) => {
      if (row.downloaded) {
        wsProgress.delete(row.id);
        return row;
      }
      if (terminalDownloads.has(row.id)) {
        return row.downloading ? { ...row, downloading: false, progress: null } : row;
      }
      const ws = wsProgress.get(row.id);
      if (!ws) return row;
      return {
        ...row,
        downloading: true,
        progress: { done: Math.max(ws.done, row.progress?.done ?? 0), total: ws.total },
      };
    });

  // Param edits are optimistic: the board updates immediately, the PATCH is
  // debounced per node with changed keys merged, and the WS-driven refresh
  // brings back the server truth once the dirty subgraph re-renders.
  // The pending entry outlives the request: it is removed only once the
  // PATCH settles (and only if a newer edit hasn't replaced it), so a
  // refresh whose GET raced the PATCH still gets the edit reapplied.
  const sendPatch = (nodeId: string): Promise<void> => {
    const pending = pendingPatches.get(nodeId);
    if (!pending) return Promise.resolve();
    if (pending.sent) return pending.sent; // already on the wire
    clearTimeout(pending.timer);
    const { client } = get();
    if (!client) {
      pendingPatches.delete(nodeId);
      return Promise.resolve();
    }
    pending.sent = client
      .patch(pending.projectId, [{ op: "set_params", node_id: nodeId, params: pending.params }])
      .then(() => undefined)
      .catch((err) => {
        console.warn(`patch ${nodeId} failed:`, err);
        void get().refreshBoard();
      })
      .finally(() => {
        if (pendingPatches.get(nodeId) === pending) pendingPatches.delete(nodeId);
      });
    return pending.sent;
  };

  // Resolves once every flushed PATCH has settled — callers that act on
  // the flushed state (finalize, project switch) must await it.
  const flushPatches = (): Promise<void> =>
    Promise.all([...pendingPatches.keys()].map(sendPatch)).then(() => undefined);

  const applyAuxParams = (nodeId: string, params: Record<string, unknown>) => {
    const { board, client, currentProject } = get();
    const node = board?.aux[nodeId];
    if (!board || !node || !client || !currentProject) return;
    set({
      board: {
        ...board,
        aux: { ...board.aux, [nodeId]: { ...node, params: { ...node.params, ...params } } },
      },
    });
    const prev = pendingPatches.get(nodeId);
    if (prev) clearTimeout(prev.timer);
    const carried = prev?.projectId === currentProject.id ? prev.params : {};
    pendingPatches.set(nodeId, {
      projectId: currentProject.id,
      params: { ...carried, ...params },
      timer: setTimeout(() => sendPatch(nodeId), PATCH_DEBOUNCE_MS),
    });
  };

  // Keep unsent optimistic edits on top of a freshly fetched board.
  const withPending = (board: Board, projectId: string): Board => {
    let aux = board.aux;
    for (const [nodeId, pending] of pendingPatches) {
      const node = aux[nodeId];
      if (!node || pending.projectId !== projectId) continue;
      aux = { ...aux, [nodeId]: { ...node, params: { ...node.params, ...pending.params } } };
    }
    return aux === board.aux ? board : { ...board, aux };
  };

  const establish = async () => {
    const gen = ++establishGen;
    unsubscribe?.(); // never leak a previous subscription
    unsubscribe = null;
    const { connection, error, remote, remotePaired } =
      await window.localcut.getEngineConnection();
    // A newer establish (an engine switch) superseded us while we awaited —
    // bail so we never point the store back at the old engine.
    if (gen !== establishGen) return;
    if (!connection) {
      set({
        client: null,
        engineError: error ?? t("errors.engineUnavailable"),
        remoteEngine: false,
        remotePaired: remotePaired === true,
      });
      return;
    }
    const client = new EngineClient(connection);
    set({
      client,
      engineError: null,
      remoteEngine: remote === true,
      remotePaired: remotePaired === true,
    });

    const sub = client.subscribe(
      (event: EngineEvent) => {
        // Drop project-scoped events for a project we're not viewing: the WS
        // is a global stream and job events name node ids ("timeline",
        // "script") that exist in every project, so an unscoped apply would
        // patch this board with another project's progress. Download events
        // carry no project_id and always pass through.
        const scoped = (event as { project_id?: string }).project_id;
        if (scoped !== undefined && scoped !== get().currentProject?.id) {
          // Not this board's event — but tile status/thumbs on Home still
          // move on job lifecycle edges (progress ticks are noise there).
          if (event.type !== "job.progress") scheduleHomeRefresh();
          return;
        }
        if (event.type === "job.progress") {
          applyProgress(event);
        } else if (event.type === "model.download.progress") {
          applyDownloadProgress(event);
        } else if (
          event.type === "model.download.done" ||
          event.type === "model.download.failed" ||
          event.type === "model.download.cancelled"
        ) {
          // Terminal states: record the failure, then refetch the
          // authoritative install flags.
          terminalDownloads.add(event.model);
          wsProgress.delete(event.model);
          const errors = { ...get().downloadErrors };
          if (event.type === "model.download.failed") errors[event.model] = event.error;
          else delete errors[event.model];
          set({ downloadErrors: errors });
          const refetch = () =>
            get()
              .refreshModels()
              .catch((err) => console.warn("models refresh failed:", err));
          void refetch();
          // The engine can still report `downloading` for a beat after the
          // terminal event — refetch once more when it has settled.
          setTimeout(() => void refetch(), DOWNLOAD_SETTLE_MS);
        } else if (
          event.type.startsWith("job.") ||
          event.type === "project.expanded" ||
          event.type === "project.edited"
        ) {
          scheduleRefresh();
        }
      },
      () => {
        set({ engineError: t("errors.engineLost") });
        scheduleReconnect();
      },
    );
    // Superseded after we subscribed (a switch raced us): close this socket and
    // don't record it as the live subscription.
    if (gen !== establishGen) {
      sub();
      return;
    }
    unsubscribe = sub;

    await get().refreshHome();
    // Models too: the queue tray must be able to say "downloads paused"
    // right on Home after a relaunch, not only once Settings mounts.
    void get()
      .refreshModels()
      .catch((err) => console.warn("models refresh failed:", err));
    if (get().currentProject) await get().refreshBoard();
    try {
      // Guard the set: `client` here is this establish's own closure, so a
      // superseded establish must not write the old engine's hardware over
      // the new one's. (refreshHome/refreshBoard read get().client, so they
      // already resolve against the live engine.)
      const info = await client.system();
      if (gen === establishGen) set({ system: info });
    } catch {
      /* system info is cosmetic at this stage */
    }
    try {
      // Version handshake for Settings → About.
      const health = await client.health();
      if (gen === establishGen) {
        set({
          engineVersions: {
            engine_version: health.engine_version,
            api_version: health.api_version,
          },
        });
      }
    } catch {
      /* about-card data only */
    }
  };

  // Concurrent callers share the same attempt; a second establish while one
  // is mid-flight would subscribe twice and leak the first socket.
  const establishOnce = () => {
    if (!establishing) {
      const p = establish().finally(() => {
        // Only clear the slot if THIS attempt still owns it — switchEngine may
        // have replaced it with a fresh establish for the new engine, and
        // nulling that one would let a redundant concurrent establish spawn.
        if (establishing === p) establishing = null;
      });
      establishing = p;
    }
    return establishing;
  };

  // Pair/unpair swap the engine under us: drop every per-engine slice (zustand
  // and module-level) so the old engine's in-flight PATCH, download bytes, and
  // project list can't bleed into the new one, then reconnect.
  const switchEngine = async () => {
    resetEngineScopedState();
    set({
      currentProject: null,
      board: null,
      jobs: [],
      projects: [],
      models: [],
      downloadErrors: {},
      // The old engine's hardware/recommendations must not survive the switch
      // (establish repopulates it, or leaves it null if the new engine's
      // /system errors — better blank than another box's specs).
      system: null,
    });
    // Force a fresh establish for the NEW engine: reusing an in-flight one
    // (e.g. a reconnect already bound to the old connection) would leave the
    // client and WS pointed at the old/dead engine.
    establishing = null;
    await establishOnce();
  };

  return {
    client: null,
    engineError: null,
    actionError: null,
    system: null,
    projects: [],
    currentProject: null,
    board: null,
    jobs: [],
    allJobs: [],
    storage: null,
    engineVersions: null,
    defaults: loadPersisted(DEFAULTS_KEY, FALLBACK_DEFAULTS),
    homeDraft: loadPersisted(DRAFT_KEY, EMPTY_DRAFT),
    selectedNode: null,
    models: [],
    downloadErrors: {},
    firstRunDone: localStorage.getItem(FIRST_RUN_KEY) === "1",
    settingsOpen: false,
    settingsTab: "general",
    editBusy: false,
    remoteEngine: false,
    remotePaired: false,

    connect: async () => {
      if (get().client) return; // idempotent under StrictMode double-mount
      await establishOnce();
    },

    reconnect: async () => {
      try {
        await establishOnce();
      } catch (err) {
        console.warn("reconnect failed:", err);
      }
      if (!get().client) scheduleReconnect(); // engine still down — keep trying
    },

    refreshHome: async () => {
      const { client } = get();
      if (!client) return;
      // Jobs ride along for the tile status dots; a jobs failure must not
      // take the project list down with it.
      const [projects, allJobs] = await Promise.all([
        client.listProjects(),
        client.listJobs().catch(() => get().allJobs),
      ]);
      set({ projects, allJobs });
    },

    openProject: async (id: string) => {
      const { client } = get();
      if (!client) return;
      // The GET must observe the flushed edits, not race them.
      await flushPatches();
      // Fetch jobs alongside the board: without this the jobs slice keeps
      // showing the previously open project's jobs until some WS event happens
      // to trigger a refresh (never, for an idle project).
      const [{ project, board }, jobs] = await Promise.all([
        client.getProject(id),
        // Jobs are secondary: a transient /jobs failure must not abort opening
        // the project. Empty is fine — the next non-progress job event triggers
        // a board refresh (scheduleRefresh) that repopulates the list.
        client.listJobs(id).catch(() => [] as Job[]),
      ]);
      // Keep an optimistic aux edit made mid-load on top of the fetched board,
      // exactly as refreshBoard does, instead of dropping it.
      set({ currentProject: project, board: withPending(board, id), jobs, selectedNode: null });
    },

    closeProject: () => {
      void flushPatches(); // nothing reads the project after this — fire and forget
      set({ currentProject: null, board: null, jobs: [], selectedNode: null });
    },

    createFromPrompt: async (prompt, duration, aspect, mode) => {
      const { client } = get();
      if (!client) return;
      set({ actionError: null });
      try {
        const project = await client.createProject({
          prompt,
          target_duration_s: duration,
          aspect,
          mode,
        });
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn("create project failed:", err);
        set({ actionError: { scope: "create", message: messageOf(err) } });
      }
    },

    createTool: async (tool, input) => {
      const { client } = get();
      if (!client) return;
      set({ actionError: null });
      try {
        const project = await client.createTool({ tool, ...input });
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn(`tool ${tool} failed:`, err);
        set({ actionError: { scope: "tool", message: messageOf(err) } });
      }
    },

    promote: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      set({ actionError: null });
      try {
        const project = await client.promote(currentProject.id);
        await get().openProject(project.id);
        await get().refreshHome();
      } catch (err) {
        console.warn("promote failed:", err);
        set({ actionError: { scope: "promote", message: messageOf(err) } });
      }
    },

    approve: async (checkpoint) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      set({ actionError: null });
      // Was it already approved before this call? If so, the rollback below
      // must NOT strip it — we only ever undo the approval WE optimistically
      // added, never one that pre-existed.
      const alreadyApproved = currentProject.approvals.includes(checkpoint);
      if (!alreadyApproved) {
        set({
          currentProject: {
            ...currentProject,
            approvals: [...currentProject.approvals, checkpoint],
          },
        });
      }
      try {
        await client.approve(projectId, checkpoint);
      } catch (err) {
        console.warn(`approve ${checkpoint} failed:`, err);
        set({ actionError: { scope: "approve", message: messageOf(err) } });
        try {
          const { project } = await client.getProject(projectId);
          if (get().currentProject?.id === projectId) set({ currentProject: project });
        } catch (rollbackErr) {
          // Can't refetch the truth either — at least undo the optimistic
          // approval so the checkpoint banner comes back.
          console.warn("approve rollback fetch failed:", rollbackErr);
          const current = get().currentProject;
          if (!alreadyApproved && current?.id === projectId) {
            set({
              currentProject: {
                ...current,
                approvals: current.approvals.filter((a) => a !== checkpoint),
              },
            });
          }
        }
        return;
      }
      await get().refreshBoard();
    },

    refreshBoard: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      const [{ project, board }, jobs] = await Promise.all([
        client.getProject(projectId),
        client.listJobs(projectId),
      ]);
      // A late response for a previously open project must not clobber the
      // one the user has since opened.
      if (get().currentProject?.id !== projectId) return;
      set({ currentProject: project, board: withPending(board, projectId), jobs });
    },

    regenerate: async (nodeId) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      await client.regenerate(currentProject.id, nodeId);
      await get().refreshBoard();
    },

    applyNode: async (nodeId, changes) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const ops: Parameters<EngineClient["patch"]>[1] = [];
      if (changes.params && Object.keys(changes.params).length > 0) {
        ops.push({ op: "set_params", node_id: nodeId, params: changes.params });
      }
      if (changes.seed !== undefined) {
        ops.push({ op: "set_seed", node_id: nodeId, seed: changes.seed });
      }
      if (changes.model !== undefined) {
        ops.push({ op: "set_model", node_id: nodeId, model: changes.model });
      }
      if (ops.length === 0) return;
      await client.patch(currentProject.id, ops);
      await get().refreshBoard();
    },

    togglePin: async (nodeId, pin) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      await client.patch(currentProject.id, [{ op: pin ? "pin" : "unpin", node_id: nodeId }]);
      await get().refreshBoard();
    },

    edit: async (instruction, scope = "project") => {
      const { client, currentProject, editBusy } = get();
      if (!client || !currentProject || editBusy) return null;
      // The LLM's view must include the user's latest manual tweaks.
      await flushPatches();
      set({ editBusy: true });
      try {
        const result = await client.edit(currentProject.id, { instruction, scope });
        await get().refreshBoard();
        return result;
      } finally {
        set({ editBusy: false });
      }
    },

    cancelJob: async (jobId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.cancelJob(jobId);
      } catch (err) {
        // 409 = it finished (or died) before the click landed; the refresh
        // below shows the truth either way.
        console.warn(`cancel job ${jobId} failed:`, err);
      }
      await get().refreshBoard();
    },

    conditionScene: async (sceneId, file) => {
      const { client, currentProject, board } = get();
      if (!client || !currentProject) return;
      const asset = await client.uploadAsset(currentProject.id, file);
      // Every take of the scene draws from the same source image, exactly
      // like the generated keyframe it displaces.
      const scene = board?.scenes.find((entry) => entry.scene_id === sceneId);
      const takes = [
        `${sceneId}.clip`,
        ...(scene?.clip_takes ?? [])
          .filter((take): take is NodeState => take !== null)
          .map((take) => take.node_id),
      ];
      await client.patch(
        currentProject.id,
        takes.map((nodeId) => ({
          op: "connect",
          node_id: nodeId,
          src: asset.node_id,
          port: "keyframe",
        })),
      );
      await get().refreshBoard();
    },

    applyClonedVoice: async (file) => {
      const { client, currentProject, board } = get();
      if (!client || !currentProject || !board) return;
      // The consent affirmation was collected in the UI; the engine refuses
      // the sample without it either way.
      const asset = await client.uploadAsset(currentProject.id, file, { consent: true });
      // One speaker across the whole video: every scene's narration clones
      // from the same sample.
      const narrations = board.scenes
        .map((scene) => scene.narration)
        .filter((node): node is NodeState => node !== null);
      await client.patch(
        currentProject.id,
        narrations.flatMap((node) => [
          { op: "set_model", node_id: node.node_id, model: "local:chatterbox" },
          { op: "connect", node_id: node.node_id, src: asset.node_id, port: "voice_ref" },
        ]),
      );
      await get().refreshBoard();
    },

    applyTimeline: (params) => applyAuxParams("timeline", params),

    applyExport: (params) => applyAuxParams("export", params),

    finalize: async () => {
      const { client, currentProject, defaults } = get();
      if (!client || !currentProject) return;
      // The engine must compile with the flushed params, not race them.
      await flushPatches();
      // Settings → Defaults' video model rides along (engine config wins
      // engine-side when this is null).
      await client.finalize(currentProject.id, defaults.videoModel);
      await get().refreshBoard();
    },

    select: (nodeId) => set({ selectedNode: nodeId }),

    refreshModels: async () => {
      const { client } = get();
      if (!client) return;
      set({ models: reconcileModels(await client.listModels()) });
    },

    startDownload: async (modelId) => {
      const { client, downloadErrors } = get();
      if (!client) return;
      if (modelId in downloadErrors) {
        const { [modelId]: _dropped, ...rest } = downloadErrors;
        set({ downloadErrors: rest });
      }
      try {
        await client.startDownload(modelId);
        // A fresh start voids any previous terminal state and byte counts.
        terminalDownloads.delete(modelId);
        wsProgress.delete(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
    },

    cancelDownload: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.cancelDownload(modelId);
      } catch (err) {
        // 409 = already finished; the refresh below shows the truth.
        console.warn(`cancel ${modelId} failed:`, err);
      }
      await get().refreshModels();
    },

    deleteModel: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.deleteModel(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
    },

    pairRemote: async (code) => {
      const { ok, error } = await window.localcut.pairEngine(code);
      if (!ok) return error ?? t("errors.pairingFailed");
      await switchEngine(); // the engine changed under us — reset and reconnect
      return null;
    },

    unpairRemote: async () => {
      const { ok, error } = await window.localcut.unpairEngine();
      await switchEngine();
      return ok ? null : (error ?? t("errors.disconnectFailed"));
    },

    finishFirstRun: () => {
      localStorage.setItem(FIRST_RUN_KEY, "1");
      set({ firstRunDone: true });
    },

    resetFirstRun: () => {
      localStorage.removeItem(FIRST_RUN_KEY);
      set({ firstRunDone: false, settingsOpen: false });
    },

    openSettings: (tab) =>
      set(tab ? { settingsOpen: true, settingsTab: tab } : { settingsOpen: true }),

    setSettingsTab: (tab) => set({ settingsTab: tab }),

    closeSettings: () => set({ settingsOpen: false }),

    // -- project lifecycle (review 4) — optimistic, with rollback ----------

    deleteProject: async (id) => {
      const { client, projects } = get();
      if (!client) return t("errors.engineUnavailable");
      set({ projects: projects.filter((project) => project.id !== id) });
      if (get().currentProject?.id === id) get().closeProject();
      try {
        await client.deleteProject(id);
        return null;
      } catch (err) {
        console.warn("delete project failed:", err);
        set({ projects });
        return messageOf(err);
      }
    },

    renameProject: async (id, title) => {
      const { client, projects } = get();
      if (!client) return t("errors.engineUnavailable");
      set({
        projects: projects.map((project) =>
          project.id === id ? { ...project, title } : project,
        ),
      });
      const current = get().currentProject;
      if (current?.id === id) set({ currentProject: { ...current, title } });
      try {
        await client.renameProject(id, title);
        return null;
      } catch (err) {
        console.warn("rename project failed:", err);
        set({ projects });
        return messageOf(err);
      }
    },

    duplicateProject: async (id) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        const copy = await client.duplicateProject(id);
        set({ projects: [copy, ...get().projects] });
        return null;
      } catch (err) {
        console.warn("duplicate project failed:", err);
        return messageOf(err);
      }
    },

    refreshStorage: async () => {
      const { client } = get();
      if (!client) return;
      try {
        set({ storage: await client.storage() });
      } catch (err) {
        console.warn("storage overview failed:", err);
      }
    },

    cleanupStorage: async () => {
      const { client } = get();
      if (!client) return null;
      try {
        const { freed_bytes } = await client.storageCleanup();
        await get().refreshStorage();
        return freed_bytes;
      } catch (err) {
        console.warn("cache cleanup failed:", err);
        return null;
      }
    },

    addCustomModel: async (body) => {
      const { client } = get();
      if (!client) return t("errors.engineUnavailable");
      try {
        await client.addCustomModel(body);
      } catch (err) {
        return messageOf(err);
      }
      await get().refreshModels();
      return null;
    },

    deleteCustomModel: async (modelId) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.deleteCustomModel(modelId);
      } catch (err) {
        set({
          downloadErrors: { ...get().downloadErrors, [modelId]: messageOf(err) },
        });
      }
      await get().refreshModels();
    },

    setDefaults: (patch) => {
      const next = { ...get().defaults, ...patch };
      set({ defaults: next });
      try {
        localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
      } catch {
        /* storage full — the baseline just won't persist */
      }
    },

    setHomeDraft: (patch) => {
      const next = { ...get().homeDraft, ...patch };
      set({ homeDraft: next });
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* storage full — the draft just won't persist */
      }
    },
  };
});
