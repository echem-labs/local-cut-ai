/**
 * Main-process HTTP to the engine. The renderer's requests ride Chromium
 * (pinned in main.ts's `certificate-error` handler); the shell's own calls
 * (health checks, provider-key PUTs) go through Node here.
 *
 * Pinning a self-signed cert in Node is NOT done with `checkServerIdentity`
 * — that hook only runs after CA-chain verification succeeds, which it never
 * does for a self-signed cert, so with `rejectUnauthorized:false` it is
 * skipped entirely and nothing is checked. Instead we capture the engine's
 * exact certificate once at pair time (verifying its fingerprint against the
 * trusted pairing code), then pass that PEM as the sole `ca`. Every later
 * request runs full verification against that one cert — real pinning, so an
 * on-path attacker presenting any other cert is rejected before the bearer
 * token or any provider key leaves this process.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export interface EngineTarget {
  url: string;
  token: string;
  fingerprint?: string;
  cert?: string; // pinned PEM, captured at pair time
}

export interface EngineResponse {
  status: number;
  body: string;
}

/** Engine replies are small JSON documents; anything larger is a wedged or
 * hostile server, not a response worth buffering. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const derToPem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join(
    "\n",
  )}\n-----END CERTIFICATE-----\n`;

/**
 * Open a bare TLS handshake to the engine (no request bytes, no token),
 * capture its leaf certificate, and confirm its SHA-256 fingerprint equals
 * the one carried by the trusted pairing code. Returns the certificate as
 * PEM to pin. Rejects on any mismatch — so a MITM's cert is caught before a
 * single authenticated byte is sent.
 */
export function capturePinnedCert(target: EngineTarget): Promise<string> {
  const url = new URL(target.url);
  // URL.hostname keeps IPv6 brackets ("[::1]") which tls.connect can't resolve,
  // and url.port is "" for a default-port URL — normalize both so capture
  // accepts every target the request path (https.request) would.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || 443;
  // SNI with an IP literal is disallowed by RFC 6066 (Node warns); we pin the
  // exact cert regardless, so omit servername for IP hosts.
  const isIp = net.isIP(host) !== 0;
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        ...(isIp ? {} : { servername: host }),
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        // destroy(), not end(): end() only sends FIN, so the socket stays
        // open (and its 10s timer armed) until the peer closes — and that
        // timer then fires destroy() on a promise that already settled,
        // emitting an error nobody is listening for. Nothing more is read
        // from this connection, so tear it down outright.
        socket.destroy();
        const fingerprint = (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
        if (!cert.raw || !target.fingerprint || fingerprint !== target.fingerprint) {
          reject(new Error("engine certificate does not match the pairing — re-pair the engine"));
          return;
        }
        resolve(derToPem(cert.raw));
      },
    );
    socket.on("error", reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error("engine handshake timed out")));
  });
}

export function engineRequest(
  target: EngineTarget,
  path: string,
  init?: { method?: string; body?: string },
): Promise<EngineResponse> {
  const url = new URL(path, `${target.url}/`);
  const secure = url.protocol === "https:";
  if (secure && !target.cert) {
    // Refuse to send the token over an unpinned TLS channel.
    return Promise.reject(new Error("remote engine certificate is not pinned yet"));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${target.token}` };
  if (init?.body) headers["Content-Type"] = "application/json";

  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(
      url,
      {
        method: init?.method ?? "GET",
        headers,
        ...(secure
          ? {
              // Pin to the captured cert: it becomes the only trusted CA, so
              // verification passes iff the engine presents that exact cert.
              // Hostname is irrelevant once the cert itself is pinned.
              ca: [target.cert as string],
              checkServerIdentity: () => undefined,
            }
          : {}),
      },
      (response) => {
        // Buffers, not a decoded string: the cap is in BYTES, and a utf8
        // string's .length counts UTF-16 code units — 8 Mi of those is up to
        // 24 MB off the wire for 3-byte characters. Decoding once at the end
        // also can't split a multi-byte character across chunks.
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          // Cap the body: setTimeout below is an INACTIVITY timer, so a
          // server that trickles bytes forever never trips it. This call is
          // awaited before the first window opens, so an unbounded response
          // means the app grows until it is OOM-killed, showing nothing.
          if (size + chunk.length > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("engine response too large"));
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    // Bound the request: a half-open remote (SYN-ACK then silence, or a wedged
    // engine) would otherwise never fire 'error' and leave this promise — and
    // the whenReady pairing/health call awaiting it — pending forever.
    request.setTimeout(30_000, () => request.destroy(new Error("engine request timed out")));
    if (init?.body) request.write(init.body);
    request.end();
  });
}
