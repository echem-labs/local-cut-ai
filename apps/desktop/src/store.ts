import { create } from "zustand";
import { EngineClient } from "./api/client";
import type {
  Board,
  Checkpoint,
  EngineEvent,
  Job,
  ModelRow,
  NodeState,
  Project,
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
      }>;
      setProviderKeys: (
        keys: Partial<Record<ProviderKeyId, string>>,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
      getProviderKeyPresence: () => Promise<ProviderKeyPresence>;
      clearProviderKey: (
        id: ProviderKeyId,
      ) => Promise<{ presence: ProviderKeyPresence; error: string | null }>;
    };
  }
}

interface AppState {
  client: EngineClient | null;
  engineError: string | null;
  system: SystemInfo | null;
  projects: Project[];
  currentProject: Project | null;
  board: Board | null;
  jobs: Job[];
  selectedNode: string | null;
  models: ModelRow[];
  // model id → last download failure, cleared on retry/success.
  downloadErrors: Record<string, string>;
  firstRunDone: boolean;
  settingsOpen: boolean;

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
    input: { prompt?: string; text?: string; voice?: string },
  ) => Promise<void>;
  promote: () => Promise<void>;
  approve: (checkpoint: Checkpoint) => Promise<void>;
  refreshBoard: () => Promise<void>;
  regenerate: (nodeId: string) => Promise<void>;
  editPrompt: (nodeId: string, prompt: string) => Promise<void>;
  applyTimeline: (params: Record<string, unknown>) => void;
  applyExport: (params: Record<string, unknown>) => void;
  finalize: () => Promise<void>;
  select: (nodeId: string | null) => void;
  refreshModels: () => Promise<void>;
  startDownload: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  finishFirstRun: () => void;
  resetFirstRun: () => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const FIRST_RUN_KEY = "localcut.firstRunDone";
const REFRESH_DEBOUNCE_MS = 150;
const RECONNECT_DELAY_MS = 3000;
const PATCH_DEBOUNCE_MS = 300;

interface PendingPatch {
  projectId: string;
  params: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshQueued = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
const pendingPatches = new Map<string, PendingPatch>();

export const useApp = create<AppState>((set, get) => {
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
    set({
      models: get().models.map((row) =>
        row.id === event.model
          ? { ...row, downloading: true, progress: { done: event.done, total: event.total } }
          : row,
      ),
    });
  };

  // Param edits are optimistic: the board updates immediately, the PATCH is
  // debounced per node with changed keys merged, and the WS-driven refresh
  // brings back the server truth once the dirty subgraph re-renders.
  const sendPatch = (nodeId: string) => {
    const pending = pendingPatches.get(nodeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPatches.delete(nodeId);
    const { client } = get();
    if (!client) return;
    client
      .patch(pending.projectId, [{ op: "set_params", node_id: nodeId, params: pending.params }])
      .catch((err) => {
        console.warn(`patch ${nodeId} failed:`, err);
        void get().refreshBoard();
      });
  };

  const flushPatches = () => {
    for (const nodeId of [...pendingPatches.keys()]) sendPatch(nodeId);
  };

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
    unsubscribe?.(); // never leak a previous subscription
    unsubscribe = null;
    const { connection, error } = await window.localcut.getEngineConnection();
    if (!connection) {
      set({ client: null, engineError: error ?? "engine unavailable" });
      return;
    }
    const client = new EngineClient(connection);
    set({ client, engineError: null });

    unsubscribe = client.subscribe(
      (event: EngineEvent) => {
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
          const errors = { ...get().downloadErrors };
          if (event.type === "model.download.failed") errors[event.model] = event.error;
          else delete errors[event.model];
          set({ downloadErrors: errors });
          get()
            .refreshModels()
            .catch((err) => console.warn("models refresh failed:", err));
        } else if (event.type.startsWith("job.") || event.type === "project.expanded") {
          scheduleRefresh();
        }
      },
      () => {
        set({ engineError: "connection to engine lost — reconnecting…" });
        scheduleReconnect();
      },
    );

    await get().refreshHome();
    if (get().currentProject) await get().refreshBoard();
    try {
      set({ system: await client.system() });
    } catch {
      /* system info is cosmetic at this stage */
    }
  };

  return {
    client: null,
    engineError: null,
    system: null,
    projects: [],
    currentProject: null,
    board: null,
    jobs: [],
    selectedNode: null,
    models: [],
    downloadErrors: {},
    firstRunDone: localStorage.getItem(FIRST_RUN_KEY) === "1",
    settingsOpen: false,

    connect: async () => {
      if (get().client) return; // idempotent under StrictMode double-mount
      await establish();
    },

    reconnect: async () => {
      try {
        await establish();
      } catch (err) {
        console.warn("reconnect failed:", err);
      }
      if (!get().client) scheduleReconnect(); // engine still down — keep trying
    },

    refreshHome: async () => {
      const { client } = get();
      if (!client) return;
      set({ projects: await client.listProjects() });
    },

    openProject: async (id: string) => {
      const { client } = get();
      if (!client) return;
      flushPatches();
      const { project, board } = await client.getProject(id);
      set({ currentProject: project, board, selectedNode: null });
    },

    closeProject: () => {
      flushPatches();
      set({ currentProject: null, board: null, jobs: [], selectedNode: null });
    },

    createFromPrompt: async (prompt, duration, aspect, mode) => {
      const { client } = get();
      if (!client) return;
      const project = await client.createProject({
        prompt,
        target_duration_s: duration,
        aspect,
        mode,
      });
      await get().openProject(project.id);
      await get().refreshHome();
    },

    createTool: async (tool, input) => {
      const { client } = get();
      if (!client) return;
      const project = await client.createTool({ tool, ...input });
      await get().openProject(project.id);
      await get().refreshHome();
    },

    promote: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const project = await client.promote(currentProject.id);
      await get().openProject(project.id);
      await get().refreshHome();
    },

    approve: async (checkpoint) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      if (!currentProject.approvals.includes(checkpoint)) {
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
        const { project } = await client.getProject(projectId);
        if (get().currentProject?.id === projectId) set({ currentProject: project });
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

    editPrompt: async (nodeId, prompt) => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      // Different node kinds read different content params.
      const key = nodeId.endsWith(".narration")
        ? "text"
        : nodeId === "music"
          ? "brief"
          : "prompt";
      await client.patch(currentProject.id, [
        { op: "set_params", node_id: nodeId, params: { [key]: prompt } },
      ]);
      await get().refreshBoard();
    },

    applyTimeline: (params) => applyAuxParams("timeline", params),

    applyExport: (params) => applyAuxParams("export", params),

    finalize: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      flushPatches();
      await client.finalize(currentProject.id);
      await get().refreshBoard();
    },

    select: (nodeId) => set({ selectedNode: nodeId }),

    refreshModels: async () => {
      const { client } = get();
      if (!client) return;
      set({ models: await client.listModels() });
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
      } catch (err) {
        set({
          downloadErrors: {
            ...get().downloadErrors,
            [modelId]: err instanceof Error ? err.message : String(err),
          },
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

    finishFirstRun: () => {
      localStorage.setItem(FIRST_RUN_KEY, "1");
      set({ firstRunDone: true });
    },

    resetFirstRun: () => {
      localStorage.removeItem(FIRST_RUN_KEY);
      set({ firstRunDone: false, settingsOpen: false });
    },

    openSettings: () => set({ settingsOpen: true }),

    closeSettings: () => set({ settingsOpen: false }),
  };
});
