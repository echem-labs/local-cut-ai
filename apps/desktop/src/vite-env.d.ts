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
  /** The package's own license text. Empty when it published none — the
   * dockview family is the case in point; the UI says so rather than
   * implying the notice is absent by accident. */
  text: string;
}>;
