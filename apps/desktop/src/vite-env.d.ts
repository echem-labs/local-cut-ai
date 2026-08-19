/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json. */
declare const __APP_VERSION__: string;

/** package.json `homepage` — the root About's links row is built from. */
declare const __HOMEPAGE__: string;

/** The year this bundle was built, for the copyright line. */
declare const __BUILD_YEAR__: number;

/** Injected by vite.config.ts `define`: everything the renderer bundle
 * redistributes, with the license notice itself and not only an SPDX id.
 *
 * Two shapes, not one. Most entries are npm packages found by walking the
 * dependency graph — transitive ones included, so `scheduler` and
 * `dockview-core` are here without appearing in package.json. The rest are
 * assets committed into this tree (the Inter font, the Kokoro voice samples):
 * they have no package.json to be discovered through, so their `version`
 * carries whatever identifies that asset rather than a semver, and `name` need
 * not resolve to anything on npm. */
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
