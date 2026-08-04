/**
 * Reruns a rig gate while it reports an invalid (not failed) run.
 *
 * Some Windows display stacks randomly boot or knock a forced-scale-1
 * renderer into a layout viewport inflated by the OS scale; a pixel gate
 * that detects this mid-run exits RETRYABLE_EXIT (3) instead of failing
 * its checks, and this wrapper simply tries again. Any other exit code —
 * pass or genuine failure — is final. On a healthy display stack the
 * first attempt is the only one.
 *
 * Usage: node retry.mjs <attempts> <command...>
 */
import { spawnSync } from "node:child_process";

const [, , attemptsArg, ...command] = process.argv;
const attempts = Number(attemptsArg);
if (!Number.isInteger(attempts) || attempts < 1 || command.length === 0) {
  console.error("usage: node retry.mjs <attempts> <command...>");
  process.exit(2);
}

const RETRYABLE_EXIT = 3;
let status = RETRYABLE_EXIT;
for (let attempt = 1; attempt <= attempts; attempt++) {
  if (attempt > 1) console.log(`retry ${attempt}/${attempts} - previous run was off-scale`);
  status = spawnSync(command[0], command.slice(1), { stdio: "inherit", shell: true }).status ?? 1;
  if (status !== RETRYABLE_EXIT) break;
}
process.exit(status);
