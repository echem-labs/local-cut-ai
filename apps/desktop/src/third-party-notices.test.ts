/**
 * What the shipped bundle must be able to say about what it redistributes.
 *
 * The renderer bundles its dependencies and esbuild strips every `@license`
 * comment on the way (`legalComments: "none"` is Vite's default), while
 * electron-builder excludes `node_modules` from the package. So the only
 * copy of a dependency's license notice that reaches a user is the one
 * `collectLicenses()` in vite.config.ts carries into `__OSS_LICENSES__`.
 *
 * That makes this a compliance surface rather than a nicety, and it had two
 * holes: it listed direct dependencies only, and it carried SPDX identifiers
 * without the texts those identifiers refer to. MIT's single condition is
 * that its notice "shall be included in all copies", which an identifier is
 * not. These tests run against the real collector output, not a fixture.
 */
/// <reference types="node" />
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { dependencies } from "../package.json";
import { isNoticeFile } from "../vite.config";

// The build-time constant, injected by vite.config.ts (vitest applies the
// same `define`, so this is the exact array the app ships with).
const entries = __OSS_LICENSES__;

/** The two entries vite.config.ts adds by hand, because no dependency walk can
 * reach a font and five wav files committed into the tree. Named here so the
 * discovery assertion can subtract them: they are in the array whether the
 * walk found anything or not. */
const VENDORED = new Set(["Inter", "Kokoro-82M voice samples"]);

describe("which filenames count as a notice", () => {
  // The collector's discovery rule, tested directly: this tree happens to
  // hold nothing but plain `LICENSE` files, so nothing else in this file can
  // tell a working rule from one that matches too much or too little.
  it.each([
    "LICENSE",
    "LICENCE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-MIT",
    "LICENSE.MIT.txt",
    "COPYING",
    "COPYING.LESSER",
    "NOTICE",
    "notice.txt",
  ])("carries %s", (name) => {
    expect(isNoticeFile(name)).toBe(true);
  });

  it.each([
    // Someone else's tooling, not a notice — and the shape a `^LICENSE`
    // prefix match would wrongly pick up.
    "licenseCheck.json",
    "license-checker.js",
    "LICENSES",
    "package.json",
    "README.md",
    // Matches the NAME rule exactly — `LICENSE` plus a `-` plus more — and is
    // a script. Only the extension guard tells the two apart.
    "license-checker.js",
    "licenses.json",
    "LICENSE.ts",
  ])("does not carry %s", (name) => {
    expect(isNoticeFile(name)).toBe(false);
  });
});

describe("third-party notices", () => {
  it("reaches past the direct dependencies into what Vite actually bundles", () => {
    const names = entries.map((e) => e.name);
    // scheduler arrives through react-dom, the dockview-core layer through
    // dockview-react — none of the three is named in package.json, and all
    // three ship in the bundle.
    expect(names).toContain("scheduler");
    expect(names).toContain("dockview-core");
    // What the array is LONGER than says nothing here: the two vendored entries
    // are concatenated unconditionally, so the length clears the direct-
    // dependency count on its own and this passes with the graph walk deleted.
    // Subtract both ends instead and require what is left over.
    const direct = new Set(Object.keys(dependencies));
    const discovered = names.filter((n) => !direct.has(n) && !VENDORED.has(n));
    expect(discovered, "the walk found nothing past package.json").not.toHaveLength(0);
  });

  it("carries the license text for every package that publishes one", () => {
    // Named rather than counted: a regression that drops texts wholesale
    // should fail here with the package that lost its notice.
    for (const name of ["react", "react-dom", "scheduler", "zustand", "lucide-react"]) {
      const entry = entries.find((e) => e.name === name);
      expect(entry, `${name} missing from the attribution list`).toBeDefined();
      expect(entry?.text.length, `${name} ships no license text`).toBeGreaterThan(200);
    }
  });

  it("includes the redistributed assets that have no package.json to be found through", () => {
    const inter = entries.find((e) => e.name === "Inter");
    expect(inter?.license).toBe("OFL-1.1");
    // OFL-1.1 wants the copyright notice and license to travel with the font.
    expect(inter?.text).toContain("SIL OPEN FONT LICENSE");
    expect(inter?.text).toContain("Copyright");

    const voices = entries.find((e) => e.name.startsWith("Kokoro"));
    expect(voices?.license).toBe("Apache-2.0");
    expect(voices?.text).toContain("Kokoro-82M");
    expect(voices?.text).toContain("Apache License");
    expect(voices?.text).toContain("Version 2.0, January 2004");
    expect(voices?.text.length ?? 0).toBeGreaterThan(200);
  });

  it("names exactly the voice samples that are on disk", () => {
    // The swatch set grows by committing another .wav. Nothing reconciles a
    // hand-kept list of ids against the directory, so the entry is read off
    // the directory — and this reads the directory a second time rather than
    // re-deriving from the entry, which would agree with itself either way.
    // Through a const, not written inline: Vite rewrites a `new URL(<string
    // literal>, import.meta.url)` into an asset reference — the very
    // transform Home.tsx relies on to bundle these wavs — and the result is
    // no longer a file: URL for fileURLToPath to take.
    const rel = "./assets/voices";
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    const onDisk = readdirSync(dir)
      .filter((n) => n.endsWith(".wav"))
      .map((n) => n.slice(0, -".wav".length))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    const voices = entries.find((e) => e.name.startsWith("Kokoro"));
    expect(voices?.version).toBe(`${onDisk.length} samples`);
    // The count is in `version`, so the ids have to be somewhere a reader can
    // actually see them, and the notice is that place.
    for (const id of onDisk) expect(voices?.text).toContain(`${id}.wav`);
  });

  it("states a license and an identity for every entry", () => {
    for (const entry of entries) {
      expect(entry.name, "an entry has no name").toBeTruthy();
      expect(entry.version, `${entry.name} has no version`).toBeTruthy();
      expect(entry.license, `${entry.name} has no license`).toBeTruthy();
      // "unresolved" is the collector giving up: the package was not found in
      // any node_modules on the way up, so neither its version nor its license
      // was ever read. Honest in a checkout without node_modules and never what
      // ships. Kept distinct from `spdx()`'s "See repository", which means a
      // package that resolved fine and states no license field of its own — a
      // real upstream shape, and one whose failure message must not send the
      // next reader hunting a resolution bug that is not there.
      expect(entry.version, `${entry.name} did not resolve - no version was read`).not.toBe("unresolved");
      expect(entry.license, `${entry.name} did not resolve - no license was read`).not.toBe("unresolved");
      expect(entry.license, `${entry.name} declares no license field of its own`).not.toBe(
        "See repository",
      );
    }
  });

  it("is ordered by code unit, so every machine builds the same list", () => {
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });
});
