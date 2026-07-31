/**
 * Pairing-code parsing and the pairing store.
 *
 * `parsePairingCode` is the app's trust boundary for remote engines: whatever
 * it returns is what the shell then pins a certificate against and hands a
 * bearer token to. Everything it refuses is refused for a reason that costs a
 * secret when it stops being refused, so each rejection has a test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePairingCode, RemoteEngineStore } from "./remote";
import { resetElectron, state } from "./test/electron-stub";

/** A pairing code the way `localcut serve --host …` prints it:
 * base64url of the JSON payload, with the `=` padding stripped. */
const codeFor = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url").replace(/=+$/, "");

const FINGERPRINT = "a".repeat(64);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localcut-remote-"));
  resetElectron();
  state.userData = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetElectron();
});

describe("parsePairingCode", () => {
  it("decodes the code the engine prints, padding and all", () => {
    const pairing = parsePairingCode(
      codeFor({ url: "https://gpu.local:7830", token: "t0ken", fingerprint: FINGERPRINT }),
    );
    expect(pairing).toEqual({
      url: "https://gpu.local:7830",
      token: "t0ken",
      fingerprint: FINGERPRINT,
    });
  });

  it("tolerates surrounding whitespace from a copy-paste", () => {
    const code = codeFor({ url: "https://gpu.local:7830", token: "t", fingerprint: FINGERPRINT });
    expect(parsePairingCode(`  ${code}\n`).token).toBe("t");
  });

  it("strips trailing slashes so the url joins cleanly with request paths", () => {
    const pairing = parsePairingCode(
      codeFor({ url: "https://gpu.local:7830//", token: "t", fingerprint: FINGERPRINT }),
    );
    expect(pairing.url).toBe("https://gpu.local:7830");
  });

  it("takes only url, token and fingerprint — never cert or armKeys", () => {
    // Both of these would be catastrophic to honour. `cert` is what the shell
    // pins; accepting one from the code means an attacker pins their own
    // certificate and the capture step never runs. `armKeys` is the user's
    // consent to ship every stored provider key to the host the code names —
    // it is granted in the UI, and must not be grantable by the code itself.
    const pairing = parsePairingCode(
      codeFor({
        url: "https://evil.example:7830",
        token: "t",
        fingerprint: FINGERPRINT,
        cert: "-----BEGIN CERTIFICATE-----\nattacker\n-----END CERTIFICATE-----\n",
        armKeys: true,
      }),
    );
    expect(pairing).not.toHaveProperty("cert");
    expect(pairing).not.toHaveProperty("armKeys");
  });

  it.each([
    ["not base64 at all", "!!! not a code !!!"],
    ["base64 of something that is not JSON", Buffer.from("hello").toString("base64url")],
    ["an empty string", ""],
  ])("refuses %s", (_label, code) => {
    expect(() => parsePairingCode(code)).toThrow(/doesn't look like a pairing code/);
  });

  it.each([
    ["no url field", { token: "t", fingerprint: FINGERPRINT }],
    ["a url that does not parse", { url: "gpu.local:7830", token: "t" }],
    ["a non-http scheme", { url: "ftp://gpu.local/", token: "t" }],
    ["a file url", { url: "file:///etc/passwd", token: "t" }],
  ])("refuses %s", (_label, payload) => {
    expect(() => parsePairingCode(codeFor(payload))).toThrow(/no usable engine URL/);
  });

  it("refuses cleartext http to a remote host", () => {
    // http to anywhere but loopback puts the bearer token and every provider
    // key on the wire with no pinning to stop a MITM — the entire pinning
    // protection would be bypassed by a code that simply asks for http.
    expect(() => parsePairingCode(codeFor({ url: "http://gpu.local:7830", token: "t" }))).toThrow(
      /must use https/,
    );
  });

  it.each(["http://localhost:7830", "http://127.0.0.1:7830", "http://[::1]:7830"])(
    "allows cleartext http to %s (a local or SSH-forwarded engine)",
    (url) => {
      expect(parsePairingCode(codeFor({ url, token: "t" })).token).toBe("t");
    },
  );

  it("refuses a code with no token", () => {
    expect(() =>
      parsePairingCode(codeFor({ url: "https://gpu.local", fingerprint: FINGERPRINT })),
    ).toThrow(/no token/);
  });

  it.each([
    ["absent", undefined],
    ["too short", "abc123"],
    ["not hex", "z".repeat(64)],
    ["the wrong length", "a".repeat(63)],
  ])("refuses https with a fingerprint that is %s", (_label, fingerprint) => {
    // Without a fingerprint there is nothing to verify the captured
    // certificate against, so pinning would pin whatever answered.
    expect(() =>
      parsePairingCode(codeFor({ url: "https://gpu.local", token: "t", fingerprint })),
    ).toThrow(/missing the certificate fingerprint/);
  });

  it("does not require a fingerprint for a loopback http engine", () => {
    // Nothing to pin on a cleartext link that never leaves the machine.
    expect(parsePairingCode(codeFor({ url: "http://127.0.0.1:7830", token: "t" }))).toEqual({
      url: "http://127.0.0.1:7830",
      token: "t",
      fingerprint: undefined,
    });
  });
});

describe("RemoteEngineStore", () => {
  it("round-trips a pairing including the pinned certificate", () => {
    const store = new RemoteEngineStore();
    const pairing = {
      url: "https://gpu.local:7830",
      token: "t",
      fingerprint: FINGERPRINT,
      cert: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n",
      armKeys: true,
    };
    store.save(pairing);
    expect(store.load()).toEqual(pairing);
    expect(store.exists()).toBe(true);
  });

  it("reports no pairing before anything is saved", () => {
    const store = new RemoteEngineStore();
    expect(store.load()).toBeNull();
    expect(store.exists()).toBe(false);
  });

  it.each([
    ["a missing token", { url: "https://gpu.local" }],
    ["a missing url", { token: "t" }],
    ["a non-string url", { url: 7830, token: "t" }],
  ])("treats a file with %s as no pairing", (_label, raw) => {
    fs.writeFileSync(path.join(dir, "remote-engine.json"), JSON.stringify(raw));
    expect(new RemoteEngineStore().load()).toBeNull();
  });

  it.each([
    ["absent", {}],
    ["a truthy non-true value", { armKeys: "yes" }],
    ["false", { armKeys: false }],
  ])("reads armKeys %s as not agreed", (_label, extra) => {
    // A pairing written before armKeys existed, or by anything other than the
    // explicit consent path, must re-ask rather than ship the keys.
    fs.writeFileSync(
      path.join(dir, "remote-engine.json"),
      JSON.stringify({ url: "https://gpu.local", token: "t", ...extra }),
    );
    expect(new RemoteEngineStore().load()?.armKeys).toBe(false);
  });

  it("clears the pairing, and clearing again is not an error", () => {
    const store = new RemoteEngineStore();
    store.save({ url: "https://gpu.local", token: "t" });
    store.clear();
    expect(store.exists()).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });
});
