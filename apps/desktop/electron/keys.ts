/**
 * Provider API keys at rest — encrypted via safeStorage (OS keychain) and
 * stored as base64 blobs under userData. Plaintext exists only in this
 * process: the renderer sees presence booleans, and the engine receives
 * keys over its authenticated API and holds them in memory only.
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

export const PROVIDER_KEY_IDS = ["anthropic", "openai", "gemini", "fal"] as const;
export type ProviderKeyId = (typeof PROVIDER_KEY_IDS)[number];

export interface KeyPresence {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  fal: boolean;
  encrypted: boolean;
}

interface StoreFile {
  // false = no OS keychain was available; blobs are base64 plaintext only.
  encrypted: boolean;
  keys: Partial<Record<ProviderKeyId, string>>;
}

export class ProviderKeyStore {
  private get file(): string {
    return path.join(app.getPath("userData"), "provider-keys.json");
  }

  private read(): StoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile;
      return { encrypted: Boolean(raw.encrypted), keys: raw.keys ?? {} };
    } catch {
      return { encrypted: safeStorage.isEncryptionAvailable(), keys: {} };
    }
  }

  private write(data: StoreFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  /** Decrypted keys, for pushing to the engine. Never crosses IPC. */
  load(): Partial<Record<ProviderKeyId, string>> {
    const data = this.read();
    const out: Partial<Record<ProviderKeyId, string>> = {};
    for (const id of PROVIDER_KEY_IDS) {
      const blob = data.keys[id];
      if (!blob) continue;
      try {
        out[id] = data.encrypted
          ? safeStorage.decryptString(Buffer.from(blob, "base64"))
          : Buffer.from(blob, "base64").toString("utf8");
      } catch (error) {
        // Keychain changed or blob corrupt — skip rather than fail startup.
        console.warn(`[keys] could not decrypt ${id} key:`, error);
      }
    }
    return out;
  }

  /** Merge updates into the store; an empty string removes that key. All
   * surviving keys are re-encoded under the current encryption mode so the
   * file never mixes encrypted and plaintext blobs. */
  set(updates: Partial<Record<ProviderKeyId, string>>): void {
    const encrypted = safeStorage.isEncryptionAvailable();
    const merged = { ...this.load(), ...updates };
    const keys: Partial<Record<ProviderKeyId, string>> = {};
    for (const id of PROVIDER_KEY_IDS) {
      const value = merged[id];
      if (!value) continue;
      keys[id] = encrypted
        ? safeStorage.encryptString(value).toString("base64")
        : Buffer.from(value, "utf8").toString("base64");
    }
    this.write({ encrypted, keys });
  }

  presence(): KeyPresence {
    const data = this.read();
    return {
      anthropic: Boolean(data.keys.anthropic),
      openai: Boolean(data.keys.openai),
      gemini: Boolean(data.keys.gemini),
      fal: Boolean(data.keys.fal),
      encrypted: data.encrypted,
    };
  }
}
