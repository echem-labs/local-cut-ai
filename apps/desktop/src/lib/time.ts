import { t, useLocale } from "../i18n";

/** "2h ago" / "3d ago", falling back to the short date past 7 days —
 * Home-tile meta (review 4). Locale-aware via Intl. */
export function relativeTime(epochSeconds: number): string {
  const locale = useLocale.getState().locale;
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  if (seconds < 60) return t("common.justNow");
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), "hour");
  if (seconds < 7 * 86400) return rtf.format(-Math.round(seconds / 86400), "day");
  return new Date(epochSeconds * 1000).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

/** "0:31" / "1:02" — mono duration pill on tiles. */
export function shortDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
