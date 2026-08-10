/**
 * Which scene a dragged file is currently over, while it is still in the air.
 *
 * A store rather than props because the two surfaces that have to answer for
 * it — the board card and the inspector panel — sit in different subtrees
 * from the drop surface, which is mounted at app level (the target is the
 * window). Threading a prop from there would mean routing it through every
 * screen and panel between, and every one of those would be a place for the
 * next surface to be forgotten.
 *
 * Deliberately not part of `useApp`: this is transient pointer state that
 * changes on every dragover and is meaningless a frame after the drop. Kept
 * beside `usePlayback` for the same reason that one is separate — a store
 * this hot must not re-render everything subscribed to the app store.
 */
import { create } from "zustand";

interface DropTargetState {
  /** The scene under the pointer, or null when the drag is over nothing in
   *  particular — which is the "make a new scene" case. */
  scene: string | null;
  /** True only while a file drag is actually in the window, so a stale scene
   *  id can never light a card up after the drag has gone. */
  dragging: boolean;
  over: (scene: string | null) => void;
  end: () => void;
}

export const useDropTarget = create<DropTargetState>((set) => ({
  scene: null,
  dragging: false,
  over: (scene) => set({ scene, dragging: true }),
  end: () => set({ scene: null, dragging: false }),
}));

/** Is this scene the one a dragged picture would land on? */
export const useIsDropTarget = (sceneId: string | null | undefined): boolean =>
  useDropTarget((state) => state.dragging && sceneId != null && state.scene === sceneId);
