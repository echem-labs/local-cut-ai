#!/usr/bin/env node
/**
 * Refuse to package an engine binary that cannot run on the target OS.
 *
 * electron-builder copies `engine/dist/localcut-engine` verbatim into the
 * installer, and `npm run package` never rebuilt or checked it. PyInstaller
 * does not cross-compile, so freezing on one OS and packaging for another
 * produced an installer whose `localcut-engine.exe` does not exist (or is not
 * executable) on the user's machine — with no installer-time error. The app
 * then opened permanently disconnected, which reads as a broken app rather
 * than a broken build.
 *
 * Checked here, at build time, where it costs nothing and the message can say
 * exactly what to do.
 *
 * Usage: node scripts/check-engine.mjs <win|mac|linux>
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(HERE, "..", "..", "..", "engine", "dist", "localcut-engine");

/** Executable name and magic bytes per target. */
const TARGETS = {
  win: {
    label: "Windows",
    exe: "localcut-engine.exe",
    // "MZ" — the DOS header every PE image starts with.
    looksRight: (b) => b[0] === 0x4d && b[1] === 0x5a,
    describe: "a Windows PE executable",
  },
  linux: {
    label: "Linux",
    exe: "localcut-engine",
    // "\x7fELF"
    looksRight: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
    describe: "an ELF executable",
  },
  mac: {
    label: "macOS",
    exe: "localcut-engine",
    // Mach-O 64-bit (LE/BE) or a universal "fat" binary.
    looksRight: (b) => {
      const magic = b.readUInt32BE(0);
      return [0xcffaedfe, 0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(magic);
    },
    describe: "a Mach-O executable",
  },
};

const target = process.argv[2];
const spec = TARGETS[target];
if (!spec) {
  console.error(`check-engine: unknown target ${target ?? "(none)"} — use win, mac or linux`);
  process.exit(2);
}

const fail = (message) => {
  console.error(`\n  Cannot package for ${spec.label}: ${message}\n`);
  console.error(`  The engine is frozen separately, on the target OS:`);
  console.error(`    cd engine && uv run pyinstaller localcut-engine.spec\n`);
  console.error(`  PyInstaller does not cross-compile — freeze on ${spec.label} itself`);
  console.error(`  (a CI runner for that OS is the usual answer).\n`);
  process.exit(1);
};

if (!existsSync(ENGINE_DIR)) {
  fail(`no frozen engine at ${ENGINE_DIR}`);
}

const binary = path.join(ENGINE_DIR, spec.exe);
if (!existsSync(binary)) {
  fail(`${spec.exe} is missing from ${ENGINE_DIR}`);
}

const size = statSync(binary).size;
if (size < 1024) {
  fail(`${spec.exe} is only ${size} bytes — that is not a frozen engine`);
}

const head = Buffer.alloc(4);
const handle = readFileSync(binary).subarray(0, 4);
head.set(handle);
if (!spec.looksRight(head)) {
  fail(
    `${spec.exe} is not ${spec.describe} ` +
      `(magic ${[...head].map((b) => b.toString(16).padStart(2, "0")).join(" ")}) — ` +
      `it was frozen on a different OS`,
  );
}

console.log(`check-engine: ${spec.exe} is ${spec.describe} (${(size / 2 ** 20).toFixed(1)} MB) — ok`);
