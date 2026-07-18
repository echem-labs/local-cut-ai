import {
  Boxes,
  Cpu,
  KeyRound,
  RotateCcw,
  Server,
  SunMoon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Provider } from "../api/types";
import { ModelLibrary } from "../components/ModelLibrary";
import { type ProviderKeyId, type ProviderKeyPresence, useApp } from "../store";
import { applyTheme, loadThemePref, type ThemePref } from "../theme";

const SECTION_ICON = { size: 14, strokeWidth: 1.8 } as const;

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

type SettingsTab = "general" | "providers" | "models" | "engine";

const TABS: { id: SettingsTab; label: string; icon: typeof SunMoon }[] = [
  { id: "general", label: "General", icon: SunMoon },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "models", label: "Models", icon: Boxes },
  { id: "engine", label: "Engine", icon: Server },
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
  const [tab, setTab] = useState<SettingsTab>("general");

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
        <h1>Settings</h1>
        <button className="icon-btn" onClick={closeSettings} aria-label="Close settings">
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "active" : ""}
              onClick={() => setTab(entry.id)}
            >
              <Icon size={13} strokeWidth={1.8} />
              {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "general" && (
      <section>
        <h2>
          <SunMoon {...SECTION_ICON} />
          Appearance
        </h2>
        <p className="hint">Dark is the design target for video work; light is fully supported.</p>
        <div className="seg-toggle" role="group" aria-label="Theme" style={{ display: "inline-flex" }}>
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={theme === option.value ? "active" : ""}
              onClick={() => {
                setTheme(option.value);
                applyTheme(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>
      )}

      {tab === "providers" && (
      <section>
        <h2>
          <KeyRound {...SECTION_ICON} />
          Cloud providers
        </h2>
        <p className="hint">
          Bring your own keys: they live in your OS keychain, go only to your engine, and are
          never sent to us.
        </p>
        {presence && !presence.encrypted && (
          <div className="banner warning">
            No OS keychain available — keys are stored obfuscated only.
          </div>
        )}
        {keyError && <div className="banner error">{keyError}</div>}
        {providers.length === 0 && (
          <p className="hint">Engine unavailable — provider status unknown.</p>
        )}
        {providers.map((provider) => (
          <div className="provider-row" key={provider.id}>
            <div className="grow">
              <div className="name">{provider.label}</div>
              <div className="meta">{provider.capabilities.join(", ")}</div>
            </div>
            <span className={`badge${provider.configured ? " ok" : ""}`}>
              {provider.configured ? "configured" : "no key"}
            </span>
            <input
              type="password"
              placeholder="Paste API key…"
              value={drafts[provider.id] ?? ""}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveKey(provider.id);
              }}
              aria-label={`${provider.label} API key`}
            />
            <button
              className="btn-primary"
              onClick={() => void saveKey(provider.id)}
              disabled={busy !== null || !(drafts[provider.id] ?? "").trim()}
            >
              {busy === provider.id ? "Saving…" : "Save"}
            </button>
            <button
              className="btn-ghost"
              onClick={() => void clearKey(provider.id)}
              disabled={busy !== null || !(provider.configured || presence?.[KEY_IDS[provider.id]])}
            >
              Clear
            </button>
          </div>
        ))}
      </section>
      )}

      {tab === "models" && (
      <section>
        <h2>
          <Boxes {...SECTION_ICON} />
          Model library
        </h2>
        <p className="hint">Download more local models any time — jobs pick them up immediately.</p>
        <ModelLibrary showActions />
      </section>
      )}

      {tab === "engine" && (
      <>
      <section>
        <h2>
          <Server {...SECTION_ICON} />
          Remote engine
        </h2>
        <p className="hint">
          Run <code>localcut-engine serve --host 0.0.0.0 --token …</code> on a GPU box, then
          paste its pairing code here — this laptop becomes the remote control. Projects and
          renders live with the engine.
        </p>
        {remotePaired ? (
          <div className="provider-row">
            <div className="grow">
              <div className="name">
                {remoteEngine
                  ? `Paired with ${client?.baseUrl ?? "remote engine"}`
                  : "Paired with a remote engine (currently unreachable)"}
              </div>
              <div className="meta">
                {remoteEngine
                  ? "All generation runs on the remote engine."
                  : "Disconnect to fall back to the local engine."}
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
              {pairBusy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="provider-row">
            <input
              placeholder="Paste pairing code…"
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitPairing();
              }}
              aria-label="Pairing code"
            />
            <button
              className="btn-primary"
              disabled={pairBusy || !pairingCode.trim()}
              onClick={submitPairing}
            >
              {pairBusy ? "Pairing…" : "Pair"}
            </button>
          </div>
        )}
        {pairError && <div className="banner error">{pairError}</div>}
      </section>

      <section>
        <h2>
          <Cpu {...SECTION_ICON} />
          Engine
        </h2>
        <dl className="kv">
          <dt>Engine URL</dt>
          <dd>{client?.baseUrl ?? "not connected"}</dd>
          <dt>Backend mode</dt>
          <dd>{system?.backend_mode ?? "—"}</dd>
          <dt>Hardware</dt>
          <dd>
            {system
              ? `Tier ${system.hardware.tier} · ${
                  gpu ? `${gpu.name} (${gpu.vram_gb} GB VRAM)` : "no GPU detected"
                }`
              : "—"}
          </dd>
        </dl>
      </section>
      </>
      )}

      {tab === "general" && (
      <section>
        <h2>
          <RotateCcw {...SECTION_ICON} />
          Setup
        </h2>
        <button className="btn-ghost" onClick={resetFirstRun}>
          Show setup screen again
        </button>
      </section>
      )}
    </div>
  );
}
