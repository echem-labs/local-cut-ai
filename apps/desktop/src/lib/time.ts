import { t, useLocale } from "../i18n";

/** "2h ago" / "3d ago", falling back to the short date past 7 days —
 * Home-tile meta (review 4). Locale-aware via Intl. */
export function relativeTime(epochSeconds: number): string {
  const locale = useLocale.getState().locale;
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  if (seconds < 60) return t("common.justNow");
  // Round within each unit and promote at the ceiling, so 3599s reads "1 hr
  // ago" (not "60 min ago") and ~24h reads "1 day ago" (not "24 hr ago").
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return rtf.format(-hours, "hour");
  if (seconds < 7 * 86400) return rtf.format(-Math.round(seconds / 86400), "day");
  return new Date(epochSeconds * 1000).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

/** "Aug 15, 19:42" — the readout form, for a list where two entries have
 * to be told apart rather than placed roughly in the past.
 *
 * Absolute where `relativeTime` is relative, and deliberately so: "2 hours
 * ago" is the right answer on a tile you are browsing and the wrong one in
 * a list of save points made twenty minutes apart, where the question is
 * always "which of these is which". */
export function absoluteTime(epochSeconds: number): string {
  const locale = useLocale.getState().locale;
  return new Date(epochSeconds * 1000).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "0:31" / "1:02" — mono duration pill on tiles. */
export function shortDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
