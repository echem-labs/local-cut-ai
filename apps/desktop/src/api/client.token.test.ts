/**
 * A remote engine's token is whatever the operator generated, and the docs
 * say `openssl rand -base64 32`. That produces 32 random bytes of base64:
 * always a trailing "=", a "/" about half the time, and a "+" about half the
 * time. Every one of those characters is a problem somewhere.
 *
 * Both failures look like the app working. The rest of the UI authenticates
 * over headers and behaves, so a broken event stream reads as "nothing is
 * rendering" and broken media URLs read as "the renders are broken" — not as
 * an auth problem, which is where nobody thought to look.
 */
import { describe, expect, it, vi } from "vitest";

import { EngineClient } from "./client";

/** A token with all three troublesome characters, as `openssl` would give it. */
const TOKEN = "ab+cd/ef=";

const client = () => new EngineClient({ url: "https://gpu-box.local:7830", token: TOKEN });

describe("a token carried in a URL", () => {
  it("is percent-encoded in every media URL", () => {
    // Starlette parses the query with parse_qsl, which decodes "+" as a
    // space: interpolated raw, the engine compares "ab cd/ef=" against the
    // real token and 401s the player.
    const urls = [
      client().artifactUrl("p1", "a".repeat(64)),
      client().voicePreviewUrl("af_heart"),
      client().exportUrl("p1", "fcpxml"),
    ];
    for (const url of urls) {
      expect(url).toContain(`token=${encodeURIComponent(TOKEN)}`);
      expect(url).not.toContain(`token=${TOKEN}`);
      // Round-trips to exactly what the engine will compare against.
      expect(new URL(url).searchParams.get("token")).toBe(TOKEN);
    }
  });

  it("survives a token that is only troublesome characters", () => {
    const odd = new EngineClient({ url: "https://h:1", token: "+/=&? #%" });
    expect(new URL(odd.artifactUrl("p", "h")).searchParams.get("token")).toBe("+/=&? #%");
  });
});

describe("a token carried in the WebSocket subprotocol", () => {
  it("is encoded to characters a subprotocol value allows", async () => {
    // RFC 7230 token characters. "/", "+", "=" and space are all absent, and
    // `new WebSocket()` throws a SyntaxError on any of them.
    const legal = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

    const offered: string[][] = [];
    class FakeSocket {
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      onopen: unknown = null;
      constructor(_url: string, protocols?: string[]) {
        offered.push(protocols ?? []);
        for (const protocol of protocols ?? []) {
          if (!legal.test(protocol)) throw new SyntaxError(`illegal subprotocol: ${protocol}`);
        }
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const stop = client().subscribe(() => {});
    expect(offered).toHaveLength(1);
    const [marker, carried] = offered[0];
    expect(marker).toBe("localcut.bearer.v1");
    expect(carried).toMatch(legal);

    // And it is the real token, not a hash of it: the engine has to be able
    // to compare what it decodes.
    const raw = carried.slice("b64u.".length).replace(/-/g, "+").replace(/_/g, "/");
    expect(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).toBe(TOKEN);

    stop();
    vi.unstubAllGlobals();
  });
});
