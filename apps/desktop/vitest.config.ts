import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Renderer tests.
 *
 * Merged onto the app's own vite config rather than redeclared, so the
 * build-time `define`s (`__APP_VERSION__`, `__OSS_LICENSES__`) exist here
 * too — a component that reads one would otherwise fail with a bare
 * ReferenceError that says nothing about why.
 *
 * Electron main-process code is deliberately NOT in scope: it imports
 * `electron`, which only resolves inside an Electron runtime. Testing it
 * needs a different runner (electron-mocha or a spawned harness); the seam
 * this suite covers is the renderer, which is where sections 6 and 7 of the
 * defect backlog lived.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/i18n/**"],
      },
    },
  }),
);
