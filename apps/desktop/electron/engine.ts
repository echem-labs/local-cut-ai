/**
 * Engine lifecycle — the engine is a server the UI happens to launch
 *. Locally we auto-spawn it invisibly with a fresh token;
 * the same client code can instead pair with a remote engine, so nothing
 * here leaks into the renderer beyond { url, token }.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface EngineConnection {
  url: string;
  token: string;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 250;

export class EngineManager {
  private child: ChildProcess | null = null;
  connection: EngineConnection | null = null;

  /**
   * Dev: run from the repo checkout via uv. Packaged builds swap this for
   * the bundled pyinstaller engine — same flags, same handshake.
   */
  private command(): { cmd: string; args: string[]; cwd?: string } {
    const custom = process.env.LOCALCUT_ENGINE_CMD;
    const port = process.env.LOCALCUT_ENGINE_PORT ?? "7830";
    const backend = process.env.LOCALCUT_BACKEND ?? "mock";
    const token = randomBytes(24).toString("base64url");
    this.connection = { url: `http://127.0.0.1:${port}`, token };
    const args = ["serve", "--port", port, "--token", token, "--backend", backend];
    if (custom) {
      const [cmd, ...prefix] = custom.split(" ");
      return { cmd, args: [...prefix, ...args] };
    }
    const engineDir = path.resolve(__dirname, "..", "..", "..", "engine");
    return { cmd: "uv", args: ["run", "localcut-engine", ...args], cwd: engineDir };
  }

  async start(): Promise<EngineConnection> {
    if (this.connection && this.child) return this.connection;
    const { cmd, args, cwd } = this.command();
    this.child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk: Buffer) =>
      console.log(`[engine] ${chunk.toString().trimEnd()}`),
    );
    this.child.stderr?.on("data", (chunk: Buffer) =>
      console.error(`[engine] ${chunk.toString().trimEnd()}`),
    );
    this.child.on("exit", (code) => {
      console.error(`[engine] exited with code ${code}`);
      this.child = null;
    });
    await this.waitHealthy();
    return this.connection!;
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("engine process exited during startup");
      try {
        const response = await fetch(`${this.connection!.url}/health`);
        if (response.ok) {
          // /health is unauthenticated — make sure this is OUR engine, not
          // a stale instance from a crashed session still holding the port.
          const authed = await fetch(`${this.connection!.url}/projects`, {
            headers: { Authorization: `Bearer ${this.connection!.token}` },
          });
          if (authed.status === 401) {
            throw new Error(
              `another engine is already running on ${this.connection!.url} — quit it or set LOCALCUT_ENGINE_PORT`,
            );
          }
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("another engine")) {
          throw error;
        }
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
  }
}
