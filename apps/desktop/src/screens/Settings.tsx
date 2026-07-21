import {
  Activity,
  Boxes,
  Cpu,
  Database,
  Film,
  Folder,
  HardDrive,
  Info,
  KeyRound,
  Languages,
  Mic,
  Palette,
  Proportions,
  RotateCcw,
  Server,
  SlidersHorizontal,
  SunMoon,
  Tag,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { BackendTask, Provider } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dropdown } from "../components/Dropdown";
import { displayModelName, formatSize, ModelLibrary } from "../components/ModelLibrary";
import { InfoDot } from "../components/Tooltip";
import { m, type MessageKey, SUPPORTED_LOCALES, t, useLocale } from "../i18n";
import { ASPECTS, DURATIONS } from "../lib/formats";
import { type ProviderKeyId, type ProviderKeyPresence, useApp } from "../store";
import { applyTheme, loadThemePref, type ThemePref } from "../theme";

/* one three-step icon scale (review 4 §S10): 15/1.8 for all chrome */
const ICON_CONTROL = { size: 15, strokeWidth: 1.8 } as const;
/* sub-heading rows sit one step down the same scale */
const ICON_SUBHEAD = { size: 13, strokeWidth: 1.8 } as const;

const THEME_OPTIONS: { value: ThemePref }[] = [
  { value: "system" },
  { value: "dark" },
  { value: "light" },
];

type SettingsTab =
  | "general"
  | "defaults"
  | "providers"
  | "models"
  | "storage"
  | "engine"
  | "about";

const NAV: { id: SettingsTab; icon: typeof SunMoon }[] = [
  { id: "general", icon: SunMoon },
  { id: "defaults", icon: SlidersHorizontal },
  { id: "providers", icon: KeyRound },
  { id: "models", icon: Boxes },
  { id: "storage", icon: HardDrive },
  { id: "engine", icon: Server },
  { id: "about", icon: Info },
];

/** Engine provider ids → shell key ids (google's key is a Gemini key). */
const KEY_IDS: Record<string, ProviderKeyId> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  fal: "fal",
};

/** API ids → catalog keys for the routing panel. Partial Records, not typed
 * unions: a newer engine may send ids this build doesn't know, and those
 * must fall back to the raw id instead of breaking the panel. */
const TASK_KIND_LABELS: Record<string, MessageKey> = {
  script: "settings.backends.kinds.script",
  keyframe: "settings.backends.kinds.keyframe",
  thumbnail: "settings.backends.kinds.thumbnail",
  clip: "settings.backends.kinds.clip",
  narration: "settings.backends.kinds.narration",
  captions: "settings.backends.kinds.captions",
  music: "settings.backends.kinds.music",
  timeline: "settings.backends.kinds.timeline",
  export: "settings.backends.kinds.export",
};

const TASK_KIND_INFO: Record<string, MessageKey> = {
  script: "settings.backends.kindInfo.script",
  keyframe: "settings.backends.kindInfo.keyframe",
  thumbnail: "settings.backends.kindInfo.thumbnail",
  clip: "settings.backends.kindInfo.clip",
  narration: "settings.backends.kindInfo.narration",
  captions: "settings.backends.kindInfo.captions",
  music: "settings.backends.kindInfo.music",
  timeline: "settings.backends.kindInfo.timeline",
  export: "settings.backends.kindInfo.export",
};

const BACKEND_NAME_LABELS: Record<string, MessageKey> = {
  comfyui: "settings.backends.names.comfyui",
  ffmpeg: "settings.backends.names.ffmpeg",
  llm: "settings.backends.names.llm",
  kokoro: "settings.backends.names.kokoro",
  chatterbox: "settings.backends.names.chatterbox",
  align: "settings.backends.names.align",
  mock: "settings.backends.names.mock",
  cloud: "settings.backends.names.cloud",
};

/** Settings (review 4): an overlay layer with a VS Code-style left category
 * nav — General · Defaults · Providers · Models · Storage · Engine · About.
 * Key material flows through the shell (OS keychain → engine), so this
 * screen only ever renders presence and status. */
export function Settings() {
  const {
    client,
    system,
    engineVersions,
    closeSettings,
    resetFirstRun,
    refreshModels,
    refreshStorage,
    cleanupStorage,
    deleteProject,
    storage,
    storageStale,
    models,
    defaults,
    setDefaults,
    remoteEngine,
    remotePaired,
    pairRemote,
    unpairRemote,
  } = useApp();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presence, setPresence] = useState<ProviderKeyPresence | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);
  const [confirmProject, setConfirmProject] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [confirmCache, setConfirmCache] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const { settingsTab, setSettingsTab } = useApp();
  const tab = (
    NAV.some((entry) => entry.id === settingsTab) ? settingsTab : "general"
  ) as SettingsTab;

  const refreshProviders = useCallback(async () => {
    if (!client) return;
    try {
      setProviders(await client.listProviders());
    } catch (err) {
      console.warn("providers refresh failed:", err);
    }
  }, [client]);

  useEffect(() => {
    void refreshProviders();
    refreshModels().catch((err) => console.warn("models refresh failed:", err));
    window.localcut
      .getProviderKeyPresence()
      .then(setPresence)
      .catch((err) => console.warn("key presence failed:", err));
  }, [refreshProviders, refreshModels]);

  // Storage numbers load when the category shows (a walk isn't free).
  useEffect(() => {
    if (tab === "storage") void refreshStorage();
  }, [tab, refreshStorage]);

  // Esc closes the overlay — unless a field or a layered dialog owns it.
  const dialogOpen = confirmProject !== null || confirmCache || showLicenses;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dialogOpen) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        target.blur();
        return;
      }
      closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen, closeSettings]);

  // The licenses modal owns Escape while open: capture-phase so it fires before
  // — and stopImmediatePropagation so it suppresses — every other still-mounted
  // window keydown listener (Inspector's deselect, the shared handler above),
  // which would otherwise mutate the project underneath. Focus moves in on open
  // so keyboard/screen-reader users land inside the dialog, matching ConfirmDialog.
  const licensesCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!showLicenses) return;
    licensesCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setShowLicenses(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showLicenses]);

  const saveKey = async (providerId: string) => {
    const value = (drafts[providerId] ?? "").trim();
    if (!value || busy) return;
    setBusy(providerId);
    setKeyError(null);
    try {
      const result = await window.localcut.setProviderKeys({ [KEY_IDS[providerId]]: value });
      setPresence(result.presence);
      if (result.error) setKeyError(result.error);
      setDrafts((prev) => ({ ...prev, [providerId]: "" }));
      await refreshProviders();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async (providerId: string) => {
    if (busy) return;
    setBusy(providerId);
    setKeyError(null);
    try {
      const result = await window.localcut.clearProviderKey(KEY_IDS[providerId]);
      setPresence(result.presence);
      if (result.error) setKeyError(result.error);
      await refreshProviders();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const gpu = system?.hardware.primary_gpu ?? system?.hardware.gpus[0] ?? null;

  /** One routing row: backend display name, plus what makes it concrete —
   * the installed models behind a ComfyUI claim, or the honest "still
   * images" caveat when clips landed on the FFmpeg fallback tier. */
  const routeLabel = (row: BackendTask): string => {
    if (!row.backend) return t("settings.backends.unrouted");
    const nameKey = BACKEND_NAME_LABELS[row.backend];
    const name = nameKey ? t(nameKey) : row.backend;
    if (row.kind === "clip" && row.backend === "ffmpeg") {
      return t("settings.backends.stillClips", { name });
    }
    if (row.backend === "comfyui" && row.installed_models.length > 0) {
      const pretty = row.installed_models.map((id) => {
        const entry = models.find((candidate) => candidate.id === id);
        return entry?.family ? displayModelName(entry.family, entry.version) : id;
      });
      return t("settings.backends.withModels", { name, models: pretty.join(", ") });
    }
    return name;
  };

  const submitPairing = () => {
    if (pairBusy || !pairingCode.trim()) return;
    setPairBusy(true);
    setPairError(null);
    void pairRemote(pairingCode.trim())
      .then((error) => {
        setPairError(error);
        if (!error) setPairingCode("");
      })
      .finally(() => setPairBusy(false));
  };

  const copyDiagnostics = () => {
    const unknown = t("settings.about.diagUnknown");
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
    void navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const videoModelOptions = [
    { value: "", label: t("settings.defaults.autoModel") },
    ...models
      .filter((row) => row.task.startsWith("video.") && (row.downloaded || row.custom))
      .map((row) => ({
        value: `local:${row.id}`,
        label: displayModelName(row.family, row.version),
      })),
  ];

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>{t("settings.title")}</h1>
        <kbd>esc</kbd>
        <button className="icon-btn" onClick={closeSettings} aria-label={t("settings.closeAria")}>
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="settings-grid">
        <nav
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.tablistAria")}
        >
          {NAV.map((entry, index) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                tabIndex={tab === entry.id ? 0 : -1}
                className={tab === entry.id ? "active" : ""}
                onClick={() => setSettingsTab(entry.id)}
                onKeyDown={(event) => {
                  // Roving focus: Up/Down/Home/End move and select.
                  const delta =
                    event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  let next: number | null = null;
                  if (delta) next = (index + delta + NAV.length) % NAV.length;
                  if (event.key === "Home") next = 0;
                  if (event.key === "End") next = NAV.length - 1;
                  if (next === null) return;
                  event.preventDefault();
                  setSettingsTab(NAV[next].id);
                  (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
                }}
              >
                <Icon {...ICON_CONTROL} aria-hidden="true" />
                {t(`settings.tabs.${entry.id}`)}
              </button>
            );
          })}
        </nav>

        <div className="settings-pane">
          {tab === "general" && (
            <section>
              <h2>
                <SunMoon {...ICON_CONTROL} />
                {t("settings.tabs.general")}
              </h2>
              <p className="hint">{t("settings.generalHint")}</p>
              <div className="setting-row">
                <div className="st">
                  <Palette {...ICON_SUBHEAD} />
                  {t("settings.appearance.heading")}
                </div>
                <div className="sd">{t("settings.appearance.hint")}</div>
                <div className="sc">
                  <div
                    className="seg-toggle"
                    role="group"
                    aria-label={t("settings.appearance.aria")}
                  >
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        className={theme === option.value ? "active" : ""}
                        onClick={() => {
                          setTheme(option.value);
                          applyTheme(option.value);
                        }}
                      >
                        {t(`settings.theme.${option.value}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {SUPPORTED_LOCALES.length > 1 && (
                <div className="setting-row">
                  <div className="st">
                    <Languages {...ICON_SUBHEAD} />
                    {t("settings.language.heading")}
                  </div>
                  <div className="sd">{t("settings.language.hint")}</div>
                  <div className="sc">
                    <Dropdown
                      value={locale}
                      ariaLabel={t("settings.language.heading")}
                      options={SUPPORTED_LOCALES.map((entry) => ({
                        value: entry.id,
                        label: entry.label,
                      }))}
                      onChange={setLocale}
                    />
                  </div>
                </div>
              )}
              <div className="setting-row">
                <div className="st">
                  <RotateCcw {...ICON_SUBHEAD} />
                  {t("settings.setup.heading")}
                </div>
                <div className="sd">{t("settings.setup.hint")}</div>
                <div className="sc">
                  <button className="btn-ghost" onClick={resetFirstRun}>
                    {t("settings.setup.action")}
                  </button>
                </div>
              </div>
            </section>
          )}

          {tab === "defaults" && (
            <section>
              <h2>
                <SlidersHorizontal {...ICON_CONTROL} />
                {t("settings.tabs.defaults")}
              </h2>
              <p className="hint">{t("settings.defaults.hint")}</p>
              <div className="setting-row">
                <div className="st">
                  <Proportions {...ICON_SUBHEAD} />
                  {t("settings.defaults.formatHeading")}
                </div>
                <div className="sd">{t("settings.defaults.formatHint")}</div>
                <div className="sc">
                  <Dropdown
                    value={defaults.aspect}
                    onChange={(value) => setDefaults({ aspect: value })}
                    ariaLabel={t("home.aspectAria")}
                    options={ASPECTS.map((entry) => ({
                      value: entry.value,
                      label: `${entry.value} · ${m().aspects[entry.key]}`,
                      icon: entry.icon,
                    }))}
                  />
                  <Dropdown
                    value={defaults.duration}
                    onChange={(value) => setDefaults({ duration: value })}
                    ariaLabel={t("home.durationAria")}
                    options={DURATIONS.map((entry) => ({
                      value: entry.value,
                      label: m().durations[entry.key],
                      icon: entry.icon,
                    }))}
                  />
                  <div className="seg-toggle" role="group" aria-label={t("home.modeAria")}>
                    <button
                      className={defaults.mode === "prompt" ? "active" : ""}
                      onClick={() => setDefaults({ mode: "prompt" })}
                      title={t("home.modeAutoTitle")}
                    >
                      {t("home.modeAuto")}
                    </button>
                    <button
                      className={defaults.mode === "beginner" ? "active" : ""}
                      onClick={() => setDefaults({ mode: "beginner" })}
                      title={t("home.modeReviewTitle")}
                    >
                      {t("home.modeReview")}
                    </button>
                  </div>
                </div>
              </div>
              <div className="setting-row">
                <div className="st">
                  <Mic {...ICON_SUBHEAD} />
                  {t("settings.defaults.voiceHeading")}
                </div>
                <div className="sd">{t("settings.defaults.voiceHint")}</div>
                <div className="sc">
                  <input
                    style={{ minWidth: 240 }}
                    value={defaults.voice}
                    placeholder={t("home.voicePlaceholder")}
                    aria-label={t("settings.defaults.voiceHeading")}
                    onChange={(event) => setDefaults({ voice: event.target.value })}
                  />
                </div>
              </div>
              <div className="setting-row">
                <div className="st">
                  <Film {...ICON_SUBHEAD} />
                  {t("settings.defaults.modelHeading")}
                </div>
                <div className="sd">{t("settings.defaults.modelHint")}</div>
                <div className="sc">
                  <Dropdown
                    value={defaults.videoModel ?? ""}
                    onChange={(value) => setDefaults({ videoModel: value || null })}
                    ariaLabel={t("settings.defaults.modelHeading")}
                    options={videoModelOptions}
                  />
                </div>
              </div>
            </section>
          )}

          {tab === "providers" && (
            <section>
              <h2>
                <KeyRound {...ICON_CONTROL} />
                {t("settings.providers.heading")}
              </h2>
              <p className="hint">{t("settings.providers.hint")}</p>
              {presence && !presence.encrypted && (
                <div className="banner warning">{t("settings.providers.noKeychain")}</div>
              )}
              {keyError && <div className="banner error">{keyError}</div>}
              {providers.length === 0 && (
                <p className="hint">{t("settings.providers.engineUnavailable")}</p>
              )}
              {providers.map((provider) => {
                const draft = (drafts[provider.id] ?? "").trim();
                return (
                  <div className="provider-row" key={provider.id}>
                    <div className="grow">
                      <div className="name">{provider.label}</div>
                      <div className="meta">{provider.capabilities.join(", ")}</div>
                    </div>
                    <span className={`badge${provider.configured ? " ok" : ""}`}>
                      {provider.configured
                        ? t("settings.providers.configured")
                        : t("settings.providers.noKey")}
                    </span>
                    <input
                      type="password"
                      placeholder={t("settings.providers.keyPlaceholder")}
                      value={drafts[provider.id] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveKey(provider.id);
                      }}
                      aria-label={t("settings.providers.keyAria", { provider: provider.label })}
                    />
                    {/* Save earns its place only once a key is typed */}
                    {draft && (
                      <button
                        className="btn-primary"
                        onClick={() => void saveKey(provider.id)}
                        disabled={busy !== null}
                      >
                        {busy === provider.id ? t("common.saving") : t("common.save")}
                      </button>
                    )}
                    {(provider.configured || presence?.[KEY_IDS[provider.id]]) && (
                      <button
                        className="btn-ghost"
                        onClick={() => void clearKey(provider.id)}
                        disabled={busy !== null}
                      >
                        {t("common.clear")}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {tab === "models" && (
            <section>
              <h2>
                <Boxes {...ICON_CONTROL} />
                {t("settings.models.heading")}
              </h2>
              <p className="hint">{t("settings.models.hint")}</p>
              <ModelLibrary showActions showAddCustom />
            </section>
          )}

          {tab === "storage" && (
            <section>
              <h2>
                <HardDrive {...ICON_CONTROL} />
                {t("settings.tabs.storage")}
              </h2>
              <p className="hint">{t("settings.storage.hint")}</p>
              {storageStale && storage && (
                <p className="hint" role="status">
                  {t("settings.storage.stale")}
                </p>
              )}
              {storage ? (
                <>
                  {(() => {
                    const total =
                      storage.models_bytes +
                      storage.cache_bytes +
                      storage.projects.reduce((sum, row) => sum + row.bytes, 0);
                    const pct = (bytes: number) =>
                      total > 0 ? `${(bytes / total) * 100}%` : "0%";
                    const projectBytes = storage.projects.reduce(
                      (sum, row) => sum + row.bytes,
                      0,
                    );
                    return (
                      <>
                        <div className="storage-usage" aria-hidden="true">
                          <i
                            style={{ width: pct(storage.models_bytes), background: "var(--accent)" }}
                          />
                          <i
                            style={{
                              width: pct(projectBytes),
                              background: "var(--status-final)",
                            }}
                          />
                          <i
                            style={{
                              width: pct(storage.cache_bytes),
                              background: "var(--text-tertiary)",
                            }}
                          />
                        </div>
                        <div className="storage-legend">
                          <span>
                            <i style={{ background: "var(--accent)" }} />
                            {t("settings.storage.models", {
                              size: formatSize(storage.models_bytes),
                            })}
                          </span>
                          <span>
                            <i style={{ background: "var(--status-final)" }} />
                            {t("settings.storage.projects", { size: formatSize(projectBytes) })}
                          </span>
                          <span>
                            <i style={{ background: "var(--text-tertiary)" }} />
                            {t("settings.storage.cache", {
                              size: formatSize(storage.cache_bytes),
                            })}
                          </span>
                          <span className="free">
                            {t("settings.storage.diskFree", {
                              size: formatSize(storage.disk_free_bytes),
                            })}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                  <div className="setting-row">
                    <div className="st">
                      <Folder {...ICON_SUBHEAD} />
                      {t("settings.storage.bySize")}
                    </div>
                    <div className="storage-list">
                      {storage.projects.map((row) => (
                        <div className="storage-row" key={row.id}>
                          <span className="grow">{row.title}</span>
                          <span className="size">{formatSize(row.bytes)}</span>
                          <button
                            className="icon-btn-sm"
                            aria-label={t("settings.storage.deleteAria", { title: row.title })}
                            onClick={() => setConfirmProject(row)}
                          >
                            <Trash2 size={13} strokeWidth={1.8} />
                          </button>
                        </div>
                      ))}
                      {storage.projects.length === 0 && (
                        <p className="hint">{t("settings.storage.noProjects")}</p>
                      )}
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="st">
                      <Database {...ICON_SUBHEAD} />
                      {t("settings.storage.cacheHeading")}
                    </div>
                    <div className="sd">{t("settings.storage.cacheHint")}</div>
                    <div className="sc">
                      <button className="btn-ghost" onClick={() => setConfirmCache(true)}>
                        {t("settings.storage.clearCache", {
                          size: formatSize(storage.cache_bytes),
                        })}
                      </button>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="st">
                      <Boxes {...ICON_SUBHEAD} />
                      {t("settings.storage.modelsHeading")}
                    </div>
                    <div className="sd">{t("settings.storage.modelsHint")}</div>
                    <div className="sc">
                      <button className="btn-ghost" onClick={() => setSettingsTab("models")}>
                        {t("home.manageModels")}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="hint">{t("settings.storage.loading")}</p>
              )}
            </section>
          )}

          {tab === "engine" && (
            <>
              <section>
                <h2>
                  <Server {...ICON_CONTROL} />
                  {t("settings.remote.heading")}
                </h2>
                <p className="hint">
                  {t("settings.remote.hintBefore")}
                  <code>localcut-engine serve --host 0.0.0.0 --token …</code>
                  {t("settings.remote.hintAfter")}
                </p>
                {remotePaired ? (
                  <div className="provider-row">
                    <div className="grow">
                      <div className="name">
                        {remoteEngine
                          ? t("settings.remote.pairedWith", {
                              url: client?.baseUrl ?? t("settings.remote.pairedFallback"),
                            })
                          : t("settings.remote.pairedUnreachable")}
                      </div>
                      <div className="meta">
                        {remoteEngine
                          ? t("settings.remote.allRemote")
                          : t("settings.remote.disconnectHint")}
                      </div>
                    </div>
                    <button
                      className="btn-ghost"
                      disabled={pairBusy}
                      onClick={() => {
                        setPairBusy(true);
                        setPairError(null);
                        void unpairRemote()
                          .then(setPairError)
                          .finally(() => setPairBusy(false));
                      }}
                    >
                      {pairBusy
                        ? t("settings.remote.disconnecting")
                        : t("settings.remote.disconnect")}
                    </button>
                  </div>
                ) : (
                  <div className="provider-row">
                    <input
                      placeholder={t("settings.remote.pairPlaceholder")}
                      value={pairingCode}
                      onChange={(event) => setPairingCode(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitPairing();
                      }}
                      aria-label={t("settings.remote.pairAria")}
                    />
                    <button
                      className="btn-primary"
                      disabled={pairBusy || !pairingCode.trim()}
                      onClick={submitPairing}
                    >
                      {pairBusy ? t("settings.remote.pairing") : t("settings.remote.pair")}
                    </button>
                  </div>
                )}
                {pairError && <div className="banner error">{pairError}</div>}
              </section>

              <section>
                <h2>
                  <Cpu {...ICON_CONTROL} />
                  {t("settings.engine.heading")}
                </h2>
                <p className="hint">{t("settings.engine.hint")}</p>
                <dl className="kv">
                  <dt>
                    {t("settings.engine.url")}
                    <InfoDot
                      label={t("settings.engine.url")}
                      hint={t("settings.engine.urlInfo")}
                    />
                  </dt>
                  <dd>{client?.baseUrl ?? t("settings.engine.notConnected")}</dd>
                  <dt>
                    {t("settings.engine.backend")}
                    <InfoDot
                      label={t("settings.engine.backend")}
                      hint={t("settings.engine.backendInfo")}
                    />
                  </dt>
                  <dd>{system?.backend_mode ?? t("settings.engine.dash")}</dd>
                  <dt>
                    {t("settings.engine.hardware")}
                    <InfoDot
                      label={t("settings.engine.hardware")}
                      hint={t("settings.engine.hardwareInfo")}
                    />
                  </dt>
                  <dd>
                    {system
                      ? t("settings.engine.hardwareValue", {
                          tier: system.hardware.tier,
                          detail: gpu
                            ? t("settings.engine.gpuDetail", {
                                gpu: gpu.name,
                                vram: gpu.vram_gb,
                              })
                            : t("settings.engine.noGpu"),
                        })
                      : t("settings.engine.dash")}
                  </dd>
                </dl>
              </section>

              {system?.backends && (
                <section>
                  <h2>
                    <Waypoints {...ICON_CONTROL} />
                    {t("settings.backends.heading")}
                  </h2>
                  <p className="hint">
                    {system.backends.comfy_kinds_auto
                      ? t("settings.backends.hintAuto")
                      : t("settings.backends.hintManual")}
                  </p>
                  <dl className="kv">
                    {system.backends.tasks.map((row) => {
                      const label = TASK_KIND_LABELS[row.kind]
                        ? t(TASK_KIND_LABELS[row.kind])
                        : row.kind;
                      return (
                        <Fragment key={row.kind}>
                          <dt>
                            {label}
                            {TASK_KIND_INFO[row.kind] && (
                              <InfoDot label={label} hint={t(TASK_KIND_INFO[row.kind])} />
                            )}
                          </dt>
                          <dd>{routeLabel(row)}</dd>
                        </Fragment>
                      );
                    })}
                  </dl>
                </section>
              )}
            </>
          )}

          {tab === "about" && (
            <section>
              <h2>
                <Info {...ICON_CONTROL} />
                {t("settings.tabs.about")}
              </h2>
              <p className="hint">{t("settings.about.hint")}</p>
              <div className="setting-row">
                <div className="st">
                  <Tag {...ICON_SUBHEAD} />
                  {t("settings.about.versionHeading")}
                </div>
                <dl className="kv" style={{ marginTop: 8 }}>
                  <dt>{t("settings.about.app")}</dt>
                  <dd>{__APP_VERSION__}</dd>
                  <dt>{t("settings.about.engine")}</dt>
                  <dd>{engineVersions?.engine_version ?? t("settings.engine.dash")}</dd>
                  <dt>{t("settings.about.api")}</dt>
                  <dd>
                    {engineVersions ? `v${engineVersions.api_version}` : t("settings.engine.dash")}
                  </dd>
                  <dt>{t("settings.engine.backend")}</dt>
                  <dd>{system?.backend_mode ?? t("settings.engine.dash")}</dd>
                </dl>
              </div>
              <div className="setting-row">
                <div className="st">
                  <Activity {...ICON_SUBHEAD} />
                  {t("settings.about.diagnosticsHeading")}
                </div>
                <div className="sd">{t("settings.about.diagnosticsHint")}</div>
                <div className="sc" style={{ display: "flex", gap: 8 }}>
                  <button className="btn-ghost" onClick={copyDiagnostics}>
                    {copied ? t("settings.about.copied") : t("settings.about.copy")}
                  </button>
                  <button className="btn-ghost" onClick={() => setShowLicenses(true)}>
                    {t("settings.about.licenses")}
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {confirmProject && (
        <ConfirmDialog
          title={t("home.deleteTitle", { title: confirmProject.title })}
          message={t("home.deleteMessage")}
          confirmLabel={t("home.deleteConfirm")}
          danger
          onConfirm={() => {
            const target = confirmProject;
            setConfirmProject(null);
            void deleteProject(target.id).then(() => refreshStorage());
          }}
          onCancel={() => setConfirmProject(null)}
        />
      )}
      {confirmCache && (
        <ConfirmDialog
          title={t("settings.storage.clearCacheTitle")}
          message={t("settings.storage.clearCacheMessage")}
          confirmLabel={t("settings.storage.clearCacheConfirm")}
          onConfirm={() => {
            setConfirmCache(false);
            void cleanupStorage();
          }}
          onCancel={() => setConfirmCache(false)}
        />
      )}
      {showLicenses && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowLicenses(false)}
          role="presentation"
        >
          <div
            className="modal licenses-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.about.licensesTitle")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>{t("settings.about.licensesTitle")}</h2>
            <p>{t("settings.about.licensesIntro")}</p>
            <ul className="licenses-list">
              {__OSS_LICENSES__.map((dep) => (
                <li key={dep.name}>
                  <div className="lic-head">
                    <span className="lic-name">{dep.name}</span>
                    <span className="lic-version mono-id">{dep.version}</span>
                    <span className="badge">{dep.license}</span>
                  </div>
                  {dep.repository && <div className="lic-repo mono-id">{dep.repository}</div>}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                className="btn-primary"
                ref={licensesCloseRef}
                onClick={() => setShowLicenses(false)}
              >
                {t("settings.about.licensesClose")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
