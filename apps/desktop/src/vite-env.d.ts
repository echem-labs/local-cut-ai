/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json. */
declare const __APP_VERSION__: string;

/** package.json `homepage` — the root About's links row is built from. */
declare const __HOMEPAGE__: string;

/** The year this bundle was built, for the copyright line. */
declare const __BUILD_YEAR__: number;

/** Injected by vite.config.ts `define`: runtime dependencies that ship in the
 * bundle, with real versions/licenses read from each installed package. */
declare const __OSS_LICENSES__: ReadonlyArray<{
  name: string;
  version: string;
  license: string;
  repository: string;
}>;
