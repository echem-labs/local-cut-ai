/**
 * Provider API keys at rest.
 *
 * Two things are being defended here and they pull against each other. The
 * keys must survive every operation that does not deliberately remove them —
 * losing one means the user goes and re-issues it at the provider. And the
 * "encrypted" badge shown in Settings must be true, or it tells someone their
 * keys are keychain-protected when a text editor would recover them.
 *
 * The stub's safeStorage seals with a keychain identity, so a rotated OS
 * keychain (new machine, reset login keyring) is reproducible here: change
 * `state.keychainId` between the write and the read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderKeyStore } from "./keys";
import { isSealed, resetElectron, safeStorage, state } from "./test/electron-stub";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localcut-keys-"));
  resetElectron();
  state.userData = dir;
  // keys.ts warns on unreadable blobs; the warnings are asserted where they
  // matter and silenced everywhere else so a failure is legible.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetElectron();
});

/** The blobs exactly as they sit on disk. */
const onDisk = (): { encrypted: boolean; keys: Record<string, string> } =>
  JSON.parse(fs.readFileSync(path.join(dir, "provider-keys.json"), "utf8"));

/** Run `fn` as if this were `platform`. */
function withPlatform(platform: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("storing and loading", () => {
  it("round-trips keys through the keychain", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant", openai: "sk-oai" });

    expect(store.load()).toEqual({ anthropic: "sk-ant", openai: "sk-oai" });
    // Plaintext must never reach the file.
    const raw = fs.readFileSync(path.join(dir, "provider-keys.json"), "utf8");
    expect(raw).not.toContain("sk-ant");
    expect(isSealed(onDisk().keys.anthropic!)).toBe(true);
  });

  it("round-trips keys with no keychain available", () => {
    state.encryptionAvailable = false;
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });

    expect(store.load()).toEqual({ anthropic: "sk-ant" });
    expect(onDisk().encrypted).toBe(false);
    expect(isSealed(onDisk().keys.anthropic!)).toBe(false);
  });

  it("reports no keys before anything is stored", () => {
    const store = new ProviderKeyStore();
    expect(store.load()).toEqual({});
    expect(store.presence()).toMatchObject({
      anthropic: false,
      openai: false,
      gemini: false,
      fal: false,
    });
  });

  it("removes a key when given an empty string, and leaves the others", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant", openai: "sk-oai" });
    store.set({ anthropic: "" });

    expect(store.load()).toEqual({ openai: "sk-oai" });
    expect(store.presence()).toMatchObject({ anthropic: false, openai: true });
    expect(onDisk().keys).not.toHaveProperty("anthropic");
  });

  it("ignores providers the update does not mention", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    store.set({ openai: "sk-oai" });
    expect(store.load()).toEqual({ anthropic: "sk-ant", openai: "sk-oai" });
  });
});

describe("a keychain that can no longer open its own blobs", () => {
  it("keeps untouched blobs byte-for-byte instead of re-encrypting them", () => {
    // Decrypting every stored key just to re-encrypt it would silently drop
    // every key the keychain can no longer read — a rotated keyring would take
    // the whole set with it, on a write that only meant to add one key.
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant", openai: "sk-oai" });
    const before = onDisk().keys;

    state.keychainId = "keychain-2"; // the login keyring was reset
    store.set({ gemini: "sk-gem" });

    const after = onDisk().keys;
    expect(after.anthropic).toBe(before.anthropic);
    expect(after.openai).toBe(before.openai);
  });

  it("skips the unreadable keys on load rather than failing startup", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    state.keychainId = "keychain-2";
    store.set({ gemini: "sk-gem" });

    expect(store.load()).toEqual({ gemini: "sk-gem" });
    // Still listed as present: the blob is on disk and may become readable
    // again (the original keychain), so the UI must not claim it is gone.
    expect(store.presence()).toMatchObject({ anthropic: true, gemini: true });
  });
});

describe("switching encryption mode", () => {
  it("re-encodes every blob so the file never mixes sealed and plain", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    expect(isSealed(onDisk().keys.anthropic!)).toBe(true);

    state.encryptionAvailable = false; // ran on a box with no keyring
    store.set({ openai: "sk-oai" });

    const { encrypted, keys } = onDisk();
    expect(encrypted).toBe(false);
    expect(isSealed(keys.anthropic!)).toBe(false);
    expect(isSealed(keys.openai!)).toBe(false);
    expect(store.load()).toEqual({ anthropic: "sk-ant", openai: "sk-oai" });
  });

  it("drops only the blobs it cannot re-encode, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });

    // Keychain rotated AND gone: the old blob is unrecoverable, and the file
    // is changing mode, so it cannot simply be carried over as-is either.
    state.keychainId = "keychain-2";
    state.encryptionAvailable = false;
    store.set({ openai: "sk-oai" });

    expect(store.load()).toEqual({ openai: "sk-oai" });
    expect(onDisk().keys).not.toHaveProperty("anthropic");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropping anthropic key"),
      expect.anything(),
    );
  });
});

describe("the encrypted badge the UI shows", () => {
  it("is false when there is no keychain at all", () => {
    state.encryptionAvailable = false;
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    expect(store.presence().encrypted).toBe(false);
  });

  it("is true on macOS and Windows whenever safeStorage is available", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    withPlatform("darwin", () => expect(store.presence().encrypted).toBe(true));
    withPlatform("win32", () => expect(store.presence().encrypted).toBe(true));
  });

  it.each(["basic_text", "unknown"])(
    "is false on Linux behind the %s backend, which is not a keychain",
    (backend) => {
      // Chromium reports isEncryptionAvailable() === true for basic_text, which
      // "encrypts" with a hardcoded password. Anyone who can read the file can
      // recover the keys, so promising the user a keychain would be a lie.
      const store = new ProviderKeyStore();
      store.set({ anthropic: "sk-ant" });
      state.storageBackend = backend;
      withPlatform("linux", () => expect(store.presence().encrypted).toBe(false));
    },
  );

  it("is true on Linux behind a real secret service", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    state.storageBackend = "gnome_libsecret";
    withPlatform("linux", () => expect(store.presence().encrypted).toBe(true));
  });

  it("is false on Linux when the backend cannot be determined", () => {
    const store = new ProviderKeyStore();
    store.set({ anthropic: "sk-ant" });
    // Electron throws here on platforms that have no backend concept.
    vi.spyOn(safeStorage, "getSelectedStorageBackend").mockImplementation(() => {
      throw new Error("no backend");
    });
    withPlatform("linux", () => expect(store.presence().encrypted).toBe(false));
  });
});
