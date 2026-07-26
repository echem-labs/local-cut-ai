/**
 * The shell's own HTTP to the engine, against a real loopback server.
 *
 * `engineRequest` is the only path that puts the engine bearer token — and,
 * on the provider-key PUT, the user's Anthropic/OpenAI/Gemini/fal keys — onto
 * a socket. The tests that matter are therefore about what it refuses to send
 * and how much it is willing to read back.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineRequest } from "./request";

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: string;
let received: Received[];
let connections: number;
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  received = [];
  connections = 0;
  respond = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(req, res);
    });
  });
  server.on("connection", () => (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // The global agent keeps connections alive, so close() alone would hang
  // until the socket idles out.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("plain http to a local engine", () => {
  it("authenticates every request and joins the path onto the base url", async () => {
    const response = await engineRequest({ url: base, token: "t0ken" }, "projects");

    expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.url).toBe("/projects");
    expect(received[0]!.headers.authorization).toBe("Bearer t0ken");
    // No body, so no content-type — a GET that declares JSON it did not send.
    expect(received[0]!.headers["content-type"]).toBeUndefined();
  });

  it("sends a body as JSON", async () => {
    await engineRequest({ url: base, token: "t" }, "providers/keys", {
      method: "PUT",
      body: JSON.stringify({ anthropic_key: "sk-ant" }),
    });

    expect(received[0]!.method).toBe("PUT");
    expect(received[0]!.headers["content-type"]).toBe("application/json");
    expect(received[0]!.body).toBe('{"anthropic_key":"sk-ant"}');
  });

  it("returns a failing status rather than throwing", async () => {
    // Callers distinguish 401 (bad pairing token) from a transport failure;
    // collapsing both into a rejection would lose that.
    respond = (_req, res) => {
      res.writeHead(401);
      res.end("unauthorized");
    };
    await expect(engineRequest({ url: base, token: "t" }, "projects")).resolves.toEqual({
      status: 401,
      body: "unauthorized",
    });
  });

  it("decodes multi-byte characters that straddle chunk boundaries", async () => {
    // The body is concatenated as Buffers and decoded once, so a character
    // split across two TCP reads survives; decoding per chunk would replace it.
    const text = `{"name":"${"é".repeat(200_000)}"}`;
    respond = (_req, res) => {
      res.writeHead(200);
      res.end(text);
    };
    const response = await engineRequest({ url: base, token: "t" }, "projects");
    expect(response.body).toBe(text);
  });
});

describe("https without a pinned certificate", () => {
  it("refuses, without opening a connection", async () => {
    // The refusal has to happen before the socket: the token is in a header,
    // so a request that starts and then fails verification has already offered
    // the secret to whatever answered.
    const httpsBase = base.replace("http://", "https://");
    await expect(engineRequest({ url: httpsBase, token: "t" }, "projects")).rejects.toThrow(
      /not pinned yet/,
    );
    expect(connections).toBe(0);
    expect(received).toEqual([]);
  });
});

describe("response size cap", () => {
  it("aborts a body larger than the 8 MiB ceiling", async () => {
    // This call is awaited before the first window opens, so an unbounded
    // response means the app grows until it is OOM-killed, showing nothing.
    respond = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(9 * 1024 * 1024, 0x61));
    };
    // Reduced to a string before asserting: `.rejects.toThrow` prints the
    // resolved value on failure, and here that is nine megabytes of "a" — a
    // regression would be unreadable in the log it produces.
    const outcome = await engineRequest({ url: base, token: "t" }, "projects").then(
      (response) => `resolved with ${response.body.length} bytes`,
      (error: Error) => error.message,
    );
    expect(outcome).toMatch(/response too large/);
  });

  it("accepts a body just under it", async () => {
    const size = 8 * 1024 * 1024 - 16;
    respond = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(size, 0x61));
    };
    const response = await engineRequest({ url: base, token: "t" }, "projects");
    expect(response.body).toHaveLength(size);
  });
});
