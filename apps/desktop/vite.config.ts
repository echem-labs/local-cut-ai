import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dependencies, homepage, version } from "./package.json";

const here = dirname(fileURLToPath(import.meta.url));

/** Which filenames in a package directory are a notice we must carry.
 *
 * Anchored on the WHOLE name, not just its start: a bare `^LICEN[CS]E` prefix
 * also matches `licenseCheck.json` (real, on the `boolean` package) and a
 * `LICENSES/` directory, and rendering either under a heading that reads
 * "License text" is worse than rendering nothing. `NOTICE` is in the set
 * because an Apache-2.0 package ships one beside its LICENSE and section 4(d)
 * requires its contents to travel too — this repo's own NOTICE is exactly
 * that file, so the rule is one we are on both sides of.
 *
 * The extension guard is not decoration: the suffix group has to stay open
 * enough for `LICENSE-MIT` and `COPYING.LESSER`, and that same openness makes
 * `license-checker.js` — a script, in a package root — match the name rule
 * exactly. A notice is a document, so anything carrying a code or data
 * extension is refused whatever it is called. */
const CODE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts|json|ya?ml|lock)$/i;
const NOTICE_NAME = /^(LICEN[CS]E|COPYING|NOTICE)([-._][A-Za-z0-9.-]+)?$/i;

export function isNoticeFile(name: string): boolean {
  return NOTICE_NAME.test(name) && !CODE_EXTENSION.test(name);
}

/** The fields of a dependency's package.json this reads. Everything is
 * optional and `license`/`licenses` are `unknown`: these are other people's
 * files, and both the deprecated plural form and an outright missing field
 * are shapes that occur in the wild. */
type PackageMeta = {
  version?: string;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  dependencies?: Record<string, string>;
};

/** One row of Settings → About's attribution list. */
type LicenseEntry = {
  name: string;
  version: string;
  license: string;
  repository: string;
  /** The package's own notice text, or "" when it published none. */
  text: string;
};

/** Attribution list for Settings → About "Open-source licenses": everything
 * that actually ships inside the renderer bundle, read at build time — real
 * versions, SPDX ids and the license texts themselves, never hand-maintained.
 *
 * Three things this has to get right, each of which it got wrong before:
 *
 * - **The whole tree, not the direct deps.** Vite bundles transitively, so
 *   `scheduler` and the `dockview-core` layer ship without appearing in
 *   package.json. Listing only what we typed there under-reports what we
 *   redistribute.
 * - **Texts, not just identifiers.** MIT's one condition is that the notice
 *   "shall be included in all copies"; an SPDX id is not that notice. esbuild
 *   strips every `@license` comment from the bundle (`legalComments: "none"`
 *   is Vite's default) and electron-builder excludes node_modules, so if the
 *   text is not carried here it ships nowhere at all.
 * - **Vendored assets count.** Inter is committed into the tree rather than
 *   installed, and the voice swatch samples are generated audio. Neither has
 *   a package.json to be discovered through, and both are redistributed.
 *
 * Sorted by code unit rather than `localeCompare`, so the list is identical
 * on every machine that builds it. */
function collectLicenses() {
  const asUrl = (repo: unknown): string => {
    const raw = typeof repo === "string" ? repo : ((repo as { url?: string })?.url ?? "");
    return raw.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://");
  };
  const spdx = (meta: { license?: unknown; licenses?: unknown }): string => {
    if (typeof meta.license === "string") return meta.license;
    if (meta.license && typeof (meta.license as { type?: string }).type === "string") {
      return (meta.license as { type: string }).type;
    }
    // Deprecated plural form: `"licenses": [{ "type": "BSD-3-Clause" }, …]`.
    if (Array.isArray(meta.licenses)) {
      const ids = meta.licenses
        .map((l: unknown) => (typeof l === "string" ? l : (l as { type?: string })?.type))
        .filter(Boolean);
      if (ids.length) return ids.join(", ");
    }
    return "See repository";
  };
  // EVERY notice a package published, not the first one in code-unit order.
  // A dual-licensed package ships `LICENSE.MIT.txt` beside
  // `LICENSE.WTFPL.txt`, and carrying one of the two misstates the terms the
  // user actually received; an Apache-2.0 package ships `NOTICE` beside
  // `LICENSE`, and section 4(d) requires the NOTICE contents to travel too.
  // Not every package publishes any — the dockview family ships none — and
  // inventing one would be worse than saying so, which `text: ""` lets the
  // UI do.
  const licenseText = (dir: string): string => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return "";
    }
    return names
      .filter(isNoticeFile)
      .sort()
      // An unreadable candidate (a directory, EACCES) must not shadow a
      // readable sibling, so every match is read and the empties drop out.
      // Ruled off from one another: two notices concatenated with a blank
      // line between them read as one document with a strange middle, and
      // which terms govern which half is the whole reason both are here.
      .map((n) => licenseTextAt(join(dir, n)))
      .filter(Boolean)
      .join(`\n\n${"-".repeat(64)}\n\n`);
  };

  // Resolution goes through Node's own resolver, from the directory of the
  // package that declared the edge — not a flat lookup in the app's own
  // node_modules. npm hoists most of a tree there, but a version conflict
  // nests the loser under its parent and pnpm symlinks the lot; a flat lookup
  // answers "not installed" for both, and that answer is indistinguishable
  // from the degraded path, which ships an entry with a blank version.
  const metaPathOf = (name: string, from: string): string | null => {
    try {
      return createRequire(join(from, "package.json")).resolve(`${name}/package.json`);
    } catch {
      /* an `exports` map may refuse the subpath — fall through to the walk */
    }
    // `exports` with no "./package.json" entry refuses the resolver even when
    // the file is right there, and modern packages routinely do that. Read it
    // off disk instead, by the same walk Node itself would perform: up from
    // whoever required it, `node_modules/<name>` at each level. Not a single
    // flat probe at the app root — that misses a version conflict's nested
    // loser, and missing a package loses its `dependencies` too, so a whole
    // arm of the graph drops out of a compliance surface silently.
    let at = from;
    for (;;) {
      const candidate = join(at, "node_modules", name, "package.json");
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        /* not at this level */
      }
      const up = dirname(at);
      if (up === at || at === here) return null;
      at = up;
    }
  };

  // Breadth-first over `dependencies` only, which is the renderer bundle's
  // graph and NOT the whole of what the installer redistributes. Two things
  // sit outside it and neither is served by widening this walk:
  //
  // - **Electron itself.** A devDependency, so it is not reached from here —
  //   but electron-builder packages the runtime, which makes Chromium very
  //   likely the largest single component in the product. Its notice set is
  //   orders of magnitude bigger than everything this function collects, and
  //   it is inlined into one un-split entry chunk, so it needs its own
  //   channel rather than a line in this queue.
  // - **The engine's Python closure**, which the freeze carries its own
  //   notices file for (engine/packaging/third_party_notices.py).
  //
  // A non-optional peer edge is the one case that arguably belongs and is
  // left out deliberately: npm 7+ auto-installs those and Vite resolves them
  // like any other module, but no peer edge in this tree reaches a package
  // the `dependencies` walk misses, so the code would ship untested.
  //
  // Each queued edge carries the directory it was declared from, so a nested
  // install resolves from its own parent rather than from the app root.
  type Edge = { name: string; from: string };
  const collected = new Map<string, LicenseEntry>();
  const queue: Edge[] = Object.keys(dependencies).map((name) => ({ name, from: here }));
  while (queue.length) {
    const { name, from } = queue.shift() as Edge;
    if (collected.has(name)) continue;
    const metaPath = metaPathOf(name, from);
    let meta: PackageMeta | null = null;
    try {
      if (metaPath) meta = JSON.parse(readFileSync(metaPath, "utf8")) as PackageMeta;
    } catch {
      meta = null;
    }
    if (!metaPath || !meta) {
      // Degraded path (deps not installed here / unreadable): show the declared
      // range without its leading semver operator, not "^5.0.14". A transitive
      // edge has no declared range to fall back on. "unresolved" rather than
      // `spdx()`'s "See repository": that one means an installed package that
      // states no license field, which is a real upstream shape. This is our
      // own resolution giving up, and the two must be tellable apart — one is
      // a build to stop, the other is not.
      const declared = dependencies[name as keyof typeof dependencies]?.replace(/^[\^~>=<\s]+/, "");
      collected.set(name, {
        name,
        version: declared || "unresolved",
        license: "unresolved",
        repository: "",
        text: "",
      });
      continue;
    }
    const dir = dirname(metaPath);
    collected.set(name, {
      name,
      version: meta.version ?? "unresolved",
      license: spdx(meta),
      repository: asUrl(meta.repository),
      text: licenseText(dir),
    });
    for (const dep of Object.keys(meta.dependencies ?? {})) {
      if (!collected.has(dep)) queue.push({ name: dep, from: dir });
    }
  }

  // Redistributed but undiscoverable: no package.json sits above either of
  // these, and both are inside the shipped bundle. `requiredTextAt`, not
  // `licenseTextAt`: these notices are committed in THIS repository, so one
  // going missing is a build bug — and letting it degrade to `text: ""` makes
  // the panel say "this package publishes no license file" about the very
  // notices we are ourselves obliged to carry.
  const voicesDir = join(here, "src", "assets", "voices");
  // Read off the directory, not retyped. These ids already exist as
  // VOICE_SWATCHES in src/lib/tools.ts, as _VOICE_MAP in the engine's
  // kokoro.py, and as these filenames; a further hand-written copy is one no
  // build step reconciles against anything, and it is the copy a user reads.
  const voiceIds = readdirSync(voicesDir)
    .filter((n) => n.endsWith(".wav"))
    .map((n) => n.slice(0, -".wav".length))
    .sort();
  const vendored: LicenseEntry[] = [
    {
      name: "Inter",
      version: "Variable",
      license: "OFL-1.1",
      repository: "https://github.com/rsms/inter",
      text: requiredTextAt(join(here, "src", "assets", "fonts", "LICENSE.txt")),
    },
    {
      name: "Kokoro-82M voice samples",
      // A count, not the ids. `version` renders into a fixed-width flex row
      // beside the name and the badge, and 47 characters of comma-separated
      // ids wrap that one row to double height; the ids belong in the notice,
      // which is the part meant to be read.
      version: `${voiceIds.length} samples`,
      license: "Apache-2.0",
      repository: "https://huggingface.co/hexgrad/Kokoro-82M",
      // The file list, the provenance note, AND the license the note names.
      // The list is composed here rather than written into PROVENANCE.txt so
      // that the directory stays the single copy of it; the license text is
      // carried because the whole point of this panel is that an SPDX id is
      // not a notice, and Apache-2.0 section 4(a) asks for the License itself
      // to travel with the work.
      text: [
        `Samples: ${voiceIds.map((id) => `${id}.wav`).join(", ")}`,
        requiredTextAt(join(voicesDir, "PROVENANCE.txt")),
        requiredTextAt(join(voicesDir, "LICENSE.txt")),
      ].join("\n\n"),
    },
  ];

  return [...collected.values(), ...vendored].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A license/provenance text read from an exact path rather than discovered.
 * "" when there is nothing there to read.
 *
 * Line endings are normalized because the repo has no `.gitattributes`, so a
 * checkout on a runner with `core.autocrlf=true` — the default on GitHub's
 * windows images — hands these files back with CRLF. Left alone that lands
 * verbatim in `__OSS_LICENSES__`, and the Windows installer's notices differ
 * byte-for-byte from the Linux and macOS ones. */
function licenseTextAt(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim();
  } catch {
    return "";
  }
}

/** The same, for a notice THIS repository commits and therefore redistributes
 * itself. Missing is a build failure, not an empty notice: "this package
 * publishes no license file" is a statement about the package, and a dropped
 * or renamed file must not be able to borrow it. */
function requiredTextAt(path: string): string {
  const text = licenseTextAt(path);
  if (!text) throw new Error(`Redistributed asset carries no notice text: ${path}`);
  return text;
}

export default defineConfig({
  plugins: [react()],
  base: "./",
  // Host pinned, not defaulted: the rest of the dev flow is written
  // against 127.0.0.1 (dev:electron's `wait-on`, and the
  // VITE_DEV_SERVER_URL Electron loads). Vite's default binding resolves
  // to ::1 on an IPv6-preferring box, where `wait-on` then polls an IPv4
  // socket nothing listens on — vite prints "ready", and Electron never
  // launches at all.
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist" },
  // Stated rather than defaulted: this copy step is what puts icon.png inside
  // app.asar, and the main process reads it from there for the window icon,
  // the Dock and every toast. Turned off, nothing fails — not the build, not
  // `icon:check`, not the suite — the installed app just has no icon again.
  publicDir: "public",
  // Settings → About reads the app version straight from package.json —
  // injected at build, no IPC round-trip (review 4 §S6).
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __OSS_LICENSES__: JSON.stringify(collectLicenses()),
    // About's links row, from the one field npm already has for this — so
    // moving the repo is a package.json edit, not a hunt through catalog
    // strings for retyped URLs.
    __HOMEPAGE__: JSON.stringify(homepage),
    // The BUILD's year, not the reader's clock: a machine with a wrong
    // date should not be able to restate this app's copyright.
    __BUILD_YEAR__: JSON.stringify(new Date().getFullYear()),
  },
});
