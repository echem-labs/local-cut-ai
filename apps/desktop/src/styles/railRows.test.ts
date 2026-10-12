/**
 * An open-project tab is as wide as the destination rows above it, in both
 * rail widths, whether or not its list is drawing a scrollbar.
 *
 * The tabs live in their own scroller, pulled out through the rail's padding
 * so its bar sits against the rail's edge. A row that is not given a width
 * stretches to whatever the scroller has left, and that depends on the bar:
 * 0 while the list fits (`overflow-y: auto`), 6px once it overflows at 100%,
 * and less at scales where 6 CSS pixels are not a whole number of device
 * pixels, because Chromium rounds the bar down. Padding sized to give back
 * "the bar's width" was right in one of those states at a time; with a
 * handful of tabs every row was 5px too wide in both rail widths.
 *
 * jsdom loads no stylesheet, so this does the rail's arithmetic from the
 * stylesheet's own text: the destination width from `.rail`, the scroller
 * from `.rail-tabs`, and the row from `.rail-tab` if it is sized, or from the
 * scroller's content box if it is not. `npm run rig:walk` measures the same
 * thing in the running app.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Read from disk rather than imported, for the reason `tokens.test.ts` gives:
   vitest hands a `.css?raw` import back as an empty string. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

const APP = read("./app.css");
const TOKENS = read("./tokens.css");

type Decls = Record<string, string>;

const declarations = (body: string): Decls =>
  Object.fromEntries(
    body
      .split(";")
      .map((line) => line.trim())
      .filter((line) => line.includes(":"))
      .map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );

/** The declarations of the rule whose whole selector is `selector`, or an
 *  empty set when there is no such rule. */
const rule = (selector: string): Decls => {
  const head = new RegExp(`(^|\\n)${selector.replace(/[.:]/g, "\\$&")} \\{`).exec(APP);
  if (!head) return {};
  const open = head.index + head[0].length;
  return declarations(APP.slice(open, APP.indexOf("}", open)));
};

/** Every custom property tokens.css defines on `:root`, as written. */
const tokens: Decls = Object.fromEntries(
  [...TOKENS.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
);

/** A length in px: custom properties substituted, `calc()` evaluated. Only
 *  arithmetic on plain numbers survives to the evaluation. */
const px = (value: string, scope: Decls): number => {
  let expr = value;
  for (let depth = 0; expr.includes("var(") && depth < 8; depth += 1) {
    expr = expr.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      if (!(name in scope)) throw new Error(`${name} is not defined for the rail`);
      return `(${scope[name]})`;
    });
  }
  expr = expr.replace(/calc\(/g, "(").replace(/(\d)px\b/g, "$1");
  if (!/^[\d.\s+\-*/()]+$/.test(expr)) throw new Error(`cannot evaluate ${value} as ${expr}`);
  return Number(new Function(`return (${expr});`)());
};

/** The right and left values of a `padding` shorthand. */
const sides = (shorthand: string): { right: string; left: string } => {
  const parts = shorthand.split(/\s+(?![^(]*\))/);
  const right = parts[1] ?? parts[0];
  return { right, left: parts[3] ?? right };
};

/** What the scroller's bar can measure: absent, or 6 CSS px rounded down to
 *  whole device pixels at each scale Windows offers up to 200%. */
const barWidths = (): number[] => {
  const asked = px(rule(".rail-tabs::-webkit-scrollbar").width ?? "0", tokens);
  expect(asked, "the tab list's scrollbar rule is gone").toBeGreaterThan(0);
  return [0, ...[1, 1.25, 1.5, 1.75, 2].map((scale) => Math.floor(asked * scale) / scale)];
};

const measure = (compact: boolean) => {
  const rail = { ...rule(".rail"), ...(compact ? rule(".rail.compact") : {}) };
  const scope = { ...tokens, ...rail };
  const padding = sides(rail.padding);
  const destination =
    px(rail.width, scope) -
    px(rail["border-right"].split(/\s+/)[0], scope) -
    px(padding.left, scope) -
    px(padding.right, scope);

  const list = { ...rule(".rail-tabs"), ...(compact ? rule(".rail.compact .rail-tabs") : {}) };
  const scroller = destination - px(list["margin-right"] ?? "0", scope);
  const listPadding = px(
    list["padding-right"] ?? (list.padding ? sides(list.padding).right : "0"),
    scope,
  );
  const tab = { ...rule(".rail-tab"), ...(compact ? rule(".rail.compact .rail-tab") : {}) };

  return barWidths().map((bar) => {
    const room = scroller - listPadding - bar;
    return { bar, destination, room, row: tab.width ? px(tab.width, scope) : room };
  });
};

describe.each([
  ["expanded", false],
  ["compact", true],
])("the %s rail", (_, compact) => {
  it("draws its tab rows as wide as its destination rows", () => {
    const rows = measure(compact);
    // 175 and 33 are what the design draws; pinned so a parse that read the
    // wrong rule cannot agree with itself about some other number.
    expect(rows[0].destination).toBe(compact ? 33 : 175);
    for (const { bar, destination, row } of rows) {
      expect(row, `with a ${bar.toFixed(2)}px scrollbar`).toBeCloseTo(destination, 5);
    }
  });

  it("leaves the scrollbar room beside every row", () => {
    for (const { bar, row, room } of measure(compact)) {
      expect(row, `with a ${bar.toFixed(2)}px scrollbar`).toBeLessThanOrEqual(room);
    }
  });
});
