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
  return Object.keys(dependencies)
    .map((name) => {
      try {
        const meta = JSON.parse(readFileSync(join(here, "node_modules", name, "package.json"), "utf8"));
        const license =
          typeof meta.license === "string" ? meta.license : (meta.license?.type ?? "See repository");
        return { name, version: meta.version as string, license, repository: asUrl(meta.repository) };
      } catch {
        return { name, version: dependencies[name as keyof typeof dependencies], license: "See repository", repository: "" };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist" },
  // Settings → About reads the app version straight from package.json —
  // injected at build, no IPC round-trip (review 4 §S6).
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __OSS_LICENSES__: JSON.stringify(collectLicenses()),
  },
});
