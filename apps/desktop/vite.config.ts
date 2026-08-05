import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dependencies, version } from "./package.json";

const here = dirname(fileURLToPath(import.meta.url));

/** Attribution list for Settings → About "Open-source licenses": the runtime
 * dependencies that actually ship in the renderer bundle, read from each
 * installed package's own package.json at build time — real versions and
 * SPDX ids, never hand-maintained. */
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
  return Object.keys(dependencies)
    .map((name) => {
      try {
        const meta = JSON.parse(readFileSync(join(here, "node_modules", name, "package.json"), "utf8"));
        return { name, version: meta.version as string, license: spdx(meta), repository: asUrl(meta.repository) };
      } catch {
        // Degraded path (deps not installed here / unreadable): show the declared
        // range without its leading semver operator, not "^5.0.14".
        const declared = dependencies[name as keyof typeof dependencies].replace(/^[\^~>=<\s]+/, "");
        return { name, version: declared, license: "See repository", repository: "" };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
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
  // Settings → About reads the app version straight from package.json —
  // injected at build, no IPC round-trip (review 4 §S6).
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __OSS_LICENSES__: JSON.stringify(collectLicenses()),
  },
});
