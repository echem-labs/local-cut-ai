/**
 * A proposed edit stays readable in a short Prompt panel.
 *
 * `.composer-wrap` holds the plan card a proposed edit draws, with the
 * composer box under it, and keeps them at the bottom of the Prompt panel.
 * Bottom alignment sends whatever does not fit out of the TOP edge, where no
 * scroll position reaches it, unless the alignment is `safe`. A short Prompt
 * panel is ordinary: at 1440x900 with the storyboard dragged taller it is
 * about 140 px, and a plan card alone is about 130. Without `safe`, the
 * card's summary and its list of what re-renders sit behind the panel above
 * and only Apply and Discard show, over the Prompt tab, so an edit can be
 * applied without being read.
 *
 * `safe flex-end` keeps the bottom alignment while everything fits and
 * starts at the top when it does not, and `overflow-y: auto` scrolls to the
 * rest. jsdom loads no stylesheet, so this reads the rule's own text.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* A variable, not a literal: Vite rewrites `new URL("./x", import.meta.url)`
   with a literal path into an asset URL that is not a file. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

const APP = read("./app.css");

/** The declarations of the rule that starts a line with `selector {`. */
function rule(selector: string): Record<string, string> {
  const at = APP.indexOf(`\n${selector} {`);
  expect(at, `${selector} is gone from app.css`).toBeGreaterThan(-1);
  const open = APP.indexOf("{", at);
  const body = APP.slice(open + 1, APP.indexOf("}", open));
  return Object.fromEntries(
    body
      .split(";")
      .map((decl) => decl.split(":").map((part) => part.trim()))
      .filter(([property, value]) => property && value)
      .map(([property, value]) => [property, value]),
  );
}

describe("the composer column", () => {
  it("keeps a proposed edit taller than the panel within scrolling reach", () => {
    const wrap = rule(".composer-wrap");
    const justify = wrap["justify-content"] ?? "normal";
    // Bottom-aligned overflow is unreachable unless the alignment is safe.
    if (/(^|\s)(flex-)?end$/.test(justify)) expect(justify).toMatch(/^safe\s/);
    expect(wrap["overflow-y"] ?? wrap.overflow).toBe("auto");
  });
});
