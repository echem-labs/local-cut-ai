import {
  Boxes,
  Cpu,
  KeyRound,
  Languages,
  RotateCcw,
  Server,
  SunMoon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Provider } from "../api/types";
import { Dropdown } from "../components/Dropdown";
import { ModelLibrary } from "../components/ModelLibrary";
import { SUPPORTED_LOCALES, t, useLocale } from "../i18n";
import { type ProviderKeyId, type ProviderKeyPresence, useApp } from "../store";
import { applyTheme, loadThemePref, type ThemePref } from "../theme";

const SECTION_ICON = { size: 14, strokeWidth: 1.8 } as const;

const THEME_OPTIONS: { value: ThemePref }[] = [
  { value: "system" },
  { value: "dark" },
  { value: "light" },
];

type SettingsTab = "general" | "providers" | "models" | "engine";

const TABS: { id: SettingsTab; icon: typeof SunMoon }[] = [
  { id: "general", icon: SunMoon },
  { id: "providers", icon: KeyRound },
  { id: "models", icon: Boxes },
  { id: "engine", icon: Server },
];

/** Engine provider ids → shell key ids (google's key is a Gemini key). */
const KEY_IDS: Record<string, ProviderKeyId> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  fal: "fal",
};

/** Settings: BYOK provider keys, the model library, and read-only engine
 * info. Key material flows through the shell (OS keychain → engine), so
 * this screen only ever renders presence and status. */
export function Settings() {
  const {
    client,
    system,
    closeSettings,
    resetFirstRun,
    refreshModels,
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
  const locale = useLocale((state) => state.locale);
  const setLocale = useLocale((state) => state.setLocale);
  const { settingsTab, setSettingsTab } = useApp();
  const tab = (TABS.some((entry) => entry.id === settingsTab) ? settingsTab : "general") as SettingsTab;

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

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>{t("settings.title")}</h1>
        <button className="icon-btn" onClick={closeSettings} aria-label={t("settings.closeAria")}>
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label={t("settings.tablistAria")}>
        {TABS.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "active" : ""}
              onClick={() => setSettingsTab(entry.id)}
            >
              <Icon size={13} strokeWidth={1.8} />
              {t(`settings.tabs.${entry.id}`)}
            </button>
          );
        })}
      </div>

      {tab === "general" && (
      <section>
        <h2>
          <SunMoon {...SECTION_ICON} />
          {t("settings.appearance.heading")}
        </h2>
        <p className="hint">{t("settings.appearance.hint")}</p>
        <div
          className="seg-toggle"
          role="group"
          aria-label={t("settings.appearance.aria")}
          style={{ display: "inline-flex" }}
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
        {/* The language picker earns its slot only once there's a real
            choice — a lone option would be a dead control (doc 09 budget). */}
        {SUPPORTED_LOCALES.length > 1 && (
          <div className="settings-sub">
            <h3>
              <Languages {...SECTION_ICON} />
              {t("settings.language.heading")}
            </h3>
            <p className="hint">{t("settings.language.hint")}</p>
            <Dropdown
              value={locale}
              ariaLabel={t("settings.language.heading")}
              options={SUPPORTED_LOCALES.map((entry) => ({ value: entry.id, label: entry.label }))}
              onChange={setLocale}
            />
          </div>
        )}
      </section>
      )}

      {tab === "providers" && (
      <section>
        <h2>
          <KeyRound {...SECTION_ICON} />
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
        {providers.map((provider) => (
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
            <button
              className="btn-primary"
              onClick={() => void saveKey(provider.id)}
              disabled={busy !== null || !(drafts[provider.id] ?? "").trim()}
            >
              {busy === provider.id ? t("common.saving") : t("common.save")}
            </button>
            <button
              className="btn-ghost"
              onClick={() => void clearKey(provider.id)}
              disabled={busy !== null || !(provider.configured || presence?.[KEY_IDS[provider.id]])}
            >
              {t("common.clear")}
            </button>
          </div>
        ))}
      </section>
      )}

      {tab === "models" && (
      <section>
        <h2>
          <Boxes {...SECTION_ICON} />
          {t("settings.modelLibrary.heading")}
        </h2>
        <p className="hint">{t("settings.modelLibrary.hint")}</p>
        <ModelLibrary showActions />
      </section>
      )}

      {tab === "engine" && (
      <>
      <section>
        <h2>
          <Server {...SECTION_ICON} />
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
                  ? t("settings.remote.pairedMeta")
                  : t("settings.remote.unreachableMeta")}
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
              {pairBusy ? t("settings.remote.disconnecting") : t("settings.remote.disconnect")}
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
          <Cpu {...SECTION_ICON} />
          {t("settings.engine.heading")}
        </h2>
        <dl className="kv">
          <dt>{t("settings.engine.urlLabel")}</dt>
          <dd>{client?.baseUrl ?? t("settings.engine.notConnected")}</dd>
          <dt>{t("settings.engine.backendLabel")}</dt>
          <dd>{system?.backend_mode ?? t("settings.engine.dash")}</dd>
          <dt>{t("settings.engine.hardwareLabel")}</dt>
          <dd>
            {system
              ? t("settings.engine.hardwareValue", {
                  tier: system.hardware.tier,
                  detail: gpu
                    ? t("settings.engine.gpuDetail", { gpu: gpu.name, vram: gpu.vram_gb })
                    : t("settings.engine.noGpu"),
                })
              : t("settings.engine.dash")}
          </dd>
        </dl>
      </section>
      </>
      )}

      {tab === "general" && (
      <section>
        <h2>
          <RotateCcw {...SECTION_ICON} />
          {t("settings.setup.heading")}
        </h2>
        <button className="btn-ghost" onClick={resetFirstRun}>
          {t("settings.setup.showAgain")}
        </button>
      </section>
      )}
    </div>
  );
}
