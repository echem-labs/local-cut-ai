import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The deb names every library Electron's binary links that a bare Ubuntu
 * does not already have.
 *
 * `deb.depends` replaces electron-builder's default list rather than adding
 * to it, and that default (FpmTarget's getDefaultDepends) leaves out
 * libgbm.so.1 and libasound.so.2, which Electron's binary links directly. A
 * package without them installs cleanly on a machine that lacks them and
 * then does not start: the dynamic loader refuses localcut-desktop before
 * main.ts runs a line, so the only trace is "error while loading shared
 * libraries" on a stderr nobody sees from a launcher. package.yml installs
 * the deb it builds in a bare container and starts it, but only on a
 * packaging run; this runs with every desktop test.
 *
 * Read off the text, as appImageRuntime.test.ts reads `toolsets`.
 */
// A Windows checkout has CRLF line endings, which the block pattern below
// would otherwise stop at.
const config = readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The entries of `deb.depends`, in order, each as its alternatives:
 * `"a | b"` reads as ["a", "b"]. */
function debDepends(): string[][] {
  const deb = /^deb:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n|[ \t]*\n)*)/m.exec(config)?.[1] ?? "";
  const list =
    /^[ \t]+depends:[ \t]*(?:#.*)?\n((?:[ \t]+(?:-.*|#.*)\n|[ \t]*\n)*)/m.exec(deb)?.[1] ?? "";
  return [...list.matchAll(/^[ \t]+-[ \t]+(.+?)[ \t]*(?:#.*)?$/gm)].map((m) =>
    m[1]
      .replace(/^(["'])(.*)\1$/, "$2")
      .split("|")
      .map((name) => name.trim()),
  );
}

describe("the deb's dependencies", () => {
  it("are read from electron-builder.yml", () => {
    // electron-builder's own defaults start with GTK; a reader that found
    // nothing would pass every check below by vacuous absence.
    expect(debDepends()).toContainEqual(["libgtk-3-0"]);
  });

  it("include libgbm1, which provides libgbm.so.1", () => {
    expect(debDepends()).toContainEqual(["libgbm1"]);
  });

  it("name ALSA by its 24.04 package first and its 22.04 one second", () => {
    // Bare `libasound2` is a name two packages provide on 24.04, and apt
    // installs liboss4-salsa-asound2, which lacks the symbols Electron
    // calls. The renamed package has to come first so apt never gets to
    // choose.
    expect(debDepends()).toContainEqual(["libasound2t64", "libasound2"]);
  });
});
