import { create } from "zustand";

/** Shared playback state — the Monitor owns the <video>; the transport,
 * cards and shortcuts drive it through this store. `sequence` means the
 * assembled-draft preview: play the cut scene-by-scene (hard cuts, honest
 * about being a draft), advancing at each clip's end. */
interface PlaybackState {
  playing: boolean;
  /** Scene currently loaded in the monitor (null = nothing). */
  sceneId: string | null;
  /** Assembled-draft mode: advance to the next scene when one ends. */
  sequence: boolean;
  /** Seconds into the whole cut / total cut length — transport readout. */
  elapsed: number;
  total: number;
  /** Seconds into the current scene to jump to; the Monitor consumes it
   * when seekNonce changes (works while paused — the frame updates). */
  seekOffset: number;
  seekNonce: number;
  play(sceneId: string, sequence?: boolean): void;
  pause(): void;
  stop(): void;
  tick(elapsed: number, total: number): void;
  seek(sceneId: string, offset: number): void;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  playing: false,
  sceneId: null,
  sequence: false,
  elapsed: 0,
  total: 0,
  seekOffset: 0,
  seekNonce: 0,
  play: (sceneId, sequence = false) => set({ playing: true, sceneId, sequence }),
  pause: () => set({ playing: false }),
  stop: () => set({ playing: false, sceneId: null, sequence: false, elapsed: 0 }),
  tick: (elapsed, total) => set({ elapsed, total }),
  seek: (sceneId, offset) =>
    set({ sceneId, seekOffset: Math.max(0, offset), seekNonce: get().seekNonce + 1 }),
}));

/** mm:ss.d readout, tabular by the mono font. */
export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${String(m).padStart(2, "0")}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
