import { create } from "zustand";
import { EngineClient } from "./api/client";
import type { Board, EngineEvent, Job, NodeState, Project, SystemInfo } from "./api/types";

declare global {
  interface Window {
    localcut: {
      getEngineConnection: () => Promise<{
        connection: { url: string; token: string } | null;
        error: string | null;
      }>;
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

  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  refreshHome: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  createFromPrompt: (prompt: string, duration: number, aspect: string) => Promise<void>;
  refreshBoard: () => Promise<void>;
  regenerate: (nodeId: string) => Promise<void>;
  editPrompt: (nodeId: string, prompt: string) => Promise<void>;
  finalize: () => Promise<void>;
  select: (nodeId: string | null) => void;
}

const REFRESH_DEBOUNCE_MS = 150;
const RECONNECT_DELAY_MS = 3000;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshQueued = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

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
      const { project, board } = await client.getProject(id);
      set({ currentProject: project, board, selectedNode: null });
    },

    closeProject: () =>
      set({ currentProject: null, board: null, jobs: [], selectedNode: null }),

    createFromPrompt: async (prompt, duration, aspect) => {
      const { client } = get();
      if (!client) return;
      const project = await client.createProject({
        prompt,
        target_duration_s: duration,
        aspect,
      });
      await get().openProject(project.id);
      await get().refreshHome();
    },

    refreshBoard: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      const projectId = currentProject.id;
      const [{ board }, jobs] = await Promise.all([
        client.getProject(projectId),
        client.listJobs(projectId),
      ]);
      // A late response for a previously open project must not clobber the
      // one the user has since opened.
      if (get().currentProject?.id !== projectId) return;
      set({ board, jobs });
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

    finalize: async () => {
      const { client, currentProject } = get();
      if (!client || !currentProject) return;
      await client.finalize(currentProject.id);
      await get().refreshBoard();
    },

    select: (nodeId) => set({ selectedNode: nodeId }),
  };
});
