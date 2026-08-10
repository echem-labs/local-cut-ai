/**
 * Tell the user when the queue empties, because they walked away.
 *
 * A render is minutes long, which is the entire reason this exists — and
 * also the reason it fires on the QUEUE draining rather than on each
 * `job.done`. A nine-scene video finishing would otherwise raise nine
 * notifications, eight of which say the render is still going.
 *
 * The transition is what is watched, not the state: "busy, then not" happens
 * once per render. Reading "not busy" alone would notify on every store
 * change made while idle, starting with the first one after launch.
 *
 * Whether the notice is actually shown is main's decision — it is the only
 * side that can tell a window in front from a page that still holds focus.
 */
import { useEffect, useRef } from "react";

import { newestJob } from "./jobs";
import { t } from "../i18n";
import { useApp } from "../store";

export function useDoneNotice(): void {
  const { allJobs, projects, notifyOnDone } = useApp();
  const wasBusy = useRef(false);
  /**
   * Ids of the jobs this run of the queue actually contained.
   *
   * `allJobs` is the ENGINE-WIDE list — `/jobs` carries the newest 200 rows
   * across every project, including previous sessions — so asking it "did
   * anything succeed?" answers yes on any machine that has ever finished a
   * render. A failed render would then announce a video was ready and name
   * whichever project owned the newest old success. Accumulated rather than
   * snapshotted once, because the engine enqueues the next node as the
   * previous one leaves `running`.
   */
  const batch = useRef<Set<string>>(new Set());

  useEffect(() => {
    const running = allJobs.filter(
      (job) => job.status === "queued" || job.status === "rendering",
    );
    for (const job of running) batch.current.add(job.id);

    const busy = running.length > 0;
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!finished) return;

    // Cleared whatever happens next, including when the preference is off:
    // a batch left behind would be the pool the NEXT render is judged from.
    const ran = batch.current;
    batch.current = new Set();
    if (!notifyOnDone) return;

    // Nothing in this batch succeeded, so there is nothing to celebrate: a
    // render that failed or was cancelled is reported where the user can act
    // on it, not by an OS notification saying a video is ready.
    const done = allJobs.filter((job) => job.status === "done" && ran.has(job.id));
    if (done.length === 0) return;

    // `newestJob`, not `done.at(-1)`: store merges reorder the list, so
    // indexing either end can name the oldest render in the project.
    const latest = newestJob(done);
    const project = projects.find((entry) => entry.id === latest?.project_id);
    void window.localcut?.notifyDone?.({
      title: t("notify.renderDoneTitle"),
      body: project
        ? t("notify.renderDoneBody", { project: project.title })
        : t("notify.renderDoneBodyUnknown"),
    });
  }, [allJobs, projects, notifyOnDone]);
}
