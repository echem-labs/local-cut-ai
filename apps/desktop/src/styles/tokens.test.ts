/**
 * Every custom property the stylesheet reads is one the stylesheet defines.
 *
 * A `var(--name)` naming nothing is not a no-op and not a fallback to
 * something sensible: the WHOLE declaration becomes invalid at computed-value
 * time, so the property takes its initial value and the rule silently loses
 * that line. `--space-5` never existed — the scale is 1/2/3/4/6/8 — and three
 * declarations referenced it, which is how the drop notice ended up with
 * `bottom: auto` (pinned to the top of the window rather than the bottom),
 * `max-width: none`, and an overlay card with no padding at all.
 *
 * Nothing catches this otherwise. It is not a parse error, so the build is
 * clean and the browser console says nothing; the rig's own checks passed
 * because `position: fixed` and "the rail did not move" were both still true
 * of a notice sitting in the wrong place.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Read from disk, not imported. Vitest resolves a `.css` specifier by its
   extension before Vite's `?raw` query is considered, so BOTH
   `import.meta.glob("./*.css", {query:"?raw"})` and a plain
   `import css from "./app.css?raw"` hand back an empty string here — and an
   empty string satisfies every assertion below. The triple-slash reference
   pulls @types/node into this file alone; the renderer's tsconfig is
   `vite/client` only on purpose, and this is a test reading its own source
   tree rather than app code reaching for the filesystem.

   Named rather than globbed: two stylesheets, and a third belongs on this
   list deliberately. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const SHEETS = { "app.css": read("./app.css"), "tokens.css": read("./tokens.css") };

/** Custom properties can also be set from TypeScript, on an inline style or
 *  via `setProperty`. Those are real definitions; the stylesheet just cannot
 *  see them. */
const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const matchAll = (text: string, pattern: RegExp): string[] => [
  ...text.matchAll(pattern),
].map((match) => match[1]!);

describe("the token vocabulary", () => {
  it("reads the stylesheets it claims to", () => {
    // A file this test cannot see is a file it cannot hold to anything, and
    // an empty string satisfies every assertion below it.
    for (const [name, text] of Object.entries(SHEETS)) {
      expect(text.length, `${name} loaded empty`).toBeGreaterThan(1000);
    }
  });

  it("defines every custom property the stylesheets read", () => {
    const css = Object.values(SHEETS).join("\n");
    const ts = Object.values(SOURCES).join("\n");

    // `--name:` in a declaration position, in either half of the app.
    const defined = new Set([
      ...matchAll(css, /(--[a-z0-9-]+)\s*:/gi),
      ...matchAll(ts, /["'`](--[a-z0-9-]+)["'`]\s*[,:)]/gi),
      ...matchAll(ts, /(--[a-z0-9-]+)\s*:/gi),
    ]);

    // A `var()` may carry its own fallback — `var(--x, 12px)` degrades on
    // purpose and is not what this is looking for.
    const read = matchAll(css, /var\(\s*(--[a-z0-9-]+)\s*\)/gi);

    const undefinedTokens = [...new Set(read.filter((name) => !defined.has(name)))].sort();
    expect(undefinedTokens).toEqual([]);
  });
});
