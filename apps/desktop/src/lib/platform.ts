/** Renderer-side OS detection for copy that shows example paths. The
 * preload bridge deliberately exposes no system surface, and UA hints are
 * enough here — worst case a placeholder shows the other OS's example. */
export const isWindows = navigator.platform.startsWith("Win");
export const isMac = navigator.platform.startsWith("Mac");

/** Catalog strings write shortcut chords as "Ctrl"; every handler already
 * accepts ctrlKey OR metaKey, so on macOS the displayed label is the only
 * thing left to localize — swap the word for ⌘ at render time. */
export const shortcutLabel = (label: string): string =>
  isMac ? label.replace(/\bCtrl\b/g, "⌘") : label;
