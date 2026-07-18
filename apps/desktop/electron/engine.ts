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
import type { EngineConnection } from "../src/api/types";

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 250;

/** Startup found a foreign engine holding our port — retrying won't help. */
export class EngineConflictError extends Error {}

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
    connection: EngineConnection;
  } {
    const custom = process.env.LOCALCUT_ENGINE_CMD;
    const port = process.env.LOCALCUT_ENGINE_PORT ?? "7830";
    const backend = process.env.LOCALCUT_BACKEND ?? "mock";
    const token = randomBytes(24).toString("base64url");
    const connection = { url: `http://127.0.0.1:${port}`, token };
    const args = ["serve", "--port", port, "--token", token, "--backend", backend];
    if (custom) {
      const [cmd, ...prefix] = custom.split(" ");
      return { cmd, args: [...prefix, ...args], connection };
    }
    if (app.isPackaged) {
      const exe = process.platform === "win32" ? "localcut-engine.exe" : "localcut-engine";
      const bundled = path.join(process.resourcesPath, "engine", exe);
      return { cmd: bundled, args, connection };
    }
    const engineDir = path.resolve(__dirname, "..", "..", "..", "..", "engine");
    return { cmd: "uv", args: ["run", "localcut-engine", ...args], cwd: engineDir, connection };
  }

  private starting: Promise<EngineConnection> | null = null;

  async start(): Promise<EngineConnection> {
    if (this.connection && this.child) return this.connection;
    // Dedup concurrent starts: during startup `connection` is still null, so a
    // second caller (e.g. whenReady racing engine:unpair) would otherwise
    // spawn a second engine and orphan the first.
    this.starting ??= this.spawnAndWait().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnAndWait(): Promise<EngineConnection> {
    const { cmd, args, cwd, connection } = this.command();
    // windowsHide: the frozen engine is a console binary — without it,
    // Windows pops a console window behind the packaged GUI app.
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) =>
      console.log(`[engine] ${chunk.toString().trimEnd()}`),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      console.error(`[engine] ${chunk.toString().trimEnd()}`),
    );
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
        const response = await fetch(`${connection.url}/health`);
        if (response.ok) {
          // /health is unauthenticated — make sure this is OUR engine, not
          // a stale instance from a crashed session still holding the port.
          const authed = await fetch(`${connection.url}/projects`, {
            headers: { Authorization: `Bearer ${connection.token}` },
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
      this.child.kill("SIGTERM");
      this.child = null;
    }
    // Drop the connection too: a stopped engine's URL/token is dead, and a
    // later failed restart must read as "no connection", not a stale one.
    this.connection = null;
  }
}
