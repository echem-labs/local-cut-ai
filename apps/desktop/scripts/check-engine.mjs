#!/usr/bin/env node
/**
 * Refuse to package an engine binary that cannot run on the target OS.
 *
 * electron-builder copies `engine/dist/localcut` verbatim into the
 * installer, and `npm run package` never rebuilt or checked it. PyInstaller
 * does not cross-compile, so freezing on one OS and packaging for another
 * produced an installer whose `localcut.exe` does not exist (or is not
 * executable) on the user's machine — with no installer-time error. The app
 * then opened permanently disconnected, which reads as a broken app rather
 * than a broken build.
 *
 * Checked here, at build time, where it costs nothing and the message can say
 * exactly what to do.
 *
 * Usage: node scripts/check-engine.mjs <win|mac|linux>
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(HERE, "..", "..", "..", "engine", "dist", "localcut");

/** Executable name and magic bytes per target. */
const TARGETS = {
  win: {
    label: "Windows",
    exe: "localcut.exe",
    // "MZ" — the DOS header every PE image starts with.
    looksRight: (b) => b[0] === 0x4d && b[1] === 0x5a,
    describe: "a Windows PE executable",
  },
  linux: {
    label: "Linux",
    exe: "localcut",
    // "\x7fELF"
    looksRight: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
    describe: "an ELF executable",
  },
  mac: {
    label: "macOS",
    exe: "localcut",
    // Mach-O 64-bit (LE/BE) or a universal "fat" binary.
    looksRight: (b) => {
      const magic = b.readUInt32BE(0);
      return [0xcffaedfe, 0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(magic);
    },
    describe: "a Mach-O executable",
    // Mach-O carries its CPU type in the header, and the magic alone does
    // not distinguish arm64 from x86_64. That distinction matters more here
    // than anywhere else: `mac` in electron-builder.yml can emit a dmg per
    // arch, but extraResources copies ONE PyInstaller output, and PyInstaller
    // does not cross-compile — so building both arches from a single freeze
    // silently stamps (say) an arm64 engine into the Intel dmg. It installs
    // and launches, then sits permanently disconnected.
    archOf: (b) => {
      const magic = b.readUInt32BE(0);
      if (magic === 0xcafebabe || magic === 0xbebafeca) return "universal";
      // Thin 64-bit Mach-O. Byte order follows the magic; cputype is the
      // word after it, and the 0x01000000 bit is the 64-bit flag.
      const le = magic === 0xcffaedfe;
      const cpu = (le ? b.readUInt32LE(4) : b.readUInt32BE(4)) & ~0x01000000;
      if (cpu === 7) return "x64"; // CPU_TYPE_X86
      if (cpu === 12) return "arm64"; // CPU_TYPE_ARM
      return `unknown (cputype ${cpu})`;
    },
  },
};

// `mac-arm64` / `mac-x64` — the arch half is required for macOS and ignored
// elsewhere, because macOS is the only target that ships more than one.
const [targetArg, archArg] = (process.argv[2] ?? "").split(/[-:]/);
const target = targetArg;
const spec = TARGETS[target];
if (!spec) {
  console.error(
    `check-engine: unknown target ${process.argv[2] ?? "(none)"} — ` +
      `use win, linux, mac-arm64 or mac-x64`,
  );
  process.exit(2);
}
if (target === "mac" && !["arm64", "x64"].includes(archArg ?? "")) {
  console.error(
    "check-engine: macOS needs an explicit arch — use mac-arm64 or mac-x64.\n" +
      "  A single PyInstaller freeze is one architecture, so the dmg being built\n" +
      "  has to say which one it is.",
  );
  process.exit(2);
}

const fail = (message) => {
  console.error(`\n  Cannot package for ${spec.label}: ${message}\n`);
  console.error(`  The engine is frozen separately, on the target OS:`);
  console.error(`    cd engine && uv run pyinstaller localcut.spec\n`);
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

// 8 bytes: magic plus the Mach-O cputype word behind it. Read through a
// handle rather than readFileSync — the frozen engine is ~16 MB and there is
// no reason to pull all of it into memory to look at the header.
const head = Buffer.alloc(8);
const fd = openSync(binary, "r");
try {
  readSync(fd, head, 0, 8, 0);
} finally {
  closeSync(fd);
}
if (!spec.looksRight(head)) {
  fail(
    `${spec.exe} is not ${spec.describe} ` +
      `(magic ${[...head.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}) — ` +
      `it was frozen on a different OS`,
  );
}

let detail = spec.describe;
if (spec.archOf) {
  const actual = spec.archOf(head);
  if (actual !== archArg && actual !== "universal") {
    fail(
      `${spec.exe} is ${actual}, but this is the ${archArg} package.\n` +
        `  PyInstaller freezes for the machine it runs on, so an ${archArg} dmg\n` +
        `  needs its engine frozen on an ${archArg} Mac. Shipping this one would\n` +
        `  produce an app that installs, launches, and never connects.`,
    );
  }
  detail = `${spec.describe} (${actual})`;
}

console.log(`check-engine: ${spec.exe} is ${detail}, ${(size / 2 ** 20).toFixed(1)} MB — ok`);
