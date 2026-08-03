/** Shared plumbing for walk/compare/e2e: spawn launch.cjs, wait for the
 * eval server, POST snippets, collect health, tear down. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.RIG_PORT || 9223);
const BASE = `http://127.0.0.1:${PORT}`;

export function shotsDir(kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const dir = path.join(HERE, "shots", `${stamp}-${kind}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function evalInApp(body) {
  const response = await fetch(BASE, { method: "POST", body });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`eval failed: ${payload.error}`);
  return payload.result;
}

export async function health() {
  const response = await fetch(BASE);
  return response.json();
}

export async function startRig(extraEnv = {}) {
  const child = spawn("node", [path.join(HERE, "launch.cjs")], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await health();
      return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (child.exitCode !== null) break;
  }
  child.kill();
  throw new Error("rig did not come up on " + BASE);
}

export async function stopRig(child) {
  try {
    await evalInApp("await app.close(); return null;");
  } catch {
    /* window already gone */
  }
  child.kill();
}

/** Assertion helper that prints PASS/FAIL lines and tracks failures. */
export function makeCheck() {
  let failures = 0;
  const check = (name, condition, detail = "") => {
    if (condition) console.log(`  PASS ${name}`);
    else {
      failures += 1;
      console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    }
  };
  check.failures = () => failures;
  return check;
}
