import { useEffect, useState } from "react";
import type { Voices } from "../api/types";
import { useApp } from "../store";

/** The narration pack, as the picker needs it — or null while it is unknown.
 *
 * Null and `available: false` are different answers and both are real: null
 * means nobody has asked yet (or the engine could not be reached), false
 * means the engine answered that a pick cannot be honored on this chain. A
 * caller that collapses them shows "no voices installed" during the first
 * frame of every mount.
 *
 * Shared rather than repeated because three surfaces offer this picker, and
 * the answer is per-engine, not per-surface: a fetch in each of them would
 * ask the same question three times and let them disagree about it.
 */
export function useVoices(enabled = true): Voices | null {
  const [voices, setVoices] = useState<Voices | null>(null);
  const client = useApp((state) => state.client);
  // The engine is launched alongside the window, so a client can exist
  // before it answers anything. `engineVersions` is set once health() has
  // come back, and depending on it is what asks again after a first attempt
  // that landed too early — without it the picker is missing for the rest of
  // the session for anyone who opens the voiceover tool quickly.
  const engineUp = useApp((state) => state.engineVersions);
  useEffect(() => {
    if (!enabled || !client) return;
    let stale = false;
    client
      .voices()
      .then((result) => {
        if (!stale) setVoices(result);
      })
      .catch(() => {
        // An engine that cannot be asked is the same as one with no pack for
        // this surface's purposes: the picker falls back to the brief, which
        // is what a narration node with no explicit voice renders with.
        if (!stale) setVoices(null);
      });
    return () => {
      stale = true;
    };
  }, [enabled, client, engineUp]);
  return voices;
}
