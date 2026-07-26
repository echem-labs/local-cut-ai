import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two suites, two runtimes.
 *
 * `renderer` is the React app under jsdom. It merges the app's own vite config
 * rather than redeclaring it, so the build-time `define`s (`__APP_VERSION__`,
 * `__OSS_LICENSES__`) exist here too — a component that reads one would
 * otherwise fail with a bare ReferenceError that says nothing about why.
 *
 * `main` is the Electron main process under plain Node. It cannot share the
 * renderer's config: `import { app } from "electron"` resolves, outside an
 * Electron runtime, to a string holding the path of the Electron binary, so
 * every main-process module would be importing undefined. Aliasing the
 * specifier to a hand-written stub is what makes this code reachable at all
 * (see electron/test/electron-stub.ts).
 *
 * Not covered here: `capturePinnedCert`, which needs a real TLS handshake
 * against a server presenting a known self-signed certificate. Generating one
 * needs a certificate library this app does not otherwise depend on, and
 * carrying a fixture certificate means carrying its expiry. Its sibling —
 * engineRequest refusing to send the token over an unpinned channel — is
 * tested, and that is the half that leaks a secret when it breaks.
 */
export default defineConfig({
  test: {
    projects: [
      mergeConfig(
        viteConfig,
        defineConfig({
          test: {
            name: "renderer",
            environment: "jsdom",
            globals: true,
            setupFiles: ["./src/test/setup.ts"],
            include: ["src/**/*.test.{ts,tsx}"],
            restoreMocks: true,
          },
        }),
      ),
      defineConfig({
        resolve: {
          // Anchored: a bare "electron" prefix would also capture unrelated
          // specifiers such as "electron-builder".
          alias: [
            {
              find: /^electron$/,
              replacement: path.join(here, "electron", "test", "electron-stub.ts"),
            },
          ],
        },
        test: {
          name: "main",
          environment: "node",
          globals: true,
          include: ["electron/**/*.test.ts"],
          restoreMocks: true,
        },
      }),
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "electron/**/*.ts"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/i18n/**",
        "electron/**/*.test.ts",
        "electron/test/**",
      ],
    },
  },
});
