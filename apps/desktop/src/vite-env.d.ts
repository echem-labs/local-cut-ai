/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json. */
declare const __APP_VERSION__: string;

/** Injected by vite.config.ts `define`: runtime dependencies that ship in the
 * bundle, with real versions/licenses read from each installed package. */
declare const __OSS_LICENSES__: ReadonlyArray<{
  name: string;
  version: string;
  license: string;
  repository: string;
}>;
