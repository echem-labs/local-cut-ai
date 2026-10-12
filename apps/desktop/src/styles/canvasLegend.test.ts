/**
 * The flowchart's legend never sits on a node, and costs the graph no height.
 *
 * The legend ("Ctrl+wheel zooms · drag empty space to pan", and the chain
 * being shown when a node is selected) was positioned absolutely in the
 * panel's bottom-left corner, over the scrolling surface. Whatever node
 * reached that corner of the view went under it: in a story project at the
 * default zoom, the first column's third node, THUMBNAIL, with the hint
 * printed across its title. A strip of its own under the surface fixed that
 * and took 31 of the 77px a 1440x900 window leaves for the graph.
 *
 * It lives in the toolbar's slack now, and drops out when the slack is too
 * narrow for it. jsdom loads no stylesheet and lays nothing out, so this
 * holds the stylesheet to the shape that makes both true; that it sits in
 * the bar at all is `NodeCanvas.u4.test.tsx`'s to say.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/* Read from disk rather than imported, for the reason `tokens.test.ts` gives:
   vitest hands a `.css?raw` import back as an empty string. The name goes
   through a parameter because Vite rewrites a literal
   `new URL("./x", import.meta.url)` into a served path, which is not a file.
   Comments go, so a declaration quoted in one cannot satisfy a check. */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

const APP = read("./app.css");

/** The declarations of the rule whose whole selector is `selector`. */
const rule = (selector: string): Record<string, string> => {
  const head = new RegExp(`(^|\\n)${selector.replace(/[.:>]/g, "\\$&")} \\{`).exec(APP);
  expect(head, `no "${selector}" rule in app.css`).not.toBeNull();
  const open = head!.index + head![0].length;
  return Object.fromEntries(
    APP.slice(open, APP.indexOf("}", open))
      .split(";")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
};

describe("the flowchart legend", () => {
  it("is never positioned over the graph", () => {
    // Every rule that names the legend, whatever else its selector says.
    const positions = [...APP.matchAll(/[^{}]*\.canvas-legend[^{}]*\{([^}]*)\}/g)]
      .map((match) => /(?:^|;)\s*position:\s*([\w-]+)/.exec(match[1])?.[1])
      .filter((value) => value !== undefined);
    expect(positions.filter((value) => /absolute|fixed|sticky/.test(value!))).toEqual([]);
  });

  it("takes only the bar's slack, so no control in the row moves for it", () => {
    const legend = rule(".canvas-bar > .canvas-legend");
    // Grows from a zero basis and may shrink to nothing: the bar's
    // `> * { flex-shrink: 0 }` would otherwise make the hint's width a
    // demand the counts and the search field pay for.
    expect(legend.flex).toBe("1 1 0");
    expect(legend["min-width"]).toBe("0");
  });

  it("shows a line whole or not at all", () => {
    const legend = rule(".canvas-bar > .canvas-legend");
    // One line tall with the rest clipped, and a line that does not fit
    // beside the zero-width opener wraps out of sight rather than being cut
    // mid-word or pushing the row onto two lines.
    expect(legend["flex-wrap"]).toBe("wrap");
    expect(legend.overflow).toBe("hidden");
    expect(legend.height).toBe(legend["line-height"]);
    expect(rule(".canvas-legend::before").content).toBe('""');
  });
});
