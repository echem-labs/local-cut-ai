/** Theme preference: dark is the design target (doc 09), light derives
 * from the same tokens. "system" follows the OS and tracks live changes.
 * The resolved theme is stamped as data-theme on <html>; tokens.css keys
 * every color off it. */

export type ThemePref = "system" | "dark" | "light";

const KEY = "localcut.theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

/** Guarded, like every other persisted preference: initTheme() runs at module
 * scope in main.tsx, BEFORE the ErrorBoundary mounts, so a throwing
 * localStorage (blocked storage, a restrictive storage policy, a corrupt
 * origin store) would escape module evaluation and leave a blank window with
 * no error anywhere. Degrade to the default instead. */
export function loadThemePref(): ThemePref {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* storage unavailable — follow the system theme */
  }
  return stored === "light" || stored === "dark" ? stored : "system";
}

function resolve(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return media().matches ? "light" : "dark";
  return pref;
}

/** Anything showing the current theme (the rail toggle) listens for this. */
export const THEME_EVENT = "localcut-themechange";

function stamp(resolved: "dark" | "light"): void {
  document.documentElement.dataset.theme = resolved;
  // Keep the native window-control overlay in step with the CSS theme.
  // Optional: absent outside Electron (e.g. vite serving a plain browser).
  void window.localcut?.setTitleBarTheme?.(resolved);
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function resolvedTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage full/disabled — the theme still applies for this session */
  }
  stamp(resolve(pref));
}

/** Stamp the initial theme and follow OS changes while pref is "system". */
export function initTheme(): void {
  stamp(resolve(loadThemePref()));
  media().addEventListener("change", () => {
    if (loadThemePref() === "system") stamp(resolve("system"));
  });
}
