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
    // The whole child, not just its pid: the crash-tail tests drive the
    // engine's dying words in through `stderr`, and a type that stops at
    // `pid` describes a stub the mock below does not build.
    child: import("node:events").EventEmitter & {
      pid?: number;
      stdout: import("node:events").EventEmitter;
      stderr: import("node:events").EventEmitter;
      kill: () => void;
    };
  }[],
  /**
   * How a test answers each engine spawn.
   *
   * Called on the next tick rather than inside `spawn`, because the manager
   * attaches its 'exit' and stream listeners to the returned child — a
   * synchronous emit would land before anything was listening. Tests that
   * need several attempts in a row (the rebind loop) cannot reach for
   * `spawned.calls[n].child` to do it by hand: the attempts are made by a
   * loop nothing in the test is awaiting between iterations.
   */
  answer: null as null | ((child: { stderr: import("node:events").EventEmitter } & import("node:events").EventEmitter) => void),
  /**
   * What `run()` reads back from netstat / lsof / taskkill.
   *
   * Without it every helper command returns empty output, so `reclaimPort`
   * finds no pid, gives up, and the retry it exists to make never happens —
   * leaving everything past the reclaim untested.
   */
  says: null as null | ((cmd: string, args: string[]) => string | null),
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
      // `run()` (netstat / lsof / taskkill) waits for 'close'; the engine
      // child watches it too, as the point by which its pipes have drained.
      setTimeout(() => {
        if (args.includes("serve")) spawned.answer?.(child);
        else {
          const out = spawned.says?.(cmd, args);
          if (out) child.stdout.emit("data", Buffer.from(out));
        }
        child.emit("close", 0);
      }, 0);
      return child;
    },
  };
});

const { BIND_REFUSED, EngineConflictError, EngineManager, EnginePortBusyError } = await import(
  "./engine"
);

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
let errorSpy: { mock: { calls: unknown[][] } };
/** Everything logged to console.warn this test, joined. */
const warned = (): string => warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
/** Everything logged to console.error this test, joined. */
const errored = (): string => errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");

beforeEach(() => {
  spawned.calls.length = 0;
  spawned.answer = null;
  spawned.says = null;
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  // killTree signals a process GROUP by negative pid. The fake child reports
  // pid 4242, which on this machine belongs to something real.
  vi.spyOn(process, "kill").mockReturnValue(true);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("still reports the last line when the pipe is destroyed rather than closed", async () => {
    // The force-kill case the buffering was written for: Node destroys the
    // stream, which emits 'error' and THEN 'close'. An error handler that
    // cleared the buffer therefore threw away exactly the message the flush
    // on 'close' exists to deliver.
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));

    await new EngineManager().start();
    const { child } = firstSpawn();
    const stdout = (child as unknown as { stdout: import("node:events").EventEmitter }).stdout;

    stdout.emit("data", Buffer.from("FATAL: port 7830 is taken"));
    stdout.emit("error", new Error("read ECONNRESET"));
    stdout.emit("close");

    expect(logged.join("\n")).toContain("FATAL: port 7830 is taken");
  });

  it("logs a writer that never sends a newline instead of buffering it forever", async () => {
    // tqdm and friends separate progress updates with \r, so waiting for a
    // \n means the one thing someone opens the log to watch is the one thing
    // it never shows -- and `pending` grows without bound in the main process
    // meanwhile.
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void logged.push(line));

    const connection = await new EngineManager().start();
    const { child } = firstSpawn();
    const stdout = (child as unknown as { stdout: import("node:events").EventEmitter }).stdout;

    for (let i = 0; i < 40; i += 1) {
      stdout.emit("data", Buffer.from(`\rdownloading weights ${i}% ${"=".repeat(300)}`));
    }

    expect(logged.join("\n")).toContain("downloading weights");
    // And the redaction still holds across a forced flush: the token is 32
    // characters, the bound is measured in kilobytes.
    stdout.emit("data", Buffer.from(`LOCALCUT_ENGINE {"token": "${connection.token}"}\n`));
    expect(logged.join("\n")).not.toContain(connection.token);
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

/**
 * The minute after a crash, when the port belongs to nobody.
 *
 * An engine that dies with the app's WebSocket open leaves that connection in
 * TIME_WAIT with the ENGINE's port as its local port, and `serve` does not set
 * SO_REUSEADDR — so for the next 61 seconds (measured; TCP_TIMEWAIT_LEN is a
 * compile-time constant on Linux) nothing can bind it. The banner's Restart
 * button therefore failed instantly, and so did quitting and relaunching the
 * whole app, which is what made the crash look permanent.
 *
 * There is nothing to fix on either side of that: the app has to outlast it.
 */
describe("waiting out a port the kernel still holds", () => {
  /** Nothing is on the port — no rival engine, only a socket winding down. */
  const nothingServing = (): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
  };

  /** Every engine spawn dies the way `serve` does when its bind is refused. */
  const refuseTheBind = (): void => {
    spawned.answer = (child) => {
      child.stderr.emit(
        "data",
        Buffer.from(
          `${BIND_REFUSED}127.0.0.1:7830: [Errno 98] Address already in use\n` +
            "Another engine is probably already running - quit it, or pass a different --port.\n",
        ),
      );
      child.emit("exit", 1, null);
    };
  };

  // The wait is a minute of wall clock by design; the point of the tests is
  // what it does with that minute, not how long they take to watch it.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps trying until the socket is released, instead of failing at once", async () => {
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const promise = manager.start();

    await vi.advanceTimersByTimeAsync(6_000);
    const whileHeld = engineSpawns().length;
    expect(whileHeld).toBeGreaterThan(1);

    // The kernel lets go: the next child binds and answers for itself.
    spawned.answer = null;
    vi.stubGlobal("fetch", healthyEngine());
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(promise).resolves.toMatchObject({ url: "http://127.0.0.1:7830" });
    expect(engineSpawns().length).toBeGreaterThan(whileHeld);
  });

  it("gives up in the end rather than retrying forever", async () => {
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(300_000);

    expect(await caught).toBeInstanceOf(EnginePortBusyError);
    // And says which of the two port failures it was: there is no process for
    // the user to go and quit, so "another engine is running" would send them
    // hunting for one that does not exist.
    expect(String(await caught)).toMatch(/has not released/);
    expect(manager.connection).toBeNull();
  });

  it("does not wait out an engine that died for its own reasons", async () => {
    // The whole minute is only owed to a bind that was refused. Spending it on
    // an engine with a missing dependency would bury the one line that says so
    // under a wait, and then explain the failure in terms of a port.
    nothingServing();
    spawned.answer = (child) => {
      child.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'torch'\n"));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await caught).not.toBeInstanceOf(EnginePortBusyError);
    expect(engineSpawns()).toHaveLength(1);
  });

  it("still calls a live engine on the port a conflict, not a wait", async () => {
    // Same refused bind, opposite cause and opposite answer: something IS
    // serving, so waiting would never end and the user is the only one who
    // can resolve it. Posed with the engine dying before the health loop's
    // first request lands, which is the ordering that used to reach the
    // generic "exited during startup" and skip orphan recovery entirely.
    let dead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!dead) throw new Error("ECONNREFUSED");
        return { ok: true, status: input.endsWith("/health") ? 200 : 401 };
      }),
    );
    spawned.answer = (child) => {
      dead = true;
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await caught).toBeInstanceOf(EngineConflictError);
    expect(spawned.calls.map((call) => call.cmd)).toContain(
      process.platform === "win32" ? "netstat" : "lsof",
    );
  });

  it("does not shoot a stranger holding the port", async () => {
    // `reclaimPort` SIGKILLs whatever is listening, and the only thing that
    // has ever earned it is a 401 from /projects: proof the holder is a
    // LocalCut engine of ours with a spent token. Something that merely
    // answers a request on the port is any program at all - a dev server on
    // 7830, a proxy, whatever the user pointed LOCALCUT_ENGINE_PORT at - and
    // killing it is a far worse outcome than the failed start it was meant
    // to rescue.
    //
    // Posed as a program that answers /health perfectly well and then does
    // not know /projects, because that is where the bar actually sits. A
    // holder that fails the FIRST request never reaches the 401 test at all,
    // so it leaves "is 401 what earns the kill" unasked - and any weaker
    // reading (a 403, a 404, anything that is not 200) would send reclaimPort
    // to SIGKILL an auth proxy or a dev server with the whole suite green.
    let dead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!dead) throw new Error("ECONNREFUSED");
        // Healthy-looking, but not one of ours: no 401, so no kill.
        return input.endsWith("/health")
          ? { ok: true, status: 200 }
          : { ok: false, status: 404 };
      }),
    );
    spawned.answer = (child) => {
      dead = true;
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    await caught;
    expect(spawned.calls.map((call) => call.cmd)).not.toContain(
      process.platform === "win32" ? "netstat" : "lsof",
    );
  });

  it("does not make launch wait, because launch has no window to wait in", async () => {
    // `whenReady` awaits the engine BEFORE it creates the window, so a launch
    // that lands inside the minute would sit here with nothing on screen at
    // all — a worse failure than the one the waiting fixes, and one that
    // reads as a hung app. The wait belongs to the banner, which is on screen
    // and can say what it is doing.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const caught = manager.start({ waitForPort: false }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await caught).toBeInstanceOf(EnginePortBusyError);
    expect(engineSpawns()).toHaveLength(1);
  });

  it("does not spawn an engine into an app that asked it to stop", async () => {
    // `before-quit` awaits stopAndWait(), which has nothing to wait for while
    // this loop is between attempts — so an engine spawned a second later
    // outlives the app, holding the data dir and the very port this loop was
    // waiting on. Quitting mid-restart is the ordinary way to meet it: the
    // banner's button is pressed, nothing appears to happen for half a
    // minute, and the window gets closed.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const promise = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);
    const spawnedByThen = engineSpawns().length;
    expect(spawnedByThen).toBeGreaterThan(1);

    manager.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(engineSpawns()).toHaveLength(spawnedByThen);
    expect(manager.connection).toBeNull();
    // And says so as a cancellation. This message is what `engine:restart`
    // hands back to the banner, so reporting the port error that happened to
    // be in hand tells the user a socket is stuck when the truth is that the
    // app called the start off itself - and writes that into the log the
    // support bundle ships.
    expect(String(await promise)).toMatch(/cancelled/);
  });

  it("does not spawn an engine after reclaiming a port the app stopped wanting", async () => {
    // The same cancellation as above, met on the orphan-recovery path — the
    // one the rebind loop's own comment calls the likeliest place to meet a
    // held port, because killing the orphan is what creates the sockets.
    // `reclaimPort` polls for up to PORT_RELEASE_MS, which is a wide enough
    // door for `before-quit` to walk through: `stopAndWait()` finds no child
    // to wait for, the app exits, and the engine the retry then spawns
    // outlives it holding the data dir and the port.
    let released = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (released) throw new Error("ECONNREFUSED");
        return { ok: true, status: input.endsWith("/health") ? 200 : 401 };
      }),
    );
    // A stale engine of ours answers, so the first attempt is a conflict...
    // Each dialect in its own shape: `lsof -t` prints bare pids, `netstat
    // -ano` prints a table `reclaimPort` filters itself. One string for both
    // made this test vacuous on Windows — no pid found, no reclaim, and so
    // none of the retry it exists to cancel.
    // ...and letting go of the port a moment after it is killed is what puts
    // the app inside reclaimPort's poll rather than past it. Both kills, for
    // the same reason as both dialects: Windows shells out to `taskkill` and
    // never reaches `process.kill`, so hanging the release off that one alone
    // left the port held there, the poll running out, and the reclaim
    // reporting failure instead of the retry this test is here to cancel.
    const killed = (): void => void setTimeout(() => (released = true), 1_500);
    spawned.says = (cmd) => {
      if (cmd === "taskkill") killed();
      if (cmd === "lsof") return "5150\n";
      return cmd === "netstat"
        ? "  TCP    127.0.0.1:7830    0.0.0.0:0    LISTENING    5150\n"
        : null;
    };
    vi.spyOn(process, "kill").mockImplementation(() => {
      killed();
      return true;
    });
    spawned.answer = (child) => {
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const promise = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(engineSpawns()).toHaveLength(1); // conflict found; reclaim under way
    manager.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(engineSpawns()).toHaveLength(1);
    expect(manager.connection).toBeNull();
    await promise;
  });

  it("reports no crash at all for the attempts it is going to outlive", async () => {
    // NONE, not one. Every failed attempt reaching the crash listeners would
    // rewrite the banner's pasteable report each time and settle on the
    // engine's own guess — "another engine is probably already running" —
    // which is the one explanation that is not true here; and a single one
    // settles on exactly the same sentence. The report the user already has
    // describes the crash they are trying to recover from, which is the one
    // worth keeping.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const crashes: unknown[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(engineSpawns().length).toBeGreaterThan(5);
    expect(crashes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300_000);
    await caught;
  });

  it("still reports the failure that ends the wait, whichever attempt it is", async () => {
    // The other half of the rule above: only a REFUSED BIND is beneath
    // reporting, because only a refused bind is going to be retried. An
    // engine that gets the port and then dies of a missing dependency ends
    // the wait, and dropping its crash would leave the banner describing
    // whatever came before it and offering a report with none of the words
    // that say what is actually wrong.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(crashes).toHaveLength(0);

    // The port comes free, and the engine that gets it falls over anyway.
    spawned.answer = (child) => {
      child.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'torch'\n"));
      child.emit("exit", 1, null);
    };
    await vi.advanceTimersByTimeAsync(10_000);

    await caught;
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.tail.join("\n")).toContain("No module named 'torch'");
  });

  it("reports the refused bind that ends the wait, not only the other failures", async () => {
    // A refused bind is beneath reporting only while it is going to be tried
    // again. When the answer comes back "a live engine holds this port" or
    // "a stranger does", the wait is over on the spot — and reporting nothing
    // leaves the banner describing the crash the user was recovering FROM,
    // with a pasteable report that says nothing about the port.
    let dead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!dead) throw new Error("ECONNREFUSED");
        return { ok: true, status: input.endsWith("/health") ? 200 : 401 };
      }),
    );
    spawned.answer = (child) => {
      dead = true;
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await caught).toBeInstanceOf(EngineConflictError);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.tail.join("\n")).toContain(BIND_REFUSED);
  });

  it("does not read a traceback that quotes the words as a refused bind", async () => {
    // The match is anchored at the start of the mirrored line, and that is
    // load-bearing rather than tidy: the engine's stderr carries tracebacks
    // quoting project titles and model warnings, and one of those containing
    // the phrase would turn a real failure into a minute and a half of silent
    // retrying - ending in a sentence about a port, with the crash that
    // actually happened never reported at all.
    nothingServing();
    spawned.answer = (child) => {
      child.stderr.emit("data", Buffer.from(`RuntimeError: ${BIND_REFUSED}the clip to a track\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await caught).not.toBeInstanceOf(EnginePortBusyError);
    expect(engineSpawns()).toHaveLength(1);
    expect(crashes).toHaveLength(1);
  });

  it("waits out a socket, but not a program too busy to say who it is", async () => {
    // `whoAnswersOn` reads silence on the port as "only a socket winding
    // down" — the case worth spending ninety seconds on. A request that TIMES
    // OUT is not silence: a closed port and a socket in TIME_WAIT both refuse
    // at once, so something took the connection and did not answer, and that
    // is a program. Counting it as nobody spends the whole budget outlasting
    // a socket that is not there, and then explains the failure in terms of a
    // port that nothing is holding.
    let dead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!dead) throw new Error("ECONNREFUSED");
        // What AbortSignal.timeout rejects with, by name.
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        throw timeout;
      }),
    );
    refuseTheBind();
    spawned.answer = (child) => {
      dead = true;
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    const manager = new EngineManager();
    const caught = manager.start().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await caught).not.toBeInstanceOf(EnginePortBusyError);
    expect(String(await caught)).toMatch(/another program/);
    expect(engineSpawns()).toHaveLength(1);
  });

  it("does not hand a cancelled start to the caller that comes after it", async () => {
    // `stop()` cancels the loop, but the loop only notices when it wakes —
    // two seconds later, or four if the stop landed inside an orphan reclaim.
    // For that whole window the cancelled start is still the one `start()`
    // dedups onto, so the next caller is handed a promise already on its way
    // to throwing. Pairing a GPU box and changing your mind a second later is
    // the ordinary way to meet it, and the app ends up with no engine at all.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const abandoned = manager.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);

    manager.stop();
    // The port comes free and someone asks again, inside the window before
    // the cancelled loop has woken up to notice.
    spawned.answer = null;
    vi.stubGlobal("fetch", healthyEngine());
    const second = manager.start();
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(second).resolves.toMatchObject({ url: "http://127.0.0.1:7830" });
    await abandoned;
  });

  it("does not publish a connection for an engine that died on the way up", async () => {
    // `waitHealthy` tests that the child is alive only at the top of each
    // iteration, so an engine that answers /health and then dies while the
    // authenticated request is in flight gets all the way to the end. Its
    // exit has already taken the connection down; putting it back hands the
    // renderer a url and token for a process that is gone, and the app says
    // an engine is answering while every request fails.
    let release: (value: { ok: boolean; status: number }) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith("/health")) return { ok: true, status: 200 };
        // The authenticated request hangs until the test lets it go.
        return new Promise((resolve) => (release = resolve));
      }),
    );
    const manager = new EngineManager();
    const caught = manager.start({ waitForPort: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    // The engine falls over with the /projects response still in flight.
    firstSpawn().child.emit("exit", 1, null);
    release({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(2_000);

    await caught;
    expect(manager.connection).toBeNull();
  });

  it("does not report the app's own stop as an engine that died", async () => {
    // The check above fires whenever the child stopped being the current one,
    // and `stop()` is one of the ways that happens: `discardChild` nulls
    // `this.child` too. Told apart by `asked`, because the two read to the
    // user as opposite things — "your engine crashed" is what someone who
    // just paired a GPU box would see at the moment they switched away from
    // the local one, in the sentence `engine:restart` hands the banner.
    let release: (value: { ok: boolean; status: number }) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith("/health")) return { ok: true, status: 200 };
        return new Promise((resolve) => (release = resolve));
      }),
    );
    const manager = new EngineManager();
    const caught = manager.start({ waitForPort: false }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    manager.stop(); // the user paired a remote engine
    release({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(String(await caught)).toMatch(/cancelled/);
    expect(manager.connection).toBeNull();
  });

  it("reports no crash for an orphan it reclaims and recovers from", async () => {
    // The wait-ending report must not fire for the one failure the app
    // repairs by itself. A refused bind whose holder is a stale engine of
    // ours is answered by SIGKILLing it and starting over, and a crash
    // reported on the way puts a banner and a pasteable report on screen for
    // a fault that is fixed by the time anyone reads it — describing an
    // engine that is answering, in the words the exit handler's own comment
    // says must never reach the banner.
    let holder: "orphan" | "gone" = "orphan";
    let dead = false;
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!dead) throw new Error("ECONNREFUSED");
        // Killed, and nothing on the port until our own engine binds it.
        if (holder === "gone") {
          if (attempt < 2) throw new Error("ECONNREFUSED");
          return { ok: true, status: 200 };
        }
        return { ok: true, status: input.endsWith("/health") ? 200 : 401 };
      }),
    );
    spawned.says = (cmd) => (cmd === "lsof" || cmd === "netstat" ? "9999\n" : null);
    spawned.answer = (child) => {
      attempt += 1;
      if (attempt > 1) return; // the port is ours now; this one lives
      dead = true;
      child.stderr.emit("data", Buffer.from(`${BIND_REFUSED}127.0.0.1:7830: in use\n`));
      child.emit("exit", 1, null);
    };
    // The orphan stops answering the moment it is killed.
    (process.kill as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
      (pid: number) => {
        if (pid === 9999) holder = "gone";
        return true;
      },
    );
    const manager = new EngineManager();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const started = manager.start();
    void started.catch(() => {});

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(started).resolves.toMatchObject({ url: "http://127.0.0.1:7830" });
    expect(crashes).toHaveLength(0);
  });

  it("does not un-suppress a replacement's crashes when a cancelled start unwinds", async () => {
    // `rebinding` is what makes one restart read as one crash instead of
    // forty-five. `stop()` now releases the dedup slot, so a replacement
    // start can be waiting a port out by the time the cancelled one wakes up
    // two seconds later — and a `finally` that clears the flag unconditionally
    // clears it on the replacement's behalf. Every one of ITS attempts then
    // files its own crash, and the banner is rewritten every two seconds for
    // ninety, ending on "another engine is probably already running": the
    // exact rewriting the flag exists to prevent.
    nothingServing();
    refuseTheBind();
    const manager = new EngineManager();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));
    const abandoned = manager.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);

    manager.stop();
    const replacement = manager.start().catch((error: unknown) => error);
    // Well past the moment the cancelled loop wakes and unwinds (2s), and
    // several of the replacement's own attempts later.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(crashes).toHaveLength(0);
    manager.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await abandoned;
    await replacement;
  });

  it("does not let a cancelled start kill the engine the next one brought up", async () => {
    // The other half of the same overlap. `waitHealthy` asked only whether
    // there was A child, so a cancelled attempt woken by the replacement's
    // engine read that one as its own still being alive - and its cleanup
    // then killed `this.child` and nulled `this.connection` without asking
    // whose they were. The app is left holding a url and a token for a
    // process its own cancelled start has just SIGTERMed.
    let release: (value: { ok: boolean; status: number }) => void = () => {};
    let hang = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (hang && input.endsWith("/health"))
          return new Promise((resolve) => (release = resolve));
        return { ok: true, status: 200 };
      }),
    );
    const manager = new EngineManager();
    const abandoned = manager.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300); // parked inside waitHealthy

    manager.stop();
    hang = false;
    const second = manager.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toMatchObject({ url: "http://127.0.0.1:7830" });

    // Only now does the cancelled attempt's health probe come back.
    release({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(3_000);

    await abandoned;
    expect(manager.connection).not.toBeNull();
    expect(engineSpawns()).toHaveLength(2);
  });
});

/**
 * A crash and a quit arrive at the same handler looking identical.
 *
 * `killTree` uses `taskkill /PID <pid> /T /F` on Windows, and `/F` terminates
 * with **exit code 1**. So the ordinary teardown — every window close, every
 * unpair, every failed startup that cleans up after itself — reached the exit
 * handler with the same code an engine that fell over reports, and the
 * handler logged both through `console.error`. The app's own log could not
 * tell them apart, and neither could anything built on top of it.
 */
describe("telling a crash from a quit the app asked for", () => {
  it("does not report the teardown it asked for as a failure", async () => {
    const manager = new EngineManager();
    await manager.start();
    const crashes: unknown[] = [];
    manager.onCrash((crash) => crashes.push(crash));

    manager.stop();
    firstSpawn().child.emit("exit", 1, null);

    expect(crashes).toEqual([]);
    expect(errored()).not.toMatch(/exited/);
  });

  it("takes the connection down with the engine that stopped answering", async () => {
    // A dead engine's url and token are a dead url and token. Left standing,
    // the shell reads `connection` as "an engine is answering" and withholds
    // the crash from the next renderer to ask for one — so a window created
    // after the engine died (macOS: close it, then the dock icon) came up
    // with no banner at all and a client pointed at nothing.
    const manager = new EngineManager();
    await manager.start();
    expect(manager.connection).not.toBeNull();

    firstSpawn().child.emit("exit", 1, null);

    expect(manager.connection).toBeNull();
  });

  it("reports an engine that fell over on its own", async () => {
    const manager = new EngineManager();
    await manager.start();
    const crashes: { code: number | null }[] = [];
    manager.onCrash((crash) => crashes.push(crash));

    firstSpawn().child.emit("exit", 1, null);

    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.code).toBe(1);
    expect(errored()).toMatch(/exited/);
  });

  it("carries the engine's last words, with the token taken out", async () => {
    // The report exists to be pasted into an issue, so what the engine said
    // on the way down has to travel with it — and the bearer token for every
    // project on the machine must not.
    const manager = new EngineManager();
    const connection = await manager.start();
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));

    const { child } = firstSpawn();
    child.stderr.emit("data", Buffer.from("Traceback (most recent call last):\n"));
    child.stderr.emit("data", Buffer.from(`RuntimeError: bad token ${connection.token}\n`));
    child.emit("exit", 3, null);

    const tail = crashes[0]!.tail.join("\n");
    expect(tail).toContain("Traceback (most recent call last):");
    expect(tail).toContain("<token redacted>");
    expect(tail).not.toContain(connection.token);
  });

  it("does not let a killed child's late exit report a crash", async () => {
    // Same hazard the 'late exit' test above covers for `this.child`: a child
    // we already terminated can emit long after a replacement is healthy, and
    // a banner saying the engine died would be the only thing on screen
    // claiming so.
    const manager = new EngineManager();
    await manager.start();
    const first = firstSpawn().child;
    const crashes: unknown[] = [];
    manager.onCrash((crash) => crashes.push(crash));

    manager.stop();
    await manager.start();
    first.emit("exit", 1, null);

    expect(crashes).toEqual([]);
  });
});

describe("whose crash the tail belongs to", () => {
  it("does not file a killed engine's dying line under its replacement", async () => {
    // A force-killed child's pipe is DESTROYED rather than ended, so
    // `mirrorEngineOutput` flushes its last unterminated line on `close` —
    // and that can land after a replacement engine has already started. The
    // report exists to be pasted into an issue about the engine that just
    // died; a previous engine's death rattle at the top of it misleads
    // whoever reads it.
    const manager = new EngineManager();
    await manager.start();
    const first = firstSpawn().child;

    // No trailing newline: it sits in the buffer until `close`.
    first.stderr.emit("data", Buffer.from("FATAL: port 7830 is taken"));
    manager.stop();

    await manager.start();
    const second = engineSpawns()[1]!.child;
    const crashes: { tail: string[] }[] = [];
    manager.onCrash((crash) => crashes.push(crash));

    // The dead child's pipe finally drains, long after its replacement.
    first.stderr.emit("close");
    second.stderr.emit("data", Buffer.from("RuntimeError: no CUDA device\n"));
    second.emit("exit", 1, null);

    const tail = crashes[0]!.tail.join("\n");
    expect(tail).toContain("RuntimeError: no CUDA device");
    expect(tail).not.toContain("FATAL: port 7830 is taken");
  });
});
