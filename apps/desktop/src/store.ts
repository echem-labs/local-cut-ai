import { create } from "zustand";
import { EngineClient } from "./api/client";
import type { Board, EngineEvent, Job, Project, SystemInfo } from "./api/types";

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

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

export const useApp = create<AppState>((set, get) => ({
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
    const { connection, error } = await window.localcut.getEngineConnection();
    if (!connection) {
      set({ engineError: error ?? "engine unavailable" });
      return;
    }
    const client = new EngineClient(connection);
    set({ client, engineError: null });

    unsubscribe?.(); // never leak a previous subscription
    unsubscribe = client.subscribe(
      (event: EngineEvent) => {
        // Debounced board refresh keeps cards live without hammering the API.
        if (event.type.startsWith("job.") || event.type === "project.expanded") {
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            get()
              .refreshBoard()
              .catch((err) => console.warn("board refresh failed:", err));
          }, 150);
        }
      },
      () => set({ engineError: "connection to engine lost — reconnect to resume" }),
    );

    await get().refreshHome();
    try {
      set({ system: await client.system() });
    } catch {
      /* system info is cosmetic at this stage */
    }
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

  closeProject: () => set({ currentProject: null, board: null, selectedNode: null }),

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
}));
