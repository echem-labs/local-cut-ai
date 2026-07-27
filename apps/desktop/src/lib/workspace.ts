import { create } from "zustand";

/** The code-defined views. `flowchart` is doc 01's node canvas: the same
 * graph as the storyboard, shown as the DAG it is.
 *
 * The list is the source of truth and the type is derived from it, not the
 * other way round: a view added to a hand-written union but missed off the
 * runtime array type-checks everywhere and then silently resets the
 * persisted view to "storyboard" on every launch — which is the fallback
 * this array exists to make correct. */
const VIEWS = ["storyboard", "player", "flowchart"] as const;
export type WorkspaceView = (typeof VIEWS)[number];
export type Density = "s" | "m" | "l";

const isView = (value: string | null): value is WorkspaceView =>
  (VIEWS as readonly string[]).includes(value ?? "");

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

/** Guarded reads/writes: this initializer runs at module import — during the
 * import graph, before the ErrorBoundary exists — so a throwing localStorage
 * (blocked storage, a restrictive storage policy) must degrade to the
 * defaults, never blank the whole app. Same discipline as store.ts/zoom.ts. */
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full/disabled — the choice just won't survive a restart */
  }
};

/** Read once, then validate: two calls would take the guarded path twice and
 * could disagree if anything wrote between them. */
const storedView = read(VIEW_KEY);
const storedDensity = read(DENSITY_KEY);

export const useWorkspace = create<WorkspaceState>((set) => ({
  // Validated against the list rather than compared to one value: a stored
  // view this build no longer has must fall back, not persist as a broken
  // layout key nothing renders.
  view: isView(storedView) ? storedView : "storyboard",
  density: (["s", "m", "l"].includes(storedDensity ?? "") ? storedDensity : "m") as Density,
  resetNonce: 0,
  setView: (view) => {
    write(VIEW_KEY, view);
    set({ view });
  },
  setDensity: (density) => {
    write(DENSITY_KEY, density);
    set({ density });
  },
  resetLayout: () => set((state) => ({ resetNonce: state.resetNonce + 1 })),
}));
