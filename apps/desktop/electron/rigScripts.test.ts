import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
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
      error = details.stderr?.toString() ?? String(thrown);
    }
    expect(error).toBe("");
  });
});
