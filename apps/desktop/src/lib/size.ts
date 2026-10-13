import { t } from "../i18n";

/** Every size the app shows: binary units, one decimal under 10 GB, whole
 * gigabytes above it, and megabytes below one. Lives in lib so the store can
 * word a refusal with it; `components/ModelLibrary` re-exports it, which is
 * where the screens import it from. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return t("common.sizeGb", { value: 0 });
  const gb = bytes / 2 ** 30;
  if (gb >= 10) return t("common.sizeGb", { value: Math.round(gb) });
  if (gb >= 1) return t("common.sizeGb", { value: gb.toFixed(1) });
  return t("common.sizeMb", { value: Math.max(1, Math.round(bytes / 2 ** 20)) });
}
