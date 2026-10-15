import { useEffect } from "react";

import { useApp } from "../store";

/** How often a screen showing readiness asks the engine for the report
 *  again while the window can be seen. Every report probes the LLM server
 *  and ComfyUI, so this is slow on purpose: the notes it feeds are standing
 *  copy, and half a minute late is fine where ten minutes was not. */
export const READINESS_POLL_MS = 30_000;

/**
 * Keeps the store's readiness report current while the caller is mounted.
 *
 * The report changes with nothing in the app happening: an LLM server
 * started from a terminal, a model pulled with `ollama pull`, ComfyUI
 * launched by hand. None of those is an engine event, and the engine only
 * finds out when it is asked, so the store's own refetches (on connect, on
 * opening a project, on a finished download or program setup) never fire
 * for them. This asks again when the window regains focus (the usual way
 * back from that terminal) and on a slow timer while the window can be
 * seen. One ask at a time, since a slow report means a slow LLM server and
 * stacking probes on it helps nobody.
 *
 * `askOnMount` is for a caller whose arrival nothing else refreshes for.
 * Home is one. A project's banner is not: opening the project asked.
 *
 * Home and a project are never on screen together, so one of them runs
 * this at a time and the engine sees one timer.
 */
export function useReadinessRefresh({ askOnMount }: { askOnMount: boolean }): void {
  useEffect(() => {
    let asking = false;
    const ask = () => {
      if (asking) return;
      asking = true;
      void useApp
        .getState()
        .refreshReadiness()
        .catch((err) => console.warn("readiness refresh failed:", err))
        .finally(() => {
          asking = false;
        });
    };
    const tick = () => {
      if (document.visibilityState === "visible") ask();
    };
    if (askOnMount) ask();
    window.addEventListener("focus", ask);
    const timer = setInterval(tick, READINESS_POLL_MS);
    return () => {
      window.removeEventListener("focus", ask);
      clearInterval(timer);
    };
  }, [askOnMount]);
}
