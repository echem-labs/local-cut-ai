/**
 * The update check's two decisions: which release feed to read, and what the
 * feed's answer means. Main-process code; the IPC handler that runs the
 * check is in main.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UpdateCheckResult } from "../src/api/types";

/**
 * Added to the renderer's command line when there is a feed, and the only
 * thing the renderer learns about it. preload.ts spells the literal out
 * again because a sandboxed preload can require no module of ours, so the
 * two copies are held together by main.test.ts, which runs the real preload
 * against the arguments main passes.
 */
export const UPDATE_CHECK_SWITCH = "--localcut-update-check";

/**
 * GitHub's latest-release endpoint for the repository a homepage names, or
 * "" when it names none.
 *
 * The latest endpoint rather than the release list: it skips drafts and
 * prereleases, so it answers with what a download link should point at, and
 * with a 404 until there is one.
 */
export function latestReleaseFeed(homepage: unknown): string {
  if (typeof homepage !== "string") return "";
  let url: URL;
  try {
    url = new URL(homepage);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return "";
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  const name = repo?.replace(/\.git$/, "");
  if (!owner || !name) return "";
  return `https://api.github.com/repos/${owner}/${name}/releases/latest`;
}

/**
 * package.json's `homepage`, read from the app directory.
 *
 * The renderer builds About's links from the same field at compile time
 * (`__HOMEPAGE__`), so the repository is named once. electron-builder keeps
 * `homepage` in the package.json it writes into app.asar. A missing or
 * unreadable file gives undefined, which leaves an installed build without
 * the check rather than without a main process.
 */
export function readHomepage(appDir: string): unknown {
  try {
    const manifest = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    return (manifest as { homepage?: unknown } | null)?.homepage;
  } catch {
    return undefined;
  }
}

/**
 * The feed the update check reads, or "" for none.
 *
 * An installed build reads GitHub's latest release for this repository.
 * Nobody who downloads a release sets an environment variable, so a feed
 * that waited for one would reach no installed copy at all.
 *
 * A dev run reads none, so `npm run dev` never calls GitHub by itself. The
 * API allows 60 unauthenticated requests an hour per address, and a
 * contributor's address is shared with everything else they run.
 *
 * LOCALCUT_UPDATE_FEED overrides both. Set to an http(s) URL, that URL is
 * the feed. Set to anything else, the empty string included, the check is
 * off: the variable being there at all is somebody saying which feed to
 * use, and "none" is an answer. A word such as `off` counts as well as an
 * empty value because cmd cannot set one (`set NAME=` deletes the variable,
 * which would quietly bring the default back).
 *
 * All of this only decides whether About offers the check. It still runs
 * only when someone presses the button.
 */
export function resolveUpdateFeed(options: {
  override: string | undefined;
  packaged: boolean;
  homepage: unknown;
}): string {
  if (options.override === undefined) {
    return options.packaged ? latestReleaseFeed(options.homepage) : "";
  }
  const feed = options.override.trim();
  try {
    const { protocol } = new URL(feed);
    return protocol === "https:" || protocol === "http:" ? feed : "";
  } catch {
    return "";
  }
}

/**
 * What the feed's answer means, read with GitHub's meanings: that is the
 * endpoint an installed build asks, and a feed named in LOCALCUT_UPDATE_FEED
 * is expected to answer like it.
 *
 * Two answers carry a reason instead of only an error string, so About can
 * put them in its own words. A 404 is a repository with nothing published
 * yet, which means nothing newer exists rather than that the check failed.
 * A 403 or 429 is GitHub's rate limit.
 */
export async function readAnswer(
  response: Response,
  now = Date.now(),
): Promise<UpdateCheckResult> {
  if (response.status === 404) {
    return { latest: null, url: null, error: null, reason: "no-release" };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      latest: null,
      url: null,
      error: `HTTP ${response.status}`,
      reason: "rate-limited",
      retryAt: retryAt(response.headers, now),
    };
  }
  if (!response.ok) return { latest: null, url: null, error: `HTTP ${response.status}` };
  const release = readFeed(await response.json());
  if (!release) return { latest: null, url: null, error: "the release feed made no sense" };
  return { latest: release.version, url: release.url, error: null };
}

/**
 * When GitHub says to try again, in epoch seconds, or null if it does not.
 *
 * `retry-after` comes with the secondary limits and counts seconds to wait;
 * GitHub's guidance reads it first. `x-ratelimit-reset` is a timestamp, and
 * it only answers the question once the hourly allowance is spent: under a
 * secondary limit it names the end of an hour that has nothing to do with
 * the refusal.
 */
function retryAt(headers: Headers, now: number): number | null {
  const wait = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(wait) && wait >= 0) return Math.ceil(now / 1000) + wait;
  const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return reset;
  }
  return null;
}

/** Whatever the feed calls it, reduced to the two things About shows. Two
 * shapes are accepted: GitHub's release (`tag_name`, `html_url`), and a
 * plain `{ version, url }`, the least a file served for
 * LOCALCUT_UPDATE_FEED has to say. */
function readFeed(body: unknown): { version: string; url: string } | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const version = typeof row.tag_name === "string" ? row.tag_name : row.version;
  const url = typeof row.html_url === "string" ? row.html_url : row.url;
  if (typeof version !== "string" || !version.trim()) return null;
  return { version: version.trim().replace(/^v/i, ""), url: typeof url === "string" ? url : "" };
}
