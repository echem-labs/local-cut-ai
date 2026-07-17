/**
 * Remote engine pairing — the persisted half of "laptop drives the GPU box".
 * A pairing is the decoded engine pairing code: where to dial, the bearer
 * token, and (for HTTPS) the self-signed certificate's SHA-256 fingerprint
 * to pin. Stored as plain JSON in userData: the token is a capability for
 * the user's own engine, not a third-party secret, and the OS user account
 * is the trust boundary — same posture as an SSH known_hosts + key file.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface RemotePairing {
  url: string;
  token: string;
  fingerprint?: string;
}

/** Decode and validate a pairing code (base64url JSON printed by
 * `localcut-engine serve --host …`). Throws with a user-facing message. */
export function parsePairingCode(code: string): RemotePairing {
  let payload: unknown;
  try {
    const trimmed = code.trim();
    const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
    payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    throw new Error("that doesn't look like a pairing code — copy the whole line");
  }
  const record = payload as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : "";
  const token = typeof record.token === "string" ? record.token : "";
  const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("pairing code carries no usable engine URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("pairing code carries no usable engine URL");
  }
  if (!token) throw new Error("pairing code carries no token");
  if (parsed.protocol === "https:" && !/^[0-9a-f]{64}$/.test(fingerprint ?? "")) {
    throw new Error("pairing code is missing the certificate fingerprint");
  }
  return { url: url.replace(/\/+$/, ""), token, fingerprint };
}

export class RemoteEngineStore {
  private get file(): string {
    return path.join(app.getPath("userData"), "remote-engine.json");
  }

  load(): RemotePairing | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (typeof raw.url !== "string" || typeof raw.token !== "string") return null;
      return {
        url: raw.url,
        token: raw.token,
        fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : undefined,
      };
    } catch {
      return null;
    }
  }

  save(pairing: RemotePairing): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(pairing, null, 2), { mode: 0o600 });
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
