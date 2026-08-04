import { create } from "zustand";
import common from "./en/common.json";
import status from "./en/status.json";
import terms from "./en/terms.json";
import errors from "./en/errors.json";
import nav from "./en/nav.json";
import titlebar from "./en/titlebar.json";
import home from "./en/home.json";
import library from "./en/library.json";
import tools from "./en/tools.json";
import aspects from "./en/aspects.json";
import durations from "./en/durations.json";
import settings from "./en/settings.json";
import firstRun from "./en/firstRun.json";
import models from "./en/models.json";
import project from "./en/project.json";
import pipeline from "./en/pipeline.json";
import scene from "./en/scene.json";
import inspector from "./en/inspector.json";
import timeline from "./en/timeline.json";
import canvas from "./en/canvas.json";
import composer from "./en/composer.json";
import monitor from "./en/monitor.json";
import workspace from "./en/workspace.json";
import help from "./en/help.json";
import queue from "./en/queue.json";
import checkpoint from "./en/checkpoint.json";
import toolSession from "./en/toolSession.json";
import eta from "./en/eta.json";
import palette from "./en/palette.json";
import notices from "./en/notices.json";

/** LocalCut AI internationalization.
 *
 * Every user-facing string lives in a JSON catalog under ./en, split one
 * file per namespace so features stay isolated and translators get small,
 * self-contained units. Nothing user-visible is hardcoded in a component —
 * it reads through t()/plural()/m() so a future locale is a matter of
 * dropping in a parallel catalog, no code changes.
 *
 * Adding a locale: create ./<locale>/*.json mirroring ./en, import it as a
 * bundle below, register it in CATALOGS and SUPPORTED_LOCALES. That is the
 * whole job — the UI already routes through here.
 */

/** The English catalog is the source of truth AND the shape every other
 * locale must satisfy. */
const en = {
  common,
  status,
  terms,
  errors,
  nav,
  titlebar,
  home,
  library,
  tools,
  aspects,
  durations,
  settings,
  firstRun,
  models,
  project,
  pipeline,
  scene,
  inspector,
  timeline,
  composer,
  canvas,
  monitor,
  workspace,
  help,
  queue,
  checkpoint,
  toolSession,
  eta,
  palette,
  notices,
};

export type Catalog = typeof en;
export type Locale = "en";

const CATALOGS: Record<Locale, Catalog> = { en };

/** Languages the shell can switch to — grows as catalogs are added. */
export const SUPPORTED_LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
];

const STORAGE_KEY = "localcut.locale";
const FALLBACK: Locale = "en";

function readInitial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in CATALOGS) return saved as Locale;
  } catch {
    /* storage unavailable — fall back to English */
  }
  return FALLBACK;
}

// The active locale as a module-global so t() works outside React too
// (stores, one-off helpers). useLocale keeps it and this in step.
let currentLocale: Locale = readInitial();

/** Every dot-path to a string leaf in T — arrays and objects are skipped, so
 * only real messages are valid t() keys and typos fail to compile. */
type LeafPaths<T> = T extends string
  ? ""
  : T extends readonly unknown[]
    ? never
    : {
        [K in Extract<keyof T, string>]: LeafPaths<T[K]> extends infer R extends string
          ? R extends ""
            ? K
            : `${K}.${R}`
          : never;
      }[Extract<keyof T, string>];

export type MessageKey = LeafPaths<Catalog>;

type Params = Record<string, string | number>;

function resolve(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

// {name} placeholders are filled from params; an unmatched brace is left as
// written so a missing param is visible rather than silently blank.
function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function lookup(key: string): string {
  const value = resolve(CATALOGS[currentLocale] ?? CATALOGS[FALLBACK], key);
  if (typeof value === "string") return value;
  const fallback = resolve(CATALOGS[FALLBACK], key);
  if (typeof fallback === "string") return fallback;
  if (import.meta.env.DEV) console.warn(`[i18n] missing message: ${key}`);
  return key;
}

/** Translate a message key, interpolating {placeholders} from params. */
export function t(key: MessageKey, params?: Params): string {
  return interpolate(lookup(key), params);
}

/** Plural-aware translate: the catalog holds `${key}_one` / `${key}_other`
 * (and _few / _many where a locale needs them); the count-appropriate form
 * is chosen with Intl.PluralRules and `{count}` is injected automatically. */
export function plural(key: string, count: number, params?: Params): string {
  const category = new Intl.PluralRules(currentLocale).select(count);
  const active = CATALOGS[currentLocale] ?? CATALOGS[FALLBACK];
  const chosen =
    resolve(active, `${key}_${category}`) ??
    resolve(active, `${key}_other`) ??
    resolve(CATALOGS[FALLBACK], `${key}_other`);
  const text = typeof chosen === "string" ? chosen : key;
  if (text === key && import.meta.env.DEV) console.warn(`[i18n] missing plural: ${key}`);
  return interpolate(text, { count, ...params });
}

/** The active catalog, fully typed — for structured entries (arrays of
 * bullets, the glossary, task maps) that aren't single string leaves. */
export function m(): Catalog {
  return CATALOGS[currentLocale] ?? CATALOGS[FALLBACK];
}

/** Reactive locale state. Changing it re-renders the app (main.tsx remounts
 * on the locale key), so every t()/m() call re-reads the new catalog. */
interface LocaleState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: currentLocale,
  setLocale: (locale) => {
    currentLocale = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
    set({ locale });
  },
}));
