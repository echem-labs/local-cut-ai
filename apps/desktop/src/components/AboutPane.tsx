import { Check, Cpu, Package } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "../i18n";
import { formatSize } from "./ModelLibrary";
import { relativeTime } from "../lib/time";
import { useApp } from "../store";
import { Alert } from "./Alert";
import { BrandMark } from "./BrandMark";
import { OPEN_SHORTCUTS_EVENT } from "./Help";
import { SpecChips } from "./SpecChips";
import { Tip } from "./Tooltip";

/**
 * About — what version this is, what machine it is on, and what the app
 * does and does not send anywhere.
 *
 * The one pane that is a document rather than a settings list, so it is
 * built from cards instead of `.setting-row`s (mock:
 * `reference/v3/about-proposed.png`). Its job is to be readable by someone
 * who is already having a bad time: the version line they are about to
 * paste into an issue, the hardware that explains why a render was slow,
 * and one button that packages the rest.
 */
export function AboutPane({ onShowLicenses }: { onShowLicenses: () => void }) {
  const client = useApp((state) => state.client);
  const system = useApp((state) => state.system);
  const engineVersions = useApp((state) => state.engineVersions);
  const storage = useApp((state) => state.storage);
  const refreshStorage = useApp((state) => state.refreshStorage);
  const remoteEngine = useApp((state) => state.remoteEngine);

  // The data-folder row is the only thing here that needs a disk walk, and
  // the Storage pane is the one that usually pays for it. Ask once on open
  // so About is not blank for whoever came straight to it.
  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const dash = t("settings.engine.dash");
  const versionLine = t("settings.about.versionLine", {
    app: __APP_VERSION__,
    engine: engineVersions?.engine_version ?? dash,
    api: engineVersions ? `v${engineVersions.api_version}` : dash,
  });

  const used = storage
    ? storage.models_bytes +
      storage.cache_bytes +
      storage.projects.reduce((sum, row) => sum + row.bytes, 0)
    : null;

  return (
    <section className="about">
      <h2>
        <Package {...ICON} />
        {t("settings.tabs.about")}
      </h2>
      <p className="hint">{t("settings.about.hint")}</p>

      <div className="about-card about-version">
        <BrandMark size={44} />
        <div className="about-id">
          <div className="about-name">{t("settings.about.appName")}</div>
          {/* Mono, and one line: this is the string that gets pasted into
              an issue, so it has to survive being copied by hand. */}
          <div className="about-versions">{versionLine}</div>
        </div>
        <UpdateCheck />
      </div>

      <h3>{t("settings.about.machineHeading")}</h3>
      <div className="about-card">
        {/* The same chips the wizard showed when it picked models for this
            machine — one rendering of what was detected, so the two
            screens can never disagree about it. */}
        {system ? <SpecChips system={system} /> : <p className="hint">{t("settings.about.machineLoading")}</p>}
        <dl className="kv about-kv">
          <dt>{t("settings.about.tier")}</dt>
          <dd>{system ? system.hardware.tier : dash}</dd>
          <dt>{t("settings.about.backends")}</dt>
          <dd>{system?.backends?.chain.join(", ") ?? system?.backend_mode ?? dash}</dd>
          <dt>{t("settings.about.engineRow")}</dt>
          <dd>
            {t(remoteEngine ? "settings.about.engineRemote" : "settings.about.engineLocal", {
              url: client?.baseUrl ?? dash,
            })}
          </dd>
          <dt>{t("settings.about.dataFolder")}</dt>
          {/* Path and size together: "41 GB used" means nothing without
              saying used where, and on a paired engine that is not even
              this machine. An older engine sends no path — say so rather
              than render an empty cell. */}
          {storage?.data_dir ? (
            <dd>
              {storage.data_dir}
              {used !== null && ` · ${t("settings.about.used", { size: formatSize(used) })}`}
            </dd>
          ) : (
            // Prose, so it must leave the mono column style behind: set in
            // the same face as a path, "this engine does not report its
            // folder" reads as a value rather than as its absence.
            <dd className="about-unset">{t("settings.about.dataFolderUnknown")}</dd>
          )}
        </dl>
      </div>

      <h3>{t("settings.about.supportHeading")}</h3>
      <div className="about-card">
        <SupportActions />
      </div>

      <div className="about-card about-privacy">
        <div className="about-privacy-title">{t("settings.about.privacyHeading")}</div>
        <p>{t("settings.about.privacyBody")}</p>
      </div>

      <div className="about-links">
        <a href={LINKS.website} target="_blank" rel="noreferrer">
          {t("settings.about.linkWebsite")}
        </a>
        <a href={LINKS.docs} target="_blank" rel="noreferrer">
          {t("settings.about.linkDocs")}
        </a>
        <a href={LINKS.issues} target="_blank" rel="noreferrer">
          {t("settings.about.linkIssues")}
        </a>
        <Tip label={t("settings.about.licenses")} hint={t("settings.about.licensesTipHint")}>
          <button className="link" onClick={onShowLicenses}>
            {t("settings.about.licenses")}
          </button>
        </Tip>
      </div>
      <p className="about-fine">{t("settings.about.fine", { year: BUILD_YEAR })}</p>
    </section>
  );
}

const ICON = { size: 15, strokeWidth: 1.8 } as const;
const ICON_SM = { size: 13, strokeWidth: 1.8 } as const;

/** Derived from package.json's `homepage`, so there is one place to change
 * when the repo moves and no URL is retyped into a catalog string. */
const LINKS = {
  website: __HOMEPAGE__,
  docs: `${__HOMEPAGE__}#readme`,
  issues: `${__HOMEPAGE__}/issues`,
};

/** The copyright year is the BUILD's, not the reader's clock: a machine
 * with a wrong date should not restate this app's provenance. */
const BUILD_YEAR = __BUILD_YEAR__;

const CHECKED_KEY = "localcut.updateCheckedAt";

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; url: string }
  | { kind: "failed"; message: string };

/**
 * The update check, which happens only when asked.
 *
 * Absent entirely until a release feed is configured — the shell reports
 * whether one is, and hiding the control is the honest form of "we cannot
 * answer that yet". A button that always said "could not check" would be
 * worse than no button, and a background check would break the promise the
 * privacy card makes two cards down.
 */
function UpdateCheck() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  // The release page the last check named, kept so "What's new" survives
  // the up-to-date verdict — a check that finds no update still learned
  // where the notes for THIS version are.
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(CHECKED_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  if (!window.localcut?.updatesConfigured) return null;

  const check = () => {
    setState({ kind: "checking" });
    void window.localcut.checkForUpdates().then((result) => {
      const now = Math.floor(Date.now() / 1000);
      localStorage.setItem(CHECKED_KEY, String(now));
      setCheckedAt(now);
      if (result.error) return setState({ kind: "failed", message: result.error });
      if (result.url) setReleaseUrl(result.url);
      // Same version, or an older one: a feed that has rolled back is not
      // an update, and offering one would walk the user backwards.
      if (!result.latest || !isNewer(result.latest, __APP_VERSION__))
        return setState({ kind: "current" });
      setState({ kind: "available", version: result.latest, url: result.url ?? "" });
    });
  };

  // A fragment, not a wrapper: the card is a grid, and these are two of
  // its items. The status row rides beside the version; the "checked at"
  // line spans the card under a rule. Nesting the second inside the first
  // is what this looked like at first, and the sentence is wider than the
  // button above it — so the whole right-hand block grew past what was
  // left beside the mark and wrapped the card onto two rows.
  return (
    <>
      <div className="about-update-row">
        {state.kind === "current" && (
          <span className="about-uptodate">
            <Check size={13} strokeWidth={2.4} aria-hidden="true" />
            {t("settings.about.upToDate")}
          </span>
        )}
        {state.kind === "available" && (
          <a className="about-newer" href={state.url} target="_blank" rel="noreferrer">
            {t("settings.about.updateAvailable", { version: state.version })}
          </a>
        )}
        <Tip
          label={t("settings.about.checkUpdates")}
          hint={t("settings.about.checkUpdatesTipHint")}
        >
          <button className="btn-ghost" disabled={state.kind === "checking"} onClick={check}>
            {state.kind === "checking"
              ? t("settings.about.checking")
              : t("settings.about.checkUpdates")}
          </button>
        </Tip>
      </div>
      <div className="about-whatsnew">
        <span>
          {checkedAt
            ? t("settings.about.checkedAt", { when: relativeTime(checkedAt) })
            : t("settings.about.neverChecked")}
        </span>
        {/* Only once a check has actually returned a link. The version is
            this build's either way, but a "what's new" that goes nowhere
            is worse than no link at all. */}
        {state.kind === "available" && state.url && (
          <a href={state.url} target="_blank" rel="noreferrer">
            {t("settings.about.whatsNew", { version: state.version })}
          </a>
        )}
        {state.kind === "current" && releaseUrl && (
          <a href={releaseUrl} target="_blank" rel="noreferrer">
            {t("settings.about.whatsNew", { version: __APP_VERSION__ })}
          </a>
        )}
      </div>
      {state.kind === "failed" && <Alert message={state.message} />}
    </>
  );
}

/** Numeric semver compare, prerelease ignored — enough to answer "is the
 * feed ahead of us", which is the only question asked. A tag that does not
 * parse compares as not-newer: never offering an update is a smaller
 * failure than offering a downgrade. */
function isNewer(candidate: string, current: string): boolean {
  const parts = (value: string) => value.split(".").map((piece) => Number.parseInt(piece, 10));
  const a = parts(candidate);
  const b = parts(current);
  for (let index = 0; index < 3; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The four things someone can do when they need help, in the order they
 * escalate: copy a line, package the details, read the log yourself, or
 * find out which key you were looking for.
 */
function SupportActions() {
  const system = useApp((state) => state.system);
  const engineVersions = useApp((state) => state.engineVersions);
  const client = useApp((state) => state.client);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const unknown = t("settings.about.diagUnknown");
  const gpu = system?.hardware.primary_gpu ?? system?.hardware.gpus[0] ?? null;

  const copyDiagnostics = () => {
    const lines = [
      t("settings.about.diagApp", { version: __APP_VERSION__ }),
      t("settings.about.diagEngine", {
        engine: engineVersions?.engine_version ?? unknown,
        api: engineVersions?.api_version ?? unknown,
      }),
      t("settings.about.diagBackend", { backend: system?.backend_mode ?? unknown }),
      t("settings.about.diagUrl", { url: client?.baseUrl ?? unknown }),
      system
        ? t("settings.about.diagHardware", {
            tier: system.hardware.tier,
            gpu: gpu
              ? t("settings.about.diagGpu", { name: gpu.name, vram: gpu.vram_gb })
              : t("settings.about.diagNoGpu"),
            ram: system.hardware.ram_gb,
          })
        : t("settings.about.diagHardwareUnknown"),
    ];
    void navigator.clipboard.writeText(lines.join("\n")).then(() => setCopied(true));
  };

  const exportBundle = () => {
    setError(null);
    setSaved(null);
    setBusy(true);
    // The renderer contributes what only it has — these reach it over
    // HTTP — and the shell adds its own logs and asks where to save.
    void window.localcut
      ?.exportSupportBundle({ versions: { app: __APP_VERSION__, ...engineVersions }, system })
      .then((result) => {
        if (result.error) setError(result.error);
        else if (result.path) setSaved(result.path);
      })
      .finally(() => setBusy(false));
  };

  const openLogs = () => {
    setError(null);
    void window.localcut?.openLogsFolder().then((result) => {
      if (result.error) setError(result.error);
    });
  };

  return (
    <>
      <div className="about-actions">
        <Tip label={t("settings.about.copy")} hint={t("settings.about.copyTipHint")}>
          <button className="btn-ghost" onClick={copyDiagnostics}>
            {copied ? t("settings.about.copied") : t("settings.about.copy")}
          </button>
        </Tip>
        {/* What the bundle holds rides on the button rather than in a line
            under the row. The sentence was there, and the privacy card two
            cards below already promises nothing is sent — so it was
            repeating a claim in the place a reader had just read it, and
            pushing every card under it down a line to do so.
            In the app's bubble rather than the browser's: `title` waits a
            second, never reaches the keyboard, and drew this row's one
            explanation in the OS's style beside four that had none. */}
        <Tip label={t("settings.about.exportBundle")} hint={t("settings.about.supportHint")}>
          <button className="btn-ghost" disabled={busy} onClick={exportBundle}>
            {busy ? t("settings.about.bundling") : t("settings.about.exportBundle")}
          </button>
        </Tip>
        <Tip label={t("settings.about.openLogs")} hint={t("settings.about.openLogsTipHint")}>
          <button className="btn-ghost" onClick={openLogs}>
            {t("settings.about.openLogs")}
          </button>
        </Tip>
        <Tip label={t("settings.about.shortcuts")} hint={t("settings.about.shortcutsTipHint")}>
          <button
            className="btn-ghost"
            onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}
          >
            {t("settings.about.shortcuts")}
          </button>
        </Tip>
      </div>
      {/* Where it landed, named. A save dialog that closes with no trace
          leaves the user hunting for the file they just made. */}
      {saved && (
        <p className="about-saved" role="status">
          <Cpu {...ICON_SM} aria-hidden="true" />
          {t("settings.about.bundleSaved", { path: saved })}
        </p>
      )}
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
    </>
  );
}
