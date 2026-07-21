/** Renderer-side OS detection for copy that shows example paths. The
 * preload bridge deliberately exposes no system surface, and UA hints are
 * enough here — worst case a placeholder shows the other OS's example. */
export const isWindows = navigator.platform.startsWith("Win");
