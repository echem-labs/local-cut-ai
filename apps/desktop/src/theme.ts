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

export function applyTheme(pref: ThemePref): void {
  localStorage.setItem(KEY, pref);
  document.documentElement.dataset.theme = resolve(pref);
}

/** Stamp the initial theme and follow OS changes while pref is "system". */
export function initTheme(): void {
  document.documentElement.dataset.theme = resolve(loadThemePref());
  media().addEventListener("change", () => {
    if (loadThemePref() === "system") {
      document.documentElement.dataset.theme = resolve("system");
    }
  });
}
