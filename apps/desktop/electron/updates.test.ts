/**
 * Which release feed the update check reads.
 *
 * Settled once at startup from three facts: whether this is an installed
 * build, what LOCALCUT_UPDATE_FEED says if it is set, and the homepage in
 * package.json. Each rule is a promise to somebody. An installed copy hears
 * about a newer release without anyone configuring it, a contributor's dev
 * run never calls GitHub by itself, and whoever sets the variable gets the
 * feed they named or none at all.
 *
 * What the feed's answers mean is tested through the IPC handler in
 * main.test.ts, against a real HTTP server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { latestReleaseFeed, readHomepage, resolveUpdateFeed } from "./updates";

const HOMEPAGE = "https://github.com/echem-labs/local-cut-ai";
const LATEST = "https://api.github.com/repos/echem-labs/local-cut-ai/releases/latest";
/** What `app.getAppPath()` is in a dev run: the directory `electron .` ran in. */
const APP_DIR = path.join(__dirname, "..");

describe("the feed a homepage names", () => {
  it("is GitHub's latest-release endpoint for that repository", () => {
    expect(latestReleaseFeed(HOMEPAGE)).toBe(LATEST);
  });

  it.each([
    `${HOMEPAGE}/`,
    `${HOMEPAGE}.git`,
    `${HOMEPAGE}#readme`,
    `${HOMEPAGE}/tree/main/apps/desktop`,
  ])("is the same repository's for %s", (homepage) => {
    expect(latestReleaseFeed(homepage)).toBe(LATEST);
  });

  it.each([
    ["a site that is not GitHub", "https://localcut.example/"],
    ["an account rather than a repository", "https://github.com/echem-labs"],
    ["GitHub over plain http", "http://github.com/echem-labs/local-cut-ai"],
    ["text that is not a URL", "echem-labs/local-cut-ai"],
    ["no homepage at all", undefined],
  ])("is nothing for %s", (_label, homepage) => {
    expect(latestReleaseFeed(homepage)).toBe("");
  });

  it("exists for the homepage this app declares", () => {
    // An installed build's default rests on this one field. A homepage moved
    // to a project website would leave every installed copy with no check
    // and nothing on screen to say why.
    expect(latestReleaseFeed(readHomepage(APP_DIR))).toMatch(
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/,
    );
  });

  it("is read as nothing from a directory without a usable package.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localcut-updates-"));
    try {
      expect(readHomepage(dir)).toBeUndefined();
      fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
      expect(readHomepage(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which feed a build reads", () => {
  it("is GitHub's latest release for an installed build", () => {
    const feed = resolveUpdateFeed({ override: undefined, packaged: true, homepage: HOMEPAGE });
    expect(feed).toBe(LATEST);
  });

  it("is none for a dev run, so a contributor never calls the API without asking", () => {
    const feed = resolveUpdateFeed({ override: undefined, packaged: false, homepage: HOMEPAGE });
    expect(feed).toBe("");
  });

  it.each([
    ["installed", true],
    ["in a dev run", false],
  ])("is the one LOCALCUT_UPDATE_FEED names, %s", (_label, packaged) => {
    expect(
      resolveUpdateFeed({
        override: " http://127.0.0.1:8000/latest.json ",
        packaged,
        homepage: HOMEPAGE,
      }),
    ).toBe("http://127.0.0.1:8000/latest.json");
  });

  // Set but not a web address is somebody saying "no feed". Empty is the
  // obvious spelling, and a word is the one a Windows shell can express:
  // `set NAME=` in cmd removes the variable rather than emptying it.
  it.each(["", "   ", "off", "none", "file:///etc/release.json"])(
    "is none for LOCALCUT_UPDATE_FEED=%j, even installed",
    (override) => {
      expect(resolveUpdateFeed({ override, packaged: true, homepage: HOMEPAGE })).toBe("");
    },
  );
});
