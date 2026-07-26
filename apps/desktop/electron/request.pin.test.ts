/**
 * How the pairing handshake is torn down.
 *
 * `capturePinnedCert` opens a bare TLS connection, reads the leaf
 * certificate, and is finished with the socket — it never sends a request or
 * reads a byte of body. It half-closed with `end()`, which only sends FIN:
 * the socket stayed open until the engine closed its side, and the 10-second
 * timer armed by `setTimeout` stayed armed with it. When that timer fired it
 * called `destroy(new Error("engine handshake timed out"))` on a promise that
 * had already settled — a spurious error on a connection nobody was using,
 * and one held-open socket per pair attempt in the meantime.
 *
 * Node clears a socket's timeout inside `_destroy`, so destroying is what
 * disarms it; `end()` does not. That is the whole distinction under test, and
 * a real handshake cannot show it without checking a private key into a
 * public repo — so the seam is `node:tls` itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FINGERPRINT = "ab12cd34";
const RAW = Buffer.from("a certificate");

interface FakeSocket {
  getPeerCertificate: () => { fingerprint256: string; raw: Buffer | null };
  on: (event: string, handler: (err: Error) => void) => void;
  setTimeout: (ms: number, handler: () => void) => void;
  destroy: (err?: Error) => void;
  end: () => void;
}

const calls = vi.hoisted(() => ({
  order: [] as string[],
  timeoutMs: 0,
  /** Swapped per test to vary what the "engine" presents. */
  cert: { fingerprint256: "AB:12:CD:34", raw: null as Buffer | null },
}));

vi.mock("node:tls", () => ({
  default: {
    connect: (_opts: unknown, onSecureConnect: () => void) => {
      const socket: FakeSocket = {
        getPeerCertificate: () => calls.cert,
        on: () => {},
        setTimeout: (ms, _handler) => {
          calls.order.push("setTimeout");
          calls.timeoutMs = ms;
        },
        destroy: () => calls.order.push("destroy"),
        end: () => calls.order.push("end"),
      };
      // Asynchronously, like a real handshake: the caller registers its
      // error listener and arms the timeout before this runs.
      queueMicrotask(onSecureConnect);
      return socket;
    },
  },
}));

const { capturePinnedCert } = await import("./request");

/** No default parameter: `target(undefined)` would silently fall back to it,
 * and the unpinned case is one of the things under test. */
const target = (fingerprint?: string) => ({
  url: "https://192.168.1.50:7830",
  token: "t",
  fingerprint,
});

beforeEach(() => {
  calls.order = [];
  calls.timeoutMs = 0;
  calls.cert = { fingerprint256: "AB:12:CD:34", raw: RAW };
});

describe("capturing the engine certificate", () => {
  it("tears the socket down instead of half-closing it", async () => {
    const pem = await capturePinnedCert(target(FINGERPRINT));

    expect(pem).toContain("BEGIN CERTIFICATE");
    expect(calls.order).toContain("destroy");
    // end() is the regression: it leaves the socket — and the timer armed
    // just before it — alive until the peer closes.
    expect(calls.order).not.toContain("end");
  });

  it("disarms the timeout it armed, by settling after the teardown", async () => {
    await capturePinnedCert(target(FINGERPRINT));

    // The timer is armed first and destroyed while still pending, which is
    // what clears it. If teardown never happened the 10s timer would outlive
    // the settled promise.
    expect(calls.order).toEqual(["setTimeout", "destroy"]);
    expect(calls.timeoutMs).toBe(10_000);
  });

  it("tears down a mismatched certificate too", async () => {
    calls.cert = { fingerprint256: "FF:FF:FF:FF", raw: RAW };

    await expect(capturePinnedCert(target(FINGERPRINT))).rejects.toThrow(
      "does not match the pairing",
    );

    // A MITM's socket must not be the one left open either.
    expect(calls.order).toContain("destroy");
    expect(calls.order).not.toContain("end");
  });

  it("refuses a target with no pinned fingerprint at all", async () => {
    // Belt and braces on the pairing contract: without a fingerprint to
    // compare against there is nothing being pinned.
    await expect(capturePinnedCert(target(undefined))).rejects.toThrow(
      "does not match the pairing",
    );
  });
});
