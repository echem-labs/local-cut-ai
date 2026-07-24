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
import { readJson, writeJsonAtomic } from "./store-file";

export interface RemotePairing {
  url: string;
  token: string;
  fingerprint?: string;
  // The engine's exact certificate (PEM), captured and fingerprint-verified
  // at pair time, then pinned for every request. Absent until captured.
  cert?: string;
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
  // http is only safe to loopback: a local engine, or an SSH-forwarded remote
  // that terminates on localhost. A cleartext link to any other host would put
  // the bearer token and every provider key on the wire with no TLS pinning to
  // stop a MITM — the entire pinning protection would be bypassed. Refuse it.
  // parsed.hostname keeps the IPv6 brackets ("[::1]"); strip them so an
  // IPv6-loopback (e.g. an SSH-forwarded remote) is recognised as loopback.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = ["localhost", "127.0.0.1", "::1"];
  if (parsed.protocol === "http:" && !loopback.includes(host)) {
    throw new Error("a remote engine must use https — pair over TLS, not cleartext http");
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
    const raw = readJson<Record<string, unknown>>(this.file);
    if (!raw || typeof raw.url !== "string" || typeof raw.token !== "string") return null;
    return {
      url: raw.url,
      token: raw.token,
      fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : undefined,
      cert: typeof raw.cert === "string" ? raw.cert : undefined,
    };
  }

  /** Is a pairing on disk, regardless of whether the engine is reachable?
   * The UI needs this to always offer Disconnect for a dead remote. */
  exists(): boolean {
    return fs.existsSync(this.file);
  }

  save(pairing: RemotePairing): void {
    // Atomic: a torn write here loses the token AND the pinned certificate
    // in one shot, and re-pairing needs a code from the other machine.
    writeJsonAtomic(this.file, pairing);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
