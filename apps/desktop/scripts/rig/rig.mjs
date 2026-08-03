/** Shared plumbing for walk/compare/e2e: spawn launch.cjs, wait for the
 * eval server, POST snippets, collect health, tear down. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.RIG_PORT || 9223);
const BASE = `http://127.0.0.1:${PORT}`;
/** Identifies the launcher THIS process spawned. A rig surviving a crashed
 * run answers on the same port; without the token we would drive it and
 * never notice — including, for rig:e2e, against the real profile. */
const TOKEN = process.env.RIG_TOKEN || randomUUID();
const HEADERS = { "x-rig-token": TOKEN };
/** Which port the app under test will run its engine on, so teardown can
 * wait for it to come free. The app RECLAIMS a busy engine port by killing
 * the holder, so a run that starts before the last one's engine has exited
 * either kills it or fails to bind - the "engine process exited during
 * startup" banner, and a Home with no projects to measure. */
let enginePort = 7830;

class StaleRigError extends Error {}

export function shotsDir(kind) {
  // Seconds, not minutes: rig:gate runs two scripts back to back, and a
  // minute-resolution stamp makes the second overwrite the first's shots.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const dir = path.join(HERE, "shots", `${stamp}-${kind}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function evalInApp(body) {
  const response = await fetch(BASE, { method: "POST", body, headers: HEADERS });
  if (response.status === 403) throw new StaleRigError(`another rig owns ${BASE}`);
  const payload = await response.json();
  if (!payload.ok) throw new Error(`eval failed: ${payload.error}`);
  return payload.result;
}

export async function health() {
  const response = await fetch(BASE, { headers: HEADERS });
  if (response.status === 403) throw new StaleRigError(`another rig owns ${BASE}`);
  return response.json();
}

/** Resolves once nothing is listening on `port`, or after `budgetMs`. */
async function waitForPortFree(port, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const busy = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (!busy || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startRig(extraEnv = {}) {
  enginePort = Number(extraEnv.LOCALCUT_ENGINE_PORT || process.env.LOCALCUT_ENGINE_PORT || 7830);
  // Pre-flight, not just teardown: an engine still finishing its boot when
  // the previous run tore the app down is orphaned mid-bind, holds the port
  // for a few seconds more, and the next app's engine dies with
  // "[Errno 98] Address already in use" - leaving a Home with no projects
  // and a walk that can measure nothing.
  await waitForPortFree(enginePort, 20000);
  const child = spawn("node", [path.join(HERE, "launch.cjs")], {
    env: { ...process.env, RIG_TOKEN: TOKEN, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await health();
      return child;
    } catch (error) {
      // A token mismatch is never transient: something else owns the port,
      // and retrying would only delay the same wrong answer.
      if (error instanceof StaleRigError) {
        child.kill();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (child.exitCode !== null) break;
  }
  child.kill();
  // The launcher exits 2 deliberately (no build / stale build) and prints
  // why; saying only "did not come up" would bury its message.
  throw new Error(
    child.exitCode === null
      ? `rig did not come up on ${BASE}`
      : `rig launcher exited ${child.exitCode} - see its message above`,
  );
}

export async function stopRig(child) {
  try {
    await evalInApp("await app.close(); return null;");
  } catch {
    /* window already gone */
  }
  child.kill();
  // Wait for the ports to actually come free: rig:gate starts the next
  // script immediately, and a launcher still holding 9223 would look like a
  // stale rig, while an engine still holding its port makes the next app
  // start with no engine at all.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await waitForPortFree(PORT);
  await waitForPortFree(enginePort);
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
