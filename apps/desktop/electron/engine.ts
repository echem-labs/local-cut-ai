/**
 * Engine lifecycle — the engine is a server the UI happens to launch
 *. Locally we auto-spawn it invisibly with a fresh token;
 * the same client code can instead pair with a remote engine, so nothing
 * here leaks into the renderer beyond { url, token }.
 */
import { app } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { EngineConnection } from "../src/api/types";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 250;
/** How long a terminated process group gets before it is SIGKILLed. */
const TERM_GRACE_MS = 3_000;
/** How long SIGKILL gets to land before the app stops waiting on it. The
 * kernel does not negotiate, so this only bounds a pathological wait. */
const KILL_GRACE_MS = 2_000;
/** How long to wait for a killed orphan to release the port before retrying. */
const PORT_RELEASE_MS = 4_000;
/** The loopback port the local engine binds. ONE definition: `command()` and
 * orphan recovery must never disagree about which port to reclaim, or a stale
 * engine survives and the retry fails for a reason nobody can see. */
const DEFAULT_ENGINE_PORT = "7830";
const enginePort = (): string => process.env.LOCALCUT_ENGINE_PORT ?? DEFAULT_ENGINE_PORT;

/** Startup found a foreign engine holding our port — retrying won't help. */
export class EngineConflictError extends Error {}

/** How much unterminated output is buffered before it is logged anyway. */
const MAX_PENDING_LINE = 8192;

/**
 * Mirror a child stream into the app log, a line at a time, with the engine's
 * bearer token taken out of it.
 *
 * `localcut serve` announces `LOCALCUT_ENGINE {"host":…,"token":"…"}` on
 * stdout for whoever launched it — which here is us, and we generated that
 * token ourselves. Delivering it through the environment rather than argv
 * already keeps it out of `ps` and /proc/<pid>/cmdline (see command()); the
 * app log is the same class of sink and needs the same answer, because a
 * packaged macOS/Linux build's console output lands in the system log, where
 * it outlives the engine that issued it. The engine redacts tokens from its
 * OWN logs for this reason (install_log_redaction); this is the other half.
 *
 * Splitting on the literal token cannot miss it the way a pattern could, and
 * buffering to line boundaries means a token divided across two chunks is
 * whole again before it is matched.
 */
const mirrorEngineOutput = (
  stream: NodeJS.ReadableStream | null | undefined,
  token: string,
  write: (line: string) => void,
): void => {
  if (!stream) return;
  // Decoding each Buffer on its own splits any multi-byte character that
  // straddles a chunk boundary into two replacement characters — and the
  // engine's stderr is where a traceback carrying a project title or a
  // model's own em-dashed warning lands, i.e. exactly the text someone is
  // reading when a launch has gone wrong. StringDecoder holds the partial
  // sequence back until the continuation bytes arrive.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string): void => {
    if (!line.trim()) return;
    // `split("")` on an empty needle splits into characters, which would
    // replace every gap in the line. Unreachable today — the token is 24
    // random bytes — but the failure is a log rendered unreadable, so it is
    // not worth leaving to the caller.
    const safe = token ? line.trimEnd().split(token).join("<token redacted>") : line.trimEnd();
    write(`[engine] ${safe}`);
  };
  stream.on("data", (chunk: Buffer) => {
    const lines = (pending + decoder.write(chunk)).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emit(line);
    // A writer that never sends a newline must not be able to withhold the
    // log for the process's whole lifetime, nor grow this buffer without
    // limit in the main process. Progress bars are the ordinary case: tqdm
    // and friends separate updates with \r, so waiting for \n means the one
    // thing someone opens the log to watch is the one thing it never shows.
    // Flushing at a bound keeps the redaction intact — the token is 32
    // characters and this is measured in kilobytes, so it can never straddle
    // a forced flush.
    if (pending.length > MAX_PENDING_LINE) {
      emit(pending);
      pending = "";
    }
  });
  // A last line with no trailing newline would otherwise sit in the buffer
  // and be lost — including the exit-time message that says why. On `close`
  // rather than `end`: a stream that is destroyed instead of reaching EOF
  // (the pipe of a force-killed child) emits only `close`, and that is the
  // exit whose reason is most worth having.
  stream.on("close", () => {
    emit(pending + decoder.end());
    pending = "";
  });
  // An 'error' on a stream with no listener is re-thrown, which here would
  // take down the main process over a broken pipe from an engine that is
  // already going away. It must not touch `pending`: Node destroys the
  // stream on error, so 'close' fires immediately afterwards and is where
  // the last unterminated line is flushed — clearing the buffer here threw
  // away exactly the message the comment above says is most worth having,
  // in exactly the destroyed-pipe case it was written for.
  stream.on("error", () => {});
};

export class EngineManager {
  private child: ChildProcess | null = null;
  // Published to the renderer over IPC only once the engine proves healthy;
  // a failed startup must read as "no connection", not a dead url.
  connection: EngineConnection | null = null;

  /**
   * Dev: run from the repo checkout via uv. Packaged builds swap this for
   * the bundled pyinstaller engine — same flags, same handshake.
   */
  private command(): {
    cmd: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
    connection: EngineConnection;
  } {
    const custom = process.env.LOCALCUT_ENGINE_CMD;
    const port = enginePort();
    // Hybrid by default: real backends claim only what they can currently
    // serve (weights installed, companion servers up), mock catches the
    // rest — so a fresh machine behaves like the old all-mock default and
    // upgrades itself piece by piece as models land.
    const backend = process.env.LOCALCUT_BACKEND ?? "local,mock";
    const token = randomBytes(24).toString("base64url");
    const connection = { url: `http://127.0.0.1:${port}`, token };
    // Deliver the token via the environment (EngineConfig.from_env reads
    // LOCALCUT_TOKEN), never as a --token argv flag: a command line is
    // world-readable to other local processes (ps, /proc/<pid>/cmdline, Task
    // Manager) for the engine's whole lifetime.
    // LOCALCUT_HOST is pinned, not merely inherited: EngineConfig maps every
    // field to LOCALCUT_<FIELD>, so a stray `export LOCALCUT_HOST=0.0.0.0`
    // left over from following the remote-engine docs would put this app's
    // PRIVATE engine on the LAN — while the shell, which only ever dials
    // 127.0.0.1, reports it as never becoming healthy.
    const env = { ...process.env, LOCALCUT_TOKEN: token, LOCALCUT_HOST: "127.0.0.1" };
    const args = ["serve", "--port", port, "--backend", backend];
    if (custom) {
      // Quote-aware: an interpreter or engine path with a space in it is the
      // norm on Windows ("C:\Program Files\...") and macOS ("/Users/Jane Doe").
      const tokens = (custom.match(/"[^"]*"|\S+/g) ?? []).map((part) =>
        part.replace(/^"|"$/g, ""),
      );
      const [cmd, ...prefix] = tokens;
      if (cmd) return { cmd, args: [...prefix, ...args], env, connection };
    }
    if (app.isPackaged) {
      const exe = process.platform === "win32" ? "localcut.exe" : "localcut";
      const bundled = path.join(process.resourcesPath, "engine", exe);
      return { cmd: bundled, args, env, connection };
    }
    const engineDir = path.resolve(__dirname, "..", "..", "..", "..", "engine");
    return { cmd: "uv", args: ["run", "localcut", ...args], cwd: engineDir, env, connection };
  }

  private starting: Promise<EngineConnection> | null = null;

  async start(): Promise<EngineConnection> {
    if (this.connection && this.child) return this.connection;
    // Dedup concurrent starts: during startup `connection` is still null, so a
    // second caller (e.g. whenReady racing engine:unpair) would otherwise
    // spawn a second engine and orphan the first.
    this.starting ??= this.startWithOrphanRecovery().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Start, and if a stale engine from a crashed session is holding the port,
   * reclaim it and try once more.
   *
   * The dead end this replaces: the next launch finds the port held, gets a
   * 401 (it is not our token), and tells the user to quit a process that on
   * Windows has no window — `windowsHide: true` means there is nothing to
   * close, so recovery meant opening Task Manager. Since we are the ones who
   * orphaned it, we are also the ones who can clean it up.
   */
  private async startWithOrphanRecovery(): Promise<EngineConnection> {
    try {
      return await this.spawnAndWait();
    } catch (error) {
      if (!(error instanceof EngineConflictError)) throw error;
      const port = Number(enginePort());
      console.warn(`[engine] port ${port} held by a stale engine; reclaiming it`);
      if (!(await reclaimPort(port))) throw error; // not ours to kill — report it
      return this.spawnAndWait();
    }
  }

  private async spawnAndWait(): Promise<EngineConnection> {
    const { cmd, args, cwd, env, connection } = this.command();
    // windowsHide: the frozen engine is a console binary — without it,
    // Windows pops a console window behind the packaged GUI app.
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group on POSIX, so stop() can signal the engine AND
      // its ffmpeg children together instead of orphaning them mid-encode.
      // (Windows gets the same effect from `taskkill /T`.)
      detached: process.platform !== "win32",
    });
    this.child = child;
    mirrorEngineOutput(child.stdout, connection.token, (line) => console.log(line));
    mirrorEngineOutput(child.stderr, connection.token, (line) => console.error(line));
    // Only clear this.child if THIS child is still the current one: a
    // previously-killed child's late 'error'/'exit' must not detach a newer
    // child that has since replaced it (which would orphan the healthy engine
    // and wedge startup). Without the 'error' listener a spawn failure (e.g.
    // `uv` not on PATH) would also crash the app as an uncaught exception.
    child.on("error", (err) => {
      console.error(`[engine] failed to spawn: ${err.message}`);
      if (this.child === child) this.child = null;
    });
    child.on("exit", (code) => {
      console.error(`[engine] exited with code ${code}`);
      if (this.child === child) this.child = null;
    });
    try {
      await this.waitHealthy(connection);
    } catch (err) {
      // A failed startup must not leak a running engine: kill the child (and
      // clear the connection) so a later retry starts clean instead of
      // stacking orphaned processes that still hold VRAM.
      this.stop();
      throw err;
    }
    this.connection = connection;
    return connection;
  }

  private async waitHealthy(connection: EngineConnection): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("engine process exited during startup");
      try {
        // Per-fetch timeout so a bound-but-silent port can't block a single
        // iteration past the HEALTH_TIMEOUT_MS deadline (undici's default
        // header/body timeouts are minutes long).
        const response = await fetch(`${connection.url}/health`, {
          signal: AbortSignal.timeout(HEALTH_INTERVAL_MS * 4),
        });
        if (response.ok) {
          // /health is unauthenticated — make sure this is OUR engine, not
          // a stale instance from a crashed session still holding the port.
          const authed = await fetch(`${connection.url}/projects`, {
            headers: { Authorization: `Bearer ${connection.token}` },
            signal: AbortSignal.timeout(HEALTH_INTERVAL_MS * 4),
          });
          if (authed.status === 401) {
            throw new EngineConflictError(
              `another engine is already running on ${connection.url} — quit it or set LOCALCUT_ENGINE_PORT`,
            );
          }
          return;
        }
      } catch (error) {
        if (error instanceof EngineConflictError) throw error;
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }
    throw new Error("engine did not become healthy in time");
  }

  stop(): void {
    if (this.child) {
      killTree(this.child);
      this.child = null;
    }
    // Drop the connection too: a stopped engine's URL/token is dead, and a
    // later failed restart must read as "no connection", not a stale one.
    this.connection = null;
  }

  /**
   * Stop the engine and wait for the process tree to actually be gone.
   *
   * `stop()` is fire-and-forget: its SIGKILL backstop is an unref'd timer, so
   * on the quit path — the only path that backstop exists for — the app exits
   * milliseconds later and the timer never fires. An engine that does not
   * honour SIGTERM promptly (uvicorn closes its socket well before the
   * lifespan shutdown finishes) was then left running with the data dir and
   * a few hundred MB of RSS, until the next launch's `reclaimPort` found it.
   *
   * Await this from `before-quit` so the escalation is reachable.
   */
  async stopAndWait(): Promise<void> {
    const child = this.child;
    this.stop();
    if (!child || child.pid === undefined) return;
    if (await exited(child, TERM_GRACE_MS)) return;
    console.warn("[engine] did not exit on SIGTERM; killing the process group");
    forceKillTree(child);
    await exited(child, KILL_GRACE_MS);
  }
}

/** Resolve true if the child is already gone, or exits within `ms`. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once("exit", onExit);
  });
}

/** SIGKILL the group now, rather than on the unref'd timer `killTree` arms. */
function forceKillTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // killTree already ran `taskkill /T /F`, which does not negotiate.
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // negative pid = the whole group
  } catch {
    /* already gone — the normal case */
  }
}

/** Run a command to completion; resolves to its stdout, or null if it could
 * not be launched or exited non-zero. */
function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * Kill whatever is listening on `port` and wait for it to let go.
 *
 * Only ever called after the engine answered /health but rejected our token —
 * i.e. it IS a LocalCut engine, just one orphaned by a previous session. A
 * false return means "could not identify or kill it", and the caller reports
 * the original conflict rather than pretending to have fixed anything.
 */
async function reclaimPort(port: number): Promise<boolean> {
  const pids = new Set<number>();
  if (process.platform === "win32") {
    const out = await run("netstat", ["-ano", "-p", "TCP"]);
    for (const line of (out ?? "").split(/\r?\n/)) {
      // "  TCP    127.0.0.1:7830   0.0.0.0:0   LISTENING   1234"
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === "LISTENING" && parts[1]?.endsWith(`:${port}`)) {
        const pid = Number(parts[4]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
  } else {
    const out = await run("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]);
    for (const line of (out ?? "").split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  if (pids.size === 0) return false;
  // Never kill ourselves — an Electron helper bound to this port would mean
  // something is very wrong, and taking down the app is not the fix.
  pids.delete(process.pid);
  if (pids.size === 0) return false;

  for (const pid of pids) {
    console.warn(`[engine] terminating orphaned engine pid ${pid}`);
    if (process.platform === "win32") {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, or not ours */
      }
    }
  }
  // The socket lingers briefly after the process dies; a retry that races it
  // would just fail to bind for a reason the user can do nothing about.
  const deadline = Date.now() + PORT_RELEASE_MS;
  while (Date.now() < deadline) {
    if (!(await portIsHeld(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !(await portIsHeld(port));
}

/** Whether anything currently accepts a connection on the loopback port. */
async function portIsHeld(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill the engine AND its descendants.
 *
 * `child.kill("SIGTERM")` maps to TerminateProcess on one PID on Windows, so
 * ffmpeg children are orphaned mid-encode and uvicorn's lifespan shutdown
 * (queue close, download shutdown) never runs — the DB row stays `rendering`
 * and the orphan keeps the port. `taskkill /T` walks the tree; POSIX gets the
 * process group, which is why spawn() sets detached there.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      // /T kills the tree, /F forces it. Fire-and-forget: the engine is
      // already being torn down, and a failure here is reported by the
      // orphan check on the next launch.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", (err) => console.warn("[engine] taskkill failed:", err.message));
    } catch (err) {
      console.warn("[engine] taskkill failed:", err);
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    // Negative pid = the whole process group (spawn used detached: true).
    process.kill(-child.pid, "SIGTERM");
    // Backstop: SIGKILL the group if anything is still alive. unref() so a
    // pending timer can never hold the app open during quit.
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone — the normal case */
      }
    }, TERM_GRACE_MS).unref();
  } catch {
    child.kill("SIGTERM"); // group gone already, or no permission
  }
}
