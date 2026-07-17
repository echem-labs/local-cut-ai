/**
 * Main-process HTTP to the engine. The renderer's requests ride Chromium
 * (where `certificate-error` handles pinning); the shell's own calls
 * (health checks, provider-key PUTs) go through Node, so the self-signed
 * remote certificate must be pinned here explicitly: verification is
 * BY FINGERPRINT — matching pin passes, anything else fails, CA validity
 * is irrelevant either way.
 */
import http from "node:http";
import https from "node:https";
import type { PeerCertificate } from "node:tls";

export interface EngineTarget {
  url: string;
  token: string;
  fingerprint?: string;
}

export interface EngineResponse {
  status: number;
  body: string;
}

export function engineRequest(
  target: EngineTarget,
  path: string,
  init?: { method?: string; body?: string },
): Promise<EngineResponse> {
  const url = new URL(path, `${target.url}/`);
  const secure = url.protocol === "https:";
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
              // Pin, don't chain: the engine's certificate is self-signed by
              // design, so CA verification is off and identity is decided
              // during the handshake — before any request byte (or the
              // bearer token) leaves this process.
              rejectUnauthorized: false,
              checkServerIdentity: (_host: string, cert: PeerCertificate) => {
                const fingerprint = (cert.fingerprint256 ?? "")
                  .replace(/:/g, "")
                  .toLowerCase();
                return target.fingerprint && fingerprint === target.fingerprint
                  ? undefined
                  : new Error(
                      "engine certificate does not match the pairing — re-pair the engine",
                    );
              },
            }
          : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    if (init?.body) request.write(init.body);
    request.end();
  });
}
