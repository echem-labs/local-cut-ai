import { create } from "zustand";

export type WorkspaceView = "storyboard" | "player";
export type Density = "s" | "m" | "l";

const VIEW_KEY = "localcut.workspace.view";
const DENSITY_KEY = "localcut.board.density";

/** Workspace chrome state shared between the project header (switchers)
 * and the dockview panels (consumers). Persisted choices, tiny surface. */
interface WorkspaceState {
  view: WorkspaceView;
  density: Density;
  /** Bumped by "Reset layout" — the workspace rebuilds the active view. */
  resetNonce: number;
  setView(view: WorkspaceView): void;
  setDensity(density: Density): void;
  resetLayout(): void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  view: (localStorage.getItem(VIEW_KEY) as WorkspaceView) === "player" ? "player" : "storyboard",
  density: (["s", "m", "l"].includes(localStorage.getItem(DENSITY_KEY) ?? "") // stored?
    ? localStorage.getItem(DENSITY_KEY)
    : "m") as Density,
  resetNonce: 0,
  setView: (view) => {
    localStorage.setItem(VIEW_KEY, view);
    set({ view });
  },
  setDensity: (density) => {
    localStorage.setItem(DENSITY_KEY, density);
    set({ density });
  },
  resetLayout: () => set((state) => ({ resetNonce: state.resetNonce + 1 })),
}));
