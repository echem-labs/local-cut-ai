import type { Job } from "../api/types";

/**
 * The trailing job of a set, by stamp.
 *
 * Deliberately not `jobs[0]` or `jobs.at(-1)`: `/jobs` arrives newest-first,
 * but store merges reorder it, so indexing either end can grab the oldest job.
 * That is how a long-since-recovered project stayed pinned at "failed" on
 * Home — and the same read decides which render the tool session credits for
 * its model and duration, where an off-by-one silently attributes the
 * previous take.
 */
export function newestJob(jobs: Job[]): Job | null {
  return jobs.reduce<Job | null>(
    (best, job) => (best && best.created_at >= job.created_at ? best : job),
    null,
  );
}
