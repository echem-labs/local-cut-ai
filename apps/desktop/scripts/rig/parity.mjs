/**
 * The pixel gates, as one command.
 *
 * There used to be six npm scripts here — `rig:parity`, `:home`, `:session`,
 * `:canvas`, `:u5`, `:u6` — because each redesign phase added its gate as it
 * built its screen. Two things were wrong with that. Half of them were named
 * after a phase of a plan document rather than after the screen they gate, so
 * the names stop meaning anything the day that document becomes history; and
 * each one needed its reference set spelled out on the command line, which is
 * a fact about the gate, not a decision for whoever runs it.
 *
 * So: the registry below is the single place that knows which script gates
 * which screen against which set of reference frames.
 *
 *   npm run rig:parity                 every gate, in order
 *   npm run rig:parity -- session      just that one
 *   npm run rig:parity -- home canvas  just those
 *
 * The reference frames live in the design-artifacts repo, not this one (they
 * are large PNG captures of the design mocks). Point at the directory holding
 * the `v*` set directories with either:
 *
 *   LOCALCUT_REFS=/path/to/artifacts/reference npm run rig:parity
 *   npm run rig:parity -- --refs /path/to/artifacts/reference
 *
 * With neither, the sibling checkout that the artifacts README describes is
 * used when it happens to be there, and the run stops with an explanation
 * when it is not.
 *
 * Each gate is run under retry.mjs: a gate that finds itself rendering
 * off-scale exits 3 to say the RUN was invalid rather than that the app was
 * wrong, and is retried rather than reported (see rig.mjs::RETRYABLE_EXIT).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..", "..");

/** Screen → the script that gates it, and the reference set it diffs.
 *
 * Keyed by what the frames are OF. The set directories keep their `v*`
 * names: those are captures with a history, and renaming a capture would
 * quietly invalidate every recorded delta measured against it. */
const GATES = {
  wizard: { script: "parity-wiz.mjs", set: "v3-inter" },
  home: { script: "parity-home.mjs", set: "v5" },
  session: { script: "parity-session.mjs", set: "v6" },
  canvas: { script: "parity-canvas.mjs", set: "v7" },
  inspector: { script: "parity-inspector.mjs", set: "v8" },
  about: { script: "parity-about.mjs", set: "v3-about" },
};

const ATTEMPTS = 6;

/** Each gate gets its own engine port.
 *
 * Running them back to back on one port is a race the engine loses: the
 * previous app's engine is still releasing the port when the next one binds,
 * so the next app comes up with no engine and a red "engine stopped" bar
 * across the top of the page. The gates hide that bar — and hiding it is not
 * enough, because a hidden child still leaves the banner wrapper laid out and
 * every frame shifted 24px down. Six gates then report that the app has
 * drifted from the mock, in every frame, for a reason that has nothing to do
 * with the app.
 *
 * A port each, so nothing has to have finished releasing anything. Honoured
 * over an explicit LOCALCUT_ENGINE_PORT only when the caller has not set one.
 *
 * The base moves with the process id, because a port each is only half of it:
 * two SUITES back to back reuse the same six ports, and the second one hits
 * the first one's TIME_WAIT exactly as one suite used to hit its own. That is
 * not hypothetical — comparing two reference sets means running the suite
 * twice in a row, and the second run came back with a dead engine on one gate
 * and an About pane that prints the engine's URL and hardware on another. A
 * gate whose engine is missing does not fail loudly; it fails as a diff. */
const ENGINE_PORT_BASE = 7840 + (process.pid % 40) * 8;

const argv = process.argv.slice(2);
const refsFlag = argv.indexOf("--refs");
const refsArg = refsFlag >= 0 ? argv[refsFlag + 1] : null;
if (refsFlag >= 0) argv.splice(refsFlag, refsArg ? 2 : 1);

/* No default. The reference frames are not in this repository and there is no
 * path this script can guess that is right for more than one machine - a guess
 * that happens to resolve on the author's box is worse than none, because the
 * run then compares against whatever is at that path and reports a diff rather
 * than a missing input. Say where they are. */
const refsRoot = refsArg
  ? path.resolve(refsArg)
  : process.env.LOCALCUT_REFS
    ? path.resolve(process.env.LOCALCUT_REFS)
    : null;

if (!refsRoot) {
  console.error(
    "rig:parity: no reference frames.\n" +
      "  The frames live in the design-artifacts repo. Point at the directory\n" +
      "  holding the v* set directories:\n" +
      "    LOCALCUT_REFS=<dir> npm run rig:parity\n" +
      "    npm run rig:parity -- --refs <dir>",
  );
  process.exit(2);
}

const unknown = argv.filter((name) => !(name in GATES));
if (unknown.length) {
  console.error(
    `rig:parity: unknown gate ${unknown.join(", ")} - expected one of ${Object.keys(GATES).join(", ")}`,
  );
  process.exit(2);
}

const chosen = argv.length ? argv : Object.keys(GATES);

const results = [];
for (const [at, name] of chosen.entries()) {
  const { script, set } = GATES[name];
  const refs = path.join(refsRoot, set);
  console.log(`\n=== ${name} (${script} against ${set}) ===`);
  if (!existsSync(path.join(HERE, script))) {
    // Says which half of the registry went stale, rather than leaving node
    // to report a module it cannot find.
    console.error(`rig:parity: ${name} names ${script}, which is not in ${HERE}`);
    results.push({ name, status: 2 });
    continue;
  }
  if (!existsSync(refs)) {
    // A missing set is a failure, not a skip: a gate that did not run is
    // the one shape of green this suite must never show.
    console.error(`rig:parity: ${name} has no reference set at ${refs}`);
    results.push({ name, status: 2 });
    continue;
  }
  const status =
    spawnSync(
      process.execPath,
      [path.join(HERE, "retry.mjs"), String(ATTEMPTS), process.execPath, path.join(HERE, script), "--refs", refs],
      {
        stdio: "inherit",
        cwd: DESKTOP,
        env: {
          ...process.env,
          LOCALCUT_ENGINE_PORT: process.env.LOCALCUT_ENGINE_PORT ?? String(ENGINE_PORT_BASE + at),
        },
      },
    ).status ?? 1;
  results.push({ name, status });
}

console.log("\n=== parity ===");
for (const { name, status } of results) {
  console.log(`  ${status === 0 ? "PASS" : "FAIL"} ${name}`);
}
const failed = results.filter((result) => result.status !== 0);
console.log(`${results.length - failed.length}/${results.length} gates passed`);
process.exit(failed.length ? 1 : 0);
