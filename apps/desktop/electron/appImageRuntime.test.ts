import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The AppImage opens on a desktop without libfuse2.
 *
 * electron-builder's legacy AppImage runtime (toolset 0.0.0, its default)
 * dlopens libfuse.so.2 to mount the image. Ubuntu stopped installing libfuse2
 * in 22.04, so there the AppImage prints why to stderr and exits, and a
 * double-click shows nothing at all. The static runtime, toolset 1.0.2 and
 * later, carries its own FUSE and needs only fusermount3.
 *
 * Read off the text the way appId's reader does, rather than through a YAML
 * parser: a missing `toolsets` block means the legacy runtime, and that is
 * the case this has to see.
 */
// A Windows checkout has CRLF line endings, which the block pattern below
// would otherwise stop at.
const config = readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** `toolsets.appimage`, or null when the config leaves electron-builder's
 * default in place. */
function appImageToolset(): string | null {
  const block = /^toolsets:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n|[ \t]*\n)*)/m.exec(config)?.[1] ?? "";
  const raw = /^[ \t]+appimage:[ \t]+(.+?)[ \t]*(?:#.*)?$/m.exec(block)?.[1];
  return raw ? raw.replace(/^(["'])(.*)\1$/, "$2") : null;
}

describe("the AppImage runtime", () => {
  it("is the static one, which does not load libfuse.so.2", () => {
    const toolset = appImageToolset();
    expect(toolset, "electron-builder.yml leaves the legacy libfuse2 runtime in place").not.toBeNull();
    expect(toolset).not.toBe("0.0.0");
  });
});
