import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dependencies, homepage, version } from "./package.json";

const here = dirname(fileURLToPath(import.meta.url));

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
  // A package's own copy of its license, if it published one. Not every
  // package does — the dockview family ships none — and inventing one would
  // be worse than saying so, which `text: ""` lets the UI do.
  const licenseText = (dir: string): string => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return "";
    }
    const file = names
      .filter((n) => /^(LICEN[CS]E|COPYING)/i.test(n))
      .sort()[0];
    if (!file) return "";
    try {
      return readFileSync(join(dir, file), "utf8").trim();
    } catch {
      return "";
    }
  };

  // Breadth-first over `dependencies` only: devDependencies do not ship, and
  // optional/peer edges are not what Vite resolved into the bundle.
  const collected = new Map<string, { name: string; version: string; license: string; repository: string; text: string }>();
  const queue = Object.keys(dependencies);
  while (queue.length) {
    const name = queue.shift() as string;
    if (collected.has(name)) continue;
    const dir = join(here, "node_modules", name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      collected.set(name, {
        name,
        version: meta.version as string,
        license: spdx(meta),
        repository: asUrl(meta.repository),
        text: licenseText(dir),
      });
      for (const dep of Object.keys(meta.dependencies ?? {})) {
        if (!collected.has(dep)) queue.push(dep);
      }
    } catch {
      // Degraded path (deps not installed here / unreadable): show the declared
      // range without its leading semver operator, not "^5.0.14".
      const declared = dependencies[name as keyof typeof dependencies]?.replace(/^[\^~>=<\s]+/, "") ?? "";
      collected.set(name, { name, version: declared, license: "See repository", repository: "", text: "" });
    }
  }

  // Redistributed but undiscoverable: no package.json sits above either of
  // these, and both are inside the shipped bundle.
  const vendored = [
    {
      name: "Inter",
      version: "Variable",
      license: "OFL-1.1",
      repository: "https://github.com/rsms/inter",
      text: licenseTextAt(join(here, "src", "assets", "fonts", "LICENSE.txt")),
    },
    {
      name: "Kokoro-82M voice samples",
      version: "af_bella, af_sarah, am_michael, am_onyx, bf_emma",
      license: "Apache-2.0",
      repository: "https://huggingface.co/hexgrad/Kokoro-82M",
      text: licenseTextAt(join(here, "src", "assets", "voices", "PROVENANCE.txt")),
    },
  ];

  return [...collected.values(), ...vendored].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A license/provenance text read from an exact path rather than discovered. */
function licenseTextAt(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
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
