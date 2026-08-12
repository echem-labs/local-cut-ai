/**
 * Every rule that overrides a preference because the window is narrow, in
 * one place — so U8's sweep can assert them all rather than the one it
 * happens to know.
 *
 * U0 found two failure modes, and this file guards the first: *a viewport
 * rule that overrides a stored preference must disable the control that
 * writes it*, not leave a click that silently discards the choice. The rail
 * was where it was found, and the rail is the only such rule today — but a
 * second one added quietly would be checked nowhere, because `sweep.mjs`
 * asks about the rail by name. There is no way for a rig script to discover
 * a rule that has just been written; there is a way for a test to refuse it.
 *
 * So the allowlist below is the interface between the two: adding a viewport
 * rule fails this test until it is written down, and the entry says which
 * control the sweep must find disabled while the rule applies.
 *
 * The second half is the same argument for CSS. `RAIL_NARROW` carries the
 * note "nothing in CSS keys off this width", and that is worth holding: a
 * breakpoint in the stylesheet moves layout with nothing in the DOM to say
 * it did, so the sweep would measure the result without knowing a rule had
 * fired. Media queries about the *user* — reduced motion, colour scheme —
 * are not viewport rules and are not the subject here.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCES: Record<string, string> = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/* Read from disk, for the reason `styles/tokens.test.ts` records at length:
   vitest resolves a `.css` specifier by its extension before Vite's `?raw`
   query is considered, so a globbed stylesheet arrives as an empty string —
   and an empty string passes the check below without reading a byte. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const STYLES: Record<string, string> = {
  "styles/app.css": read("../styles/app.css"),
  "styles/tokens.css": read("../styles/tokens.css"),
};

/**
 * The viewport rules the app is allowed to have.
 *
 * `control` names what the sweep must find disabled while the rule applies;
 * `asserts` is the check in `scripts/rig/sweep.mjs` that does it. A rule
 * whose override has no control to disable (a purely visual reflow) says so
 * in `control` — the point is that somebody decided, not that the answer is
 * always a disabled button.
 */
const ALLOWED: Record<string, { query: string; control: string; asserts: string }> = {
  "App.tsx": {
    query: "RAIL_NARROW",
    control: "the rail's last button — its expand/collapse toggle",
    asserts: '"the rail toggle is disabled rather than dead"',
  },
};

/** Where `useMediaQuery(...)` is called, and with what. */
const consumers = (): { file: string; query: string }[] => {
  const found: { file: string; query: string }[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    // Vite keys this file's own directory as `./name`, everything else as
    // `../dir/name` — normalize both to the repo-relative form the
    // allowlist reads in.
    const file = path.replace(/^\.\.\//, "").replace(/^\.\//, "lib/");
    if (file.includes(".test.")) continue;
    // The hook's own declaration is not a call site.
    if (/export function useMediaQuery/.test(source)) continue;
    for (const match of source.matchAll(/useMediaQuery\(\s*([^)]+?)\s*\)/g)) {
      found.push({ file, query: match[1].trim() });
    }
  }
  return found;
};

describe("viewport rules", () => {
  it("are all written down, so the sweep can assert every one of them", () => {
    const seen = consumers().map(({ file, query }) => `${file}: ${query}`);
    const want = Object.entries(ALLOWED).map(([file, rule]) => `${file}: ${rule.query}`);
    expect(seen.sort()).toEqual(want.sort());
  });

  it("name the control the rule overrides, and where the sweep checks it", () => {
    for (const [file, rule] of Object.entries(ALLOWED)) {
      expect(rule.control.length, `${file} names no control`).toBeGreaterThan(0);
      expect(rule.asserts.length, `${file} names no assertion`).toBeGreaterThan(0);
    }
  });

  it("live in the components, not in the stylesheet", () => {
    const offenders: string[] = [];
    for (const [path, css] of Object.entries(STYLES)) {
      expect(css.length, `${path} read as empty`).toBeGreaterThan(0);
      for (const match of css.matchAll(/@media[^{]+/g)) {
        // `prefers-*` describes the person, not the window. Anything that
        // measures the viewport — width, min-width, aspect-ratio — moves
        // layout with nothing in the DOM to say a rule fired.
        if (/\b(min-|max-)?(width|aspect-ratio)\b/.test(match[0])) {
          offenders.push(`${path}: ${match[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
