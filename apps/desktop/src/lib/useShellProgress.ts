/**
 * Push the render's progress out to the taskbar and the window title.
 *
 * Both are for the window nobody is looking at, which is also why this is a
 * push rather than something the shell polls: the moment worth reporting is
 * the one where the user has already switched away.
 *
 * Quantised to whole percent before anything crosses the bridge.
 * `job.progress` ticks several times a second during a render, and neither a
 * taskbar bar nor a title can show finer than that — so without this the app
 * would make a few hundred IPC calls per render to redraw the same pixels.
 */
import { useEffect, useRef } from "react";

import { t } from "../i18n";
import { shellProgress } from "./shellProgress";
import { useApp } from "../store";

export function useShellProgress(): void {
  const { board, jobs, currentProject } = useApp();
  // What was last sent, so an unchanged bar is not re-sent. Empty means the
  // shell is currently showing no bar.
  const sent = useRef<string>("");

  useEffect(() => {
    const push = window.localcut?.setShellProgress;
    if (!push) return;

    const progress = shellProgress(board, jobs);
    const title = progress
      ? t("titlebar.windowRendering", {
          done: progress.done,
          total: progress.total,
          project: currentProject?.title ?? t("titlebar.appName"),
        })
      : "";
    const key = progress ? `${Math.round(progress.fraction * 100)}|${title}` : "";
    if (key === sent.current) return;
    sent.current = key;

    // Below zero is how the bar is removed; an empty title restores the
    // app's own. Sent even when idle, because the LAST thing this reports is
    // what the taskbar keeps showing.
    void push({ fraction: progress ? progress.fraction : -1, title });
  }, [board, jobs, currentProject]);
}
