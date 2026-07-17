import { useCallback, useEffect, useState } from "react";
import type { Provider } from "../api/types";
import { ModelLibrary } from "../components/ModelLibrary";
import { type ProviderKeyId, type ProviderKeyPresence, useApp } from "../store";

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
  const { client, system, closeSettings, resetFirstRun, refreshModels } = useApp();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presence, setPresence] = useState<ProviderKeyPresence | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

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

  return (
    <div className="settings">
      <div className="board-header">
        <button className="btn-ghost" onClick={closeSettings}>
          ← Back
        </button>
        <h1>Settings</h1>
      </div>

      <section>
        <h2>Cloud providers</h2>
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

      <section>
        <h2>Model library</h2>
        <p className="hint">Download more local models any time — jobs pick them up immediately.</p>
        <ModelLibrary showActions />
      </section>

      <section>
        <h2>Engine</h2>
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

      <section>
        <h2>Setup</h2>
        <button className="btn-ghost" onClick={resetFirstRun}>
          Show setup screen again
        </button>
      </section>
    </div>
  );
}
