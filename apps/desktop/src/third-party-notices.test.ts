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
import { describe, expect, it } from "vitest";

// The build-time constant, injected by vite.config.ts (vitest applies the
// same `define`, so this is the exact array the app ships with).
const entries = __OSS_LICENSES__;

describe("third-party notices", () => {
  it("reaches past the direct dependencies into what Vite actually bundles", () => {
    const names = entries.map((e) => e.name);
    // scheduler arrives through react-dom, the dockview-core layer through
    // dockview-react — none of the three is named in package.json, and all
    // three ship in the bundle.
    expect(names).toContain("scheduler");
    expect(names).toContain("dockview-core");
    expect(names.length).toBeGreaterThan(Object.keys({ dockviewReact: 1, lucide: 1, react: 1, reactDom: 1, zustand: 1 }).length);
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
    expect(voices?.text).toContain("Kokoro-82M");
    expect(voices?.text.length ?? 0).toBeGreaterThan(200);
  });

  it("states a license and an identity for every entry", () => {
    for (const entry of entries) {
      expect(entry.name, "an entry has no name").toBeTruthy();
      expect(entry.version, `${entry.name} has no version`).toBeTruthy();
      expect(entry.license, `${entry.name} has no license`).toBeTruthy();
      // "See repository" is the collector's degraded path. It is honest in a
      // checkout without node_modules, but it must never be what ships.
      expect(entry.license, `${entry.name} fell back to the degraded path`).not.toBe("See repository");
    }
  });

  it("is ordered by code unit, so every machine builds the same list", () => {
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });
});
