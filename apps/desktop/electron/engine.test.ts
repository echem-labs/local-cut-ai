/**
 * How the local engine is launched.
 *
 * `spawn` and `fetch` are the two things replaced here; everything else is the
 * real EngineManager. What is being pinned down is the shape of the spawn —
 * where the token travels, which host the child is allowed to bind, and what
 * happens when the port is already taken — because each of those was a defect
 * that produced no error message when it was wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({
  calls: [] as {
    cmd: string;
    args: string[];
    options: Record<string, unknown>;
    child: import("node:events").EventEmitter & { pid?: number };
  }[],
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (cmd: string, args: string[], options: Record<string, unknown> = {}) => {
      const child = new EventEmitter() as import("node:events").EventEmitter & {
        pid?: number;
        stdout: import("node:events").EventEmitter;
        stderr: import("node:events").EventEmitter;
        kill: () => void;
      };
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      spawned.calls.push({ cmd, args, options, child });
      // `run()` (netstat / lsof / taskkill) waits for 'close'; the engine child
      // itself only listens for 'error' and 'exit', so this is inert for it.
      setTimeout(() => child.emit("close", 0), 0);
      return child;
    },
  };
});

const { EngineConflictError, EngineManager } = await import("./engine");

/** /health answers, and /projects accepts our token. */
const healthyEngine = () =>
  vi.fn(async (input: string) => ({
    ok: true,
    status: input.endsWith("/health") ? 200 : 200,
  })) as unknown as typeof fetch;

const envKeys = [
  "LOCALCUT_ENGINE_CMD",
  "LOCALCUT_ENGINE_PORT",
  "LOCALCUT_BACKEND",
  "LOCALCUT_HOST",
  "LOCALCUT_TOKEN",
];
let savedEnv: Record<string, string | undefined>;
// Typed by what is actually read rather than with vitest's MockInstance,
// whose generic arity has moved between versions.
let warnSpy: { mock: { calls: unknown[][] } };
/** Everything logged to console.warn this test, joined. */
const warned = (): string => warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");

beforeEach(() => {
  spawned.calls.length = 0;
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  // killTree signals a process GROUP by negative pid. The fake child reports
  // pid 4242, which on this machine belongs to something real.
  vi.spyOn(process, "kill").mockReturnValue(true);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", healthyEngine());
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

/** Spawns of the engine itself — `stop()` and the orphan check also shell out
 * to taskkill / netstat / lsof through the same mock. */
const engineSpawns = () => spawned.calls.filter((call) => call.args.includes("serve"));
const firstSpawn = () => engineSpawns()[0]!;
/** The engine flags, with the dev-mode `uv run localcut` prefix cut. */
const serveArgs = () => {
  const { args } = firstSpawn();
  return args.slice(args.indexOf("serve"));
};

describe("how the token reaches the engine", () => {
  it("travels in the environment and never on the command line", async () => {
    // A command line is world-readable to every other local process — ps,
    // /proc/<pid>/cmdline, Task Manager — for the engine's whole lifetime.
    const connection = await new EngineManager().start();

    expect(firstSpawn().args).not.toContain("--token");
    expect(firstSpawn().args.join(" ")).not.toContain(connection.token);
    expect(firstSpawn().options.env).toMatchObject({ LOCALCUT_TOKEN: connection.token });
  });

  it("never reaches the app log, which outlives the engine that issued it", async () => {
    // `localcut serve` announces its connection info — token included — on
    // stdout for whoever launched it. Mirroring that verbatim undoes the
    // care taken above: on a packaged macOS/Linux build the main process's
    // console output goes to the system log, so the live bearer token for
    // every project on the machine ends up in a file that outlasts it.
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));

    const connection = await new EngineManager().start();
    const { child } = firstSpawn();
    const stdout = (child as unknown as { stdout: import("node:events").EventEmitter }).stdout;
    const announce = `LOCALCUT_ENGINE {"host": "127.0.0.1", "port": 7830, "token": "${connection.token}"}`;

    // What actually happens: one print(), one chunk, whole line.
    stdout.emit("data", Buffer.from(`${announce}\nINFO: started\n`));
    expect(logged.join("\n")).not.toContain(connection.token);

    // And what a stream is entitled to do instead: the same line delivered in
    // two pieces that divide the token. Buffering to the newline is what
    // keeps this from being a hole in the case above rather than a test of
    // its own — matching per chunk would let exactly this through.
    logged.length = 0;
    const cut = announce.length - 8;
    stdout.emit("data", Buffer.from(announce.slice(0, cut)));
    stdout.emit("data", Buffer.from(`${announce.slice(cut)}\n`));
    expect(logged.join("\n")).not.toContain(connection.token);

    // Still legible: everything but the secret survives.
    expect(logged.join("\n")).toContain("LOCALCUT_ENGINE");
  });

  it("keeps a character that straddles two chunks in one piece", async () => {
    // The token is base64url, so buffering to the newline is enough to
    // redact it — but every OTHER byte sequence on the pipe still has to
    // survive, and decoding each Buffer on its own turns a multi-byte
    // character split across a boundary into replacement characters. What
    // arrives here is a traceback carrying a project title, or the script
    // model's own em-dashed shortfall warning: the text someone is reading
    // precisely because a launch has gone wrong.
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));

    await new EngineManager().start();
    const { child } = firstSpawn();
    const stdout = (child as unknown as { stdout: import("node:events").EventEmitter }).stdout;

    const line = Buffer.from("WARNING: rendering 'café' anyway — lower the target\n");
    const cut = line.indexOf(Buffer.from("é")) + 1; // mid-character
    stdout.emit("data", line.subarray(0, cut));
    stdout.emit("data", line.subarray(cut));

    expect(logged.join("\n")).toContain("café");
    expect(logged.join("\n")).not.toContain("�");

    // And the last line, which has no newline to end it: flushed on `close`
    // rather than `end`, because a force-killed child's pipe is destroyed
    // and never reaches EOF — and that exit is the one whose reason someone
    // is looking for.
    logged.length = 0;
    stdout.emit("data", Buffer.from("FATAL: port 7830 is taken"));
    expect(logged).toHaveLength(0);
    stdout.emit("close");
    expect(logged.join("\n")).toContain("FATAL: port 7830 is taken");
  });

  it("is fresh every launch and long enough to be worth having", async () => {
    const first = await new EngineManager().start();
    const second = await new EngineManager().start();

    expect(first.token).not.toBe(second.token);
    // 24 random bytes, base64url — no padding, no characters needing escaping.
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("what the child is allowed to bind", () => {
  it("pins the host even when the environment says otherwise", async () => {
    // EngineConfig maps every field to LOCALCUT_<FIELD>, so a stray
    // `export LOCALCUT_HOST=0.0.0.0` left over from following the
    // remote-engine docs would put this app's PRIVATE engine on the LAN —
    // while the shell, which only ever dials 127.0.0.1, reports it as never
    // becoming healthy.
    process.env.LOCALCUT_HOST = "0.0.0.0";
    const connection = await new EngineManager().start();

    expect(firstSpawn().options.env).toMatchObject({ LOCALCUT_HOST: "127.0.0.1" });
    expect(connection.url).toBe("http://127.0.0.1:7830");
  });

  it("honours an explicit port", async () => {
    process.env.LOCALCUT_ENGINE_PORT = "7999";
    const connection = await new EngineManager().start();

    expect(serveArgs()).toEqual(["serve", "--port", "7999", "--backend", "local,mock"]);
    expect(connection.url).toBe("http://127.0.0.1:7999");
  });

  it("defaults to the hybrid backend chain, and lets it be overridden", async () => {
    // Real backends claim only what they can currently serve; mock catches the
    // rest, so a fresh machine works and upgrades itself as models land.
    await new EngineManager().start();
    expect(firstSpawn().args).toContain("local,mock");

    spawned.calls.length = 0;
    process.env.LOCALCUT_BACKEND = "comfy,mock";
    await new EngineManager().start();
    expect(firstSpawn().args).toContain("comfy,mock");
  });
});

describe("spawn options", () => {
  it("hides the console window and groups the process on POSIX", async () => {
    await new EngineManager().start();

    // Without windowsHide the frozen engine — a console binary — pops a
    // console window behind the packaged GUI app.
    expect(firstSpawn().options.windowsHide).toBe(true);
    // Its own group so stop() can signal the engine AND its ffmpeg children
    // together instead of orphaning them mid-encode.
    expect(firstSpawn().options.detached).toBe(process.platform !== "win32");
    expect(firstSpawn().options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("runs from the repo checkout in development", async () => {
    await new EngineManager().start();
    expect(firstSpawn().cmd).toBe("uv");
    expect(firstSpawn().args.slice(0, 2)).toEqual(["run", "localcut"]);
    expect(String(firstSpawn().options.cwd)).toMatch(/engine$/);
  });

  it("splits a custom command on quotes, not on whitespace", async () => {
    // An interpreter or engine path with a space in it is the norm on Windows
    // ("C:\Program Files\…") and macOS ("/Users/Jane Doe/…").
    process.env.LOCALCUT_ENGINE_CMD = '"C:\\Program Files\\py\\python.exe" -m localcut_engine';
    await new EngineManager().start();

    expect(firstSpawn().cmd).toBe("C:\\Program Files\\py\\python.exe");
    expect(firstSpawn().args).toEqual([
      "-m",
      "localcut_engine",
      "serve",
      "--port",
      "7830",
      "--backend",
      "local,mock",
    ]);
  });

  it("ignores an empty custom command rather than spawning nothing", async () => {
    process.env.LOCALCUT_ENGINE_CMD = "   ";
    await new EngineManager().start();
    expect(firstSpawn().cmd).toBe("uv");
  });
});

describe("starting more than once", () => {
  it("spawns a single engine for concurrent callers", async () => {
    // During startup `connection` is still null, so a second caller (whenReady
    // racing engine:unpair) would otherwise spawn a second engine and orphan
    // the first.
    const manager = new EngineManager();
    const [first, second] = await Promise.all([manager.start(), manager.start()]);

    expect(engineSpawns()).toHaveLength(1);
    expect(first).toBe(second);
  });

  it("reuses a running engine instead of spawning another", async () => {
    const manager = new EngineManager();
    const first = await manager.start();
    expect(await manager.start()).toBe(first);
    expect(engineSpawns()).toHaveLength(1);
  });

  it("allows a fresh start after a stop", async () => {
    const manager = new EngineManager();
    await manager.start();
    manager.stop();
    expect(manager.connection).toBeNull();

    await manager.start();
    expect(engineSpawns()).toHaveLength(2);
  });
});

describe("when startup does not work out", () => {
  it("publishes no connection when the engine never becomes healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const manager = new EngineManager();
    const promise = manager.start();
    // The child dies on its own; the health loop notices it is gone rather
    // than waiting out the full 30s timeout.
    spawned.calls[0]!.child.emit("exit", 1);

    await expect(promise).rejects.toThrow(/exited during startup/);
    // A failed startup must read as "no connection", never as a dead url.
    expect(manager.connection).toBeNull();
  });

  it("reports a foreign engine on the port instead of retrying forever", async () => {
    // /health is unauthenticated, so answering it proves nothing. A 401 on an
    // authenticated route means this engine is not ours.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => ({
        ok: true,
        status: input.endsWith("/health") ? 200 : 401,
      })),
    );
    const manager = new EngineManager();

    await expect(manager.start()).rejects.toBeInstanceOf(EngineConflictError);
    expect(manager.connection).toBeNull();
    // It tried to reclaim the port (netstat on Windows, lsof elsewhere) before
    // giving up — that recovery is why the user is not sent to Task Manager.
    expect(spawned.calls.map((call) => call.cmd)).toContain(
      process.platform === "win32" ? "netstat" : "lsof",
    );
  });

  it("reclaims the port the engine was actually told to bind", async () => {
    // The port is decided once and used twice: the spawn args and orphan
    // recovery. If those ever disagree, reclaimPort targets a port nothing is
    // listening on, returns false, and the user is told to hunt for a
    // windowless process by hand — the dead end recovery exists to remove,
    // failing silently. Asserted through the port each side reports, because
    // `netstat -ano` takes no port argument and filters its own output.
    process.env.LOCALCUT_ENGINE_PORT = "7999";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => ({
        ok: true,
        status: input.endsWith("/health") ? 200 : 401,
      })),
    );

    await expect(new EngineManager().start()).rejects.toBeInstanceOf(EngineConflictError);

    expect(serveArgs()).toEqual(["serve", "--port", "7999", "--backend", "local,mock"]);
    expect(warned()).toContain("port 7999 held by a stale engine");
  });

  it.each(["exit", "error"])("does not let a dead child's late '%s' detach a newer one", async (
    event,
  ) => {
    // A previously-killed child's late 'error'/'exit' must not clear a child
    // that has since replaced it. The damage is invisible in `connection`,
    // which those handlers never touch — it shows up on the NEXT start, which
    // sees a null child, spawns a third engine, and orphans the healthy one.
    const manager = new EngineManager();
    await manager.start();
    const first = engineSpawns()[0]!.child;
    manager.stop();
    await manager.start();
    expect(engineSpawns()).toHaveLength(2);

    first.emit(event, event === "error" ? new Error("late spawn failure") : 143);

    await manager.start();
    expect(engineSpawns()).toHaveLength(2);
    expect(manager.connection).not.toBeNull();
  });
});
