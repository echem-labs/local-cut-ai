import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The rig's scripts parse.
 *
 * They are plain `.mjs`/`.cjs` outside every tsconfig, so nothing typechecks
 * them and no test imports them — the first thing that finds a syntax error
 * is a rig run, and a rig run finds it EXPENSIVELY. Electron's default
 * handler for an uncaught main-process throw is a modal error box, which on
 * a headless run is not a failure but a ten-minute hang with empty stdout.
 *
 * The specific error is always the same one. `render-mock.cjs` keeps its CSS
 * in template literals, so a backtick inside a CSS comment closes the string
 * and turns the block into a tagged-template call. It has cost three runs.
 *
 * `node --check` rather than a hand-rolled parse: it is the same parser that
 * will load these, it knows `.mjs` is a module and `.cjs` is not, and it
 * runs nothing — which matters, since importing them opens windows and
 * spawns Electron.
 */
const RIG = path.resolve(__dirname, "..", "scripts", "rig");

const scripts = readdirSync(RIG).filter((file) => file.endsWith(".mjs") || file.endsWith(".cjs"));

describe("the rig's scripts", () => {
  it("has scripts to check", () => {
    // A glob that finds nothing passes every assertion under it.
    expect(scripts.length).toBeGreaterThanOrEqual(10);
  });

  it.each(scripts)("%s parses", (file) => {
    let error = "";
    try {
      execFileSync(process.execPath, ["--check", path.join(RIG, file)], { stdio: "pipe" });
    } catch (thrown) {
      const details = thrown as { stderr?: Buffer };
      // `||`, not `??`: a child killed by a signal throws with an EMPTY
      // stderr Buffer, and "" is not nullish - so `??` kept it and the case
      // reported green for a script that was never checked.
      error = details.stderr?.toString() || String(thrown);
    }
    expect(error).toBe("");
  });

  /**
   * ...and the CSS blocks hold no backtick, which parsing cannot tell you.
   *
   * This is the failure `--check` is blind to, and the one that actually
   * happens. A backtick inside a SNAP block closes the template literal and
   * what follows becomes a TAGGED template — `SNAP_HOME` applied to the
   * rest of the CSS. That is valid JavaScript, so the file parses; it
   * throws at load instead, which under Electron is the modal error box and
   * the ten-minute hang. It has cost four runs now, the last one behind a
   * comment reading "NOT `.rail .item`".
   *
   * Read out of the source rather than out of the module: requiring it
   * needs Electron, and the whole point is to catch this without one.
   */
  const BLOCK = /const (SNAP_[A-Z0-9_]+) = `([\s\S]*?)`;/g;
  // Every `const SNAP_… = ` in the file, however it is named, so the count
  // below compares against the truth rather than against a floor. `SNAP_U5`
  // is why: `[A-Z_]+` cannot match a digit, so the block was silently
  // unchecked and 5 of 6 still cleared a `>= 4` floor.
  const DECLARED = /const (SNAP_\w+) = /g;

  it("keeps the render's CSS blocks free of backticks", () => {
    const source = readFileSync(path.join(RIG, "render-mock.cjs"), "utf8");
    const blocks = [...source.matchAll(BLOCK)];
    // A regex that matches nothing passes every assertion under it - and one
    // that matches all but one passes just as quietly.
    const declared = [...source.matchAll(DECLARED)].map(([, name]) => name);
    expect(blocks.map(([, name]) => name)).toEqual(declared);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const offenders = blocks
      .filter(([, , body]) => body.includes("`"))
      .map(([, name]) => name);
    expect(offenders).toEqual([]);
  });
});
