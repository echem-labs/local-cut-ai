/** Theme preference: dark is the design target (doc 09), light derives
 * from the same tokens. "system" follows the OS and tracks live changes.
 * The resolved theme is stamped as data-theme on <html>; tokens.css keys
 * every color off it. */

export type ThemePref = "system" | "dark" | "light";

const KEY = "localcut.theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

export function loadThemePref(): ThemePref {
  const stored = localStorage.getItem(KEY);
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
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function resolvedTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(pref: ThemePref): void {
  localStorage.setItem(KEY, pref);
  stamp(resolve(pref));
}

/** Stamp the initial theme and follow OS changes while pref is "system". */
export function initTheme(): void {
  stamp(resolve(loadThemePref()));
  media().addEventListener("change", () => {
    if (loadThemePref() === "system") stamp(resolve("system"));
  });
}
