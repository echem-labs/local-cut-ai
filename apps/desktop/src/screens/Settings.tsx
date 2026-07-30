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
  Sparkles,
  SunMoon,
  Tag,
  Trash2,
  Waypoints,
  X,
  ZoomIn,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { BackendTask, Provider } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dropdown } from "../components/Dropdown";
import { displayModelName, formatSize, ModelLibrary } from "../components/ModelLibrary";
import { InfoDot } from "../components/Tooltip";
import { m, type MessageKey, plural, SUPPORTED_LOCALES, t, useLocale } from "../i18n";
import { DurationPicker } from "../components/DurationPicker";
import { ASPECTS } from "../lib/formats";
import { shortcutLabel } from "../lib/platform";
import { setUserZoom, userZoomFactor, ZOOM_EVENT, ZOOM_STEPS } from "../lib/zoom";
import {
  type PairingPreview,
  type ProviderKeyId,
  type ProviderKeyPresence,
  useApp,
} from "../store";
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
/** Per-task default models (engine-persisted): what renders each kind of
 * work when a node names no model. Rows come from the engine's own list of
 * defaultable tasks, so a task the engine cannot honor never grows a knob;
 * a task with nothing installed to choose stays hidden too. */
function ModelDefaultsPanel() {
  const { models, modelDefaults, refreshModelDefaults, setModelDefault, client } = useApp();
  const [llmNames, setLlmNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshModelDefaults();
  }, [refreshModelDefaults]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .llmModels()
      .then((info) => {
        if (!cancelled) setLlmNames(info.models);
      })
      .catch(() => {
        /* no LLM server — the text.llm row hides itself below */
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!modelDefaults) return null;
  const taskLabels = m().models.taskLabels as Record<string, string>;
  const rows = modelDefaults.tasks
    .map((task) => {
      const auto = { value: "", label: t("settings.models.defaultsAuto") };
      const current = modelDefaults.defaults[task] ?? "";
      let choices: { value: string; label: string }[];
      if (task === "text.llm") {
        // Ollama-served names, plus the stored one even when the server is
        // down — the picker must show the truth, not silently blank it.
        const names = current && !llmNames.includes(current) ? [current, ...llmNames] : llmNames;
        choices = names.map((name) => ({ value: name, label: name }));
      } else {
        choices = models
          .filter((row) => row.task === task && (row.downloaded || row.custom))
          .map((row) => ({ value: row.id, label: displayModelName(row.family, row.version) }));
      }
      return { task, current, options: [auto, ...choices] };
    })
    .filter((row) => row.options.length > 1);
  if (rows.length === 0) return null;

  return (
    <div className="model-defaults">
      <h3>{t("settings.models.defaultsHeading")}</h3>
      <p className="hint">{t("settings.models.defaultsHint")}</p>
      {rows.map(({ task, current, options }) => (
        <div className="model-default-row" key={task}>
          <span>{taskLabels[task] ?? task}</span>
          <Dropdown
            value={current}
            options={options}
            ariaLabel={taskLabels[task] ?? task}
            onChange={(value) => {
              void setModelDefault(task, value === "" ? null : String(value)).then(setError);
            }}
          />
        </div>
      ))}
      {error && (
        <div role="status" className="banner error">
          {error}
        </div>
      )}
    </div>
  );
}

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
    deleteToolSessions,
    projects,
    storage,
    storageStale,
    models,
    defaults,
    setDefaults,
    remoteEngine,
    remotePaired,
    remoteKeysArmed,
    inspectPairing,
    pairRemote,
    armRemoteKeys,
    unpairRemote,
  } = useApp();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presence, setPresence] = useState<ProviderKeyPresence | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [armBusy, setArmBusy] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  // The decoded, not-yet-accepted pairing. Non-null = the review step is on
  // screen and nothing has been sent to the host yet.
  const [pairPreview, setPairPreview] = useState<PairingPreview | null>(null);
  // Defaults to false: sending provider keys to another machine is opt-in,
  // never a side effect of connecting to it.
  const [armKeys, setArmKeys] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(loadThemePref);
  // Mirrors the zoom module so the Ctrl +/− shortcuts move the control too.
  const [zoom, setZoom] = useState(userZoomFactor);
  useEffect(() => {
    const onZoom = () => setZoom(userZoomFactor());
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);
  const [confirmProject, setConfirmProject] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [confirmCache, setConfirmCache] = useState(false);
  const [confirmTools, setConfirmTools] = useState(false);
  // A failed delete or cache purge — shown in the storage pane rather than
  // discarded, which is what used to happen to both.
  const [storageError, setStorageError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const { settingsTab, setSettingsTab } = useApp();
  const tab = (
    NAV.some((entry) => entry.id === settingsTab) ? settingsTab : "general"
  ) as SettingsTab;

  // The storage walk reports every .lcut directory without saying which are
  // quick tool sessions; `mode` lives on the project list, so the split
  // happens here rather than as a second engine field that could disagree.
  const isToolSession = useCallback(
    (id: string) =>
      projects.some((project) => project.id === id && project.mode.startsWith("tool:")),
    [projects],
  );

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
  const dialogOpen = confirmProject !== null || confirmCache || confirmTools || showLicenses;
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
  const licensesReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!showLicenses) {
      // Closing: hand focus back to whatever opened the modal. Without this
      // a keyboard user is dumped at the top of the document and has to tab
      // all the way back to where they were.
      licensesReturnRef.current?.focus();
      licensesReturnRef.current = null;
      return;
    }
    licensesReturnRef.current = document.activeElement as HTMLElement | null;
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

  // The provider keys a pairing would hand over, by name. "3 keys" is not
  // something anyone can weigh; "Anthropic, OpenAI" is.
  const labelFor = (providerId: string) =>
    providers.find((p) => p.id === providerId)?.label ?? providerId;
  const storedKeyNames = Object.entries(KEY_IDS)
    .filter(([, keyId]) => pairPreview?.keys?.[keyId])
    .map(([providerId]) => labelFor(providerId));
  // The same list, but for an engine already paired: `pairPreview` only
  // exists while a code is being reviewed, and the arm control lives on the
  // other side of that flow entirely.
  const storedKeyLabels = Object.entries(KEY_IDS)
    .filter(([, keyId]) => presence?.[keyId])
    .map(([providerId]) => labelFor(providerId));
  const anyKeyStored = storedKeyLabels.length > 0;

  // Assembly with no backend means no working ffmpeg. The engine deliberately
  // refuses to let the mock stand in here — a placeholder MP4 handed over as
  // a finished export is worse than a clear failure — so this is the one
  // place that failure is explained rather than just showing "unrouted"
  // against two rows the user has no reason to connect to a missing binary.
  const assemblyUnrouted = (system?.backends?.tasks ?? []).some(
    (row) => (row.kind === "timeline" || row.kind === "export") && !row.backend,
  );

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

  /** Step 1 of pairing: decode the code and show what it names. A pairing
   * code is an opaque blob — accepting one blind is not a decision anyone
   * can make, so nothing is sent until the user has seen the host. */
  const submitPairing = () => {
    if (pairBusy || !pairingCode.trim()) return;
    setPairBusy(true);
    setPairError(null);
    void inspectPairing(pairingCode.trim())
      .then((preview) => {
        if (!preview.ok) {
          setPairError(preview.error ?? t("errors.pairingFailed"));
          return;
        }
        setPairPreview(preview);
      })
      .finally(() => setPairBusy(false));
  };

  /** Step 2: the user has seen the host and said yes. `armKeys` is their
   * separate answer to "…and send this host your provider keys?". */
  const confirmPairing = (armKeys: boolean) => {
    if (pairBusy) return;
    setPairBusy(true);
    setPairError(null);
    void pairRemote(pairingCode.trim(), armKeys)
      .then((error) => {
        setPairError(error);
        if (!error) {
          setPairingCode("");
          setPairPreview(null);
          // Back to opt-in for the NEXT pairing: a checkbox left ticked from
          // the last host would pre-arm a different one.
          setArmKeys(false);
        }
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
        <kbd>{shortcutLabel(t("common.keys.escape"))}</kbd>
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
              <div className="setting-row">
                <div className="st">
                  <ZoomIn {...ICON_SUBHEAD} />
                  {t("settings.zoom.heading")}
                </div>
                <div className="sd">{shortcutLabel(t("settings.zoom.hint"))}</div>
                <div className="sc">
                  <div className="seg-toggle" role="group" aria-label={t("settings.zoom.aria")}>
                    {ZOOM_STEPS.map((step) => (
                      <button
                        key={step}
                        className={zoom === step ? "active" : ""}
                        onClick={() => setUserZoom(step)}
                      >
                        {Math.round(step * 100)}%
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
                  <DurationPicker
                    value={defaults.duration}
                    onChange={(value) => setDefaults({ duration: value })}
                    ariaLabel={t("home.durationAria")}
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
                    title={t("home.voicePlaceholder")}
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
              <ModelDefaultsPanel />
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
              {storageError && (
                <p className="banner error" role="alert">
                  {storageError}
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
                  {(() => {
                    // Count from the project list, which is what the action
                    // actually deletes; size from the storage walk, which is
                    // the only thing that knows bytes. Counting from storage
                    // instead let a session created since the last
                    // measurement go uncounted and still be deleted — and, on
                    // a stale measurement, showed "Clear 0" as disabled while
                    // the rail plainly listed sessions.
                    const sessions = projects.filter((project) =>
                      project.mode.startsWith("tool:"),
                    );
                    const bytes = storage.projects
                      .filter((row) => isToolSession(row.id))
                      .reduce((sum, row) => sum + row.bytes, 0);
                    const rows = sessions;
                    return (
                      <div className="setting-row">
                        <div className="st">
                          <Sparkles {...ICON_SUBHEAD} />
                          {t("settings.storage.toolsHeading")}
                        </div>
                        <div className="sd">{t("settings.storage.toolsHint")}</div>
                        <div className="sc">
                          <button
                            className="btn-ghost"
                            disabled={rows.length === 0}
                            onClick={() => setConfirmTools(true)}
                          >
                            {plural("settings.storage.clearTools", rows.length, {
                              size: formatSize(bytes),
                            })}
                          </button>
                        </div>
                      </div>
                    );
                  })()}
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
              ) : storageStale ? (
                // A first measurement that FAILED leaves `storage` null, so
                // the loading line below would sit there permanently — a
                // spinner for work that is not happening. storageStale is the
                // signal that the attempt finished and lost.
                <p className="banner error" role="alert">
                  {t("settings.storage.failed")}
                </p>
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
                  <>
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
                  {/* Arming is a second decision, so it needs a second
                      control. Declining at pair time used to be final: the
                      consent is stored per host and re-read on every launch,
                      and nothing in the UI could ever change it — a user who
                      later wanted cloud generation on their GPU box had to
                      unpair and pair again to be re-asked. */}
                  {remoteEngine && !remoteKeysArmed && anyKeyStored && (
                    <div className="provider-row">
                      <div className="grow">
                        <div className="name">{t("settings.remote.armHeading")}</div>
                        <div className="meta">
                          {t("settings.remote.armHint", { keys: storedKeyLabels.join(", ") })}
                        </div>
                      </div>
                      <button
                        className="btn-ghost"
                        disabled={armBusy}
                        onClick={() => {
                          setArmBusy(true);
                          setPairError(null);
                          void armRemoteKeys()
                            .then(setPairError)
                            .finally(() => setArmBusy(false));
                        }}
                      >
                        {armBusy ? t("settings.remote.arming") : t("settings.remote.arm")}
                      </button>
                    </div>
                  )}
                  {remoteEngine && remoteKeysArmed && anyKeyStored && (
                    <p className="hint">{t("settings.remote.armed")}</p>
                  )}
                  </>
                ) : pairPreview ? (
                  /* Review before trust. The code is decoded but nothing has
                     been sent yet: the host, its certificate fingerprint and
                     the exact keys at stake are all on screen first. */
                  <div className="pair-review">
                    <dl className="kv">
                      <dt>{t("settings.remote.reviewHost")}</dt>
                      <dd>
                        <code>{pairPreview.url}</code>
                      </dd>
                      {pairPreview.fingerprint && (
                        <>
                          <dt>{t("settings.remote.reviewFingerprint")}</dt>
                          <dd>
                            <code className="fingerprint">{pairPreview.fingerprint}</code>
                          </dd>
                        </>
                      )}
                    </dl>
                    <p className="hint">{t("settings.remote.reviewVerify")}</p>
                    {storedKeyNames.length > 0 && (
                      <label className="hint arm-keys">
                        <input
                          type="checkbox"
                          checked={armKeys}
                          onChange={(event) => setArmKeys(event.target.checked)}
                        />
                        {t("settings.remote.reviewArmKeys", {
                          host: pairPreview.host ?? "",
                          keys: storedKeyNames.join(", "),
                        })}
                      </label>
                    )}
                    <div className="provider-row">
                      <button
                        className="btn-ghost"
                        disabled={pairBusy}
                        onClick={() => {
                          setPairPreview(null);
                          setArmKeys(false);
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        className="btn-primary"
                        disabled={pairBusy}
                        onClick={() => confirmPairing(armKeys)}
                      >
                        {pairBusy
                          ? t("settings.remote.pairing")
                          : t("settings.remote.reviewConfirm")}
                      </button>
                    </div>
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
                      {pairBusy ? t("settings.remote.checking") : t("settings.remote.pair")}
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
                  {assemblyUnrouted && (
                    <p className="banner error" role="alert">
                      {t("settings.backends.noFfmpeg")}
                    </p>
                  )}
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
          // This list carries quick tool sessions too, and a project's copy
          // overstates what a one-off output costs to delete: there is no
          // cut to lose and usually no job to cancel.
          title={t(
            isToolSession(confirmProject.id) ? "home.deleteToolTitle" : "home.deleteTitle",
            { title: confirmProject.title },
          )}
          message={t(
            isToolSession(confirmProject.id) ? "home.deleteToolMessage" : "home.deleteMessage",
          )}
          confirmLabel={t(
            isToolSession(confirmProject.id) ? "home.deleteToolConfirm" : "home.deleteConfirm",
          )}
          danger
          onConfirm={() => {
            const target = confirmProject;
            setConfirmProject(null);
            // deleteProject RETURNS the failure message; discarding it left a
            // failed delete completely silent — the project reappeared in the
            // list on the next refresh with nothing said about why.
            void deleteProject(target.id)
              .then((error) => {
                setStorageError(error);
                return refreshStorage();
              })
              .catch((err) => setStorageError(err instanceof Error ? err.message : String(err)));
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
            setStorageError(null);
            // cleanupStorage resolves to null when the purge failed. Dropping
            // that left a failed purge completely silent: the numbers simply
            // did not move, with nothing said about why.
            void cleanupStorage()
              .then((freed) => {
                if (freed === null) setStorageError(t("settings.storage.clearCacheFailed"));
              })
              .catch((err) => setStorageError(err instanceof Error ? err.message : String(err)));
          }}
          onCancel={() => setConfirmCache(false)}
        />
      )}
      {confirmTools && (
        <ConfirmDialog
          title={t("settings.storage.clearToolsTitle")}
          message={t("settings.storage.clearToolsMessage")}
          confirmLabel={t("settings.storage.clearToolsConfirm")}
          danger
          onConfirm={() => {
            setConfirmTools(false);
            setStorageError(null);
            void deleteToolSessions()
              .then((error) => {
                setStorageError(error);
                return refreshStorage();
              })
              .catch((err) => setStorageError(err instanceof Error ? err.message : String(err)));
          }}
          onCancel={() => setConfirmTools(false)}
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
