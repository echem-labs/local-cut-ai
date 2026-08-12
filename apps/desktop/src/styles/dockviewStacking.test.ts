/**
 * Dockview's z-indices must stay inside dockview.
 *
 * The docking library ships its sashes at `z-index: 99` — a sensible number
 * inside a library that owns its own container, and a wrong one loose in this
 * app, whose whole scale tops out at `--z-modal: 100` and puts the Settings
 * overlay at `--z-drawer: 40`. Nothing between the dockview root and `.app`
 * opened a stacking context, so 99 competed directly with 40 and won: a 4px
 * sash belonging to the workspace *behind* Settings was painted over the
 * Settings pane and took the clicks for whatever control it crossed. The U8
 * sweep found it by hit-testing Storage's delete button and landing on
 * `div.dv-sash`.
 *
 * The fix is one declaration — `isolation: isolate` on the themed root, which
 * needs a stacking context rather than a number of its own and moves nothing on
 * screen. This test is here because the fix is invisible: remove it and nothing
 * errors, nothing looks different in a screenshot, and one thin band of
 * Settings quietly stops responding.
 *
 * Written as the general contract rather than as "app.css contains this
 * string", so it re-fires on the other way in as well: a dockview upgrade that
 * raises its own z-index past our scale, with the isolation removed, is the
 * same bug arriving from the other side.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const APP = read("./app.css");
const TOKENS = read("./tokens.css");
const DOCKVIEW = read("../../node_modules/dockview-core/dist/styles/dockview.css");

/** Every numeric z-index in a stylesheet. */
const zIndexes = (css: string): number[] =>
  [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((match) => Number(match[1]));

/** The app's own scale, from the tokens that define it. */
const appScale = (): number[] =>
  [...TOKENS.matchAll(/--z-[\w-]+:\s*(-?\d+)/g)].map((match) => Number(match[1]));

/** The body of the first `.dockview-theme-localcut { … }` rule. */
const themedRoot = (): string => {
  const at = APP.indexOf(".dockview-theme-localcut {");
  expect(at, "the themed dockview root rule is gone").toBeGreaterThan(-1);
  const open = APP.indexOf("{", at);
  const close = APP.indexOf("}", open);
  return APP.slice(open, close);
};

describe("dockview stacking", () => {
  it("has z-indices that would outrank the app's own scale", () => {
    // Not a requirement — a statement of the situation the fix exists for.
    // If dockview ever stops doing this, the assertion below is no longer
    // load-bearing and this file should say so rather than pass quietly.
    const ceiling = Math.max(...appScale());
    const drawer = Number(/--z-drawer:\s*(\d+)/.exec(TOKENS)?.[1]);
    expect(Number.isFinite(drawer), "the drawer token is gone").toBe(true);
    expect(ceiling).toBeGreaterThan(0);
    expect(Math.max(...zIndexes(DOCKVIEW))).toBeGreaterThan(drawer);
  });

  it("is confined to its own stacking context", () => {
    expect(themedRoot()).toMatch(/isolation:\s*isolate/);
  });
});
