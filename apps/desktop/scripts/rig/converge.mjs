/**
 * Say which ELEMENT moved, not how many pixels did.
 *
 * `compare.mjs` answers the gate's question — is this frame within budget —
 * and that number is useless for closing the gap: "23640 differing px" gives
 * nobody a line to edit. This reads the text probes written beside the
 * reference and beside the app capture (see textprobe.cjs) and pairs them up
 * on the string, which is the one key both sides agree on.
 *
 * Output is ordered by how far each string moved, because that is the order
 * worth fixing in: one label 7px out is a real layout difference, and forty
 * labels 1px out are usually one cause upstream of all of them.
 *
 * Usage: node converge.mjs --ref <refs-dir> --app <shots-dir> [--frame name]
 *        [--tol 0]   pixels of movement to ignore
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Flags that take no value. A flag read as another flag's argument is the
 *  quiet failure this list exists to stop: `--tol --chain` used to make TOL
 *  `Number("--chain")` = NaN, and since every `> NaN` is false, a frame 40px
 *  out reported "converged". */
const SWITCHES = new Set(["--boxes", "--gaps", "--chain"]);

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || SWITCHES.has(value)) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
};

const usage =
  "usage: node converge.mjs --ref <refs-dir> --app <shots-dir> [--frame name] [--tol n]";
const refDir = arg("ref");
const appDir = arg("app");
const only = arg("frame");
const TOL = Number(arg("tol", "0"));
if (!refDir || !appDir) {
  console.error(usage);
  process.exit(2);
}
// Number("2px") is NaN, and NaN silently filters every row out rather than
// letting any through - so it reads as convergence, not as a bad argument.
if (!Number.isFinite(TOL)) {
  console.error(`--tol must be a number\n${usage}`);
  process.exit(2);
}

const probes = readdirSync(refDir)
  .filter((file) => file.endsWith(".text.json"))
  .map((file) => file.replace(/\.text\.json$/, ""));

if (probes.length === 0) {
  console.error(`no text probes in ${refDir} — re-render the references`);
  process.exit(2);
}

// The `--frame` filter is applied AFTER the emptiness check, so a mistyped
// name says so instead of sending you to re-render references that are fine.
const frames = probes.filter((name) => !only || name === only);
if (frames.length === 0) {
  console.error(`no frame named ${only} in ${refDir}; it has: ${probes.join(", ")}`);
  process.exit(2);
}

/**
 * The key both sides can agree on.
 *
 * The mocks write their icons as unicode characters inside the same text
 * node as the label ("▤ Start from a template"), where the app draws a
 * lucide SVG beside a clean one. Matching raw would orphan both halves of
 * every such pair and report them as copy that differs, which is the one
 * thing they are not. So strip the symbols, fold the ellipsis the mock
 * spells with three dots, and case-fold — a label the design draws in caps
 * via `text-transform` still holds mixed-case text in the DOM, and only one
 * of the two sides does it that way.
 */
const key = (text) =>
  text
    // Keep printable ASCII and the few typographic marks that carry
    // meaning; everything else in a label is an icon drawn as a character.
    .replace(/[^ -~…—–·]/g, " ")
    .replace(/\.{3}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Pair rows on their text. Repeated strings (six "Open" buttons) are paired
 *  in document order, which is the only correspondence available and the
 *  right one whenever both sides list them the same way. */
const pair = (refRows, appRows) => {
  // A row whose text is only punctuation or a lone icon glyph carries no
  // label to match on; it is the pixel diff's business, not this. Dropped
  // from BOTH sides up front, which is the only place it can be done once:
  // every such row folds to the same empty key, so leaving them in gave one
  // bucket that paired the mock's rail glyph against the app's close button
  // and printed the result -- dx=1160 -- at the top of the list, since the
  // sort is by distance. The mocks draw every icon as a character, so this
  // is a dozen rows a frame, not an edge case.
  const labelled = (rows) => rows.filter((row) => key(row.text));
  const byText = new Map();
  for (const row of labelled(appRows)) {
    const k = key(row.text);
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(row);
  }
  const pairs = [];
  const orphans = [];
  for (const row of labelled(refRows)) {
    const bucket = byText.get(key(row.text));
    if (!bucket || bucket.length === 0) {
      orphans.push(row);
      continue;
    }
    pairs.push([row, bucket.shift()]);
  }
  const extra = [...byText.values()].flat();
  return { pairs, orphans, extra };
};

const short = (text) => (text.length > 42 ? `${text.slice(0, 39)}...` : text);

// Resolved once rather than re-scanned per frame, so that two modes at once
// is an error instead of a silent win for whichever `if` came first.
const MODES = ["boxes", "gaps", "chain"];
const asked = MODES.filter((flag) => process.argv.includes(`--${flag}`));
if (asked.length > 1) {
  console.error(`--${asked.join(" and --")} are alternatives; pick one`);
  process.exit(2);
}
const mode = asked[0] ?? "moved";

let framesWithDrift = 0;
let framesCompared = 0;
for (const name of frames) {
  const refPath = path.join(refDir, `${name}.text.json`);
  const appPath = path.join(appDir, `${name}.text.json`);
  if (!existsSync(appPath)) {
    console.log(`\n### ${name}\n  no app probe — run the gate with RIG_PROBE=1`);
    continue;
  }
  framesCompared += 1;
  const refRows = JSON.parse(readFileSync(refPath, "utf8"));
  const appRows = JSON.parse(readFileSync(appPath, "utf8"));
  const { pairs, orphans, extra } = pair(refRows, appRows);

  const moved = pairs
    .map(([ref, app]) => ({
      text: ref.text,
      dx: app.x - ref.x,
      dy: app.y - ref.y,
      // Width only where both sides measured the same thing. A placeholder
      // has no text node to put a Range around, so textprobe reports the
      // FIELD's box for it, where the mock - which draws the string as real
      // text - reports the ink. Comparing the two called Home's prompt 333px
      // wider and, since the sort is by distance, printed it first.
      dw: ref.placeholder || app.placeholder ? 0 : app.width - ref.width,
      ref,
      app,
    }))
    .filter((row) => Math.abs(row.dx) > TOL || Math.abs(row.dy) > TOL || Math.abs(row.dw) > TOL)
    .sort((a, b) => Math.hypot(b.dx, b.dy) + Math.abs(b.dw) - (Math.hypot(a.dx, a.dy) + Math.abs(a.dw)));

  // A difference in the type itself moves every glyph after the first, so
  // it is worth calling out separately from where the box sits.
  const restyled = pairs
    .filter(
      ([ref, app]) =>
        ref.size !== app.size ||
        ref.weight !== app.weight ||
        ref.spacing !== app.spacing ||
        ref.family !== app.family,
    )
    .map(([ref, app]) => ({ ref, app }));

  if (!moved.length && !restyled.length && !orphans.length && !extra.length) {
    console.log(`\n### ${name}\n  converged — every string in the same place, in the same type`);
    continue;
  }
  framesWithDrift += 1;
  console.log(`\n### ${name}  (${pairs.length} strings paired)`);

  /** The boxes the text sits in, where the two sides size them differently.
   *  This is the cause layer: a row moves because the box above it is a
   *  different height, and that is the line to edit. */
  if (mode === "boxes") {
    const seen = new Set();
    const rows = pairs
      .filter(([ref, app]) => ref.boxH !== undefined && app.boxH !== undefined)
      .map(([ref, app]) => ({ text: ref.text, refH: ref.boxH, appH: app.boxH, refW: ref.boxW, appW: app.boxW, y: ref.boxY, x: ref.boxX }))
      .filter((row) => row.refH !== row.appH || row.refW !== row.appW)
      // One line per distinct box, not per label inside it. Keyed on x too:
      // the prompt row draws three chips at one y with one height, and a key
      // without x collapsed them into a single line - so a real divergence
      // on the second chip was dropped and the count under-reported.
      .filter((row) => {
        const k = `${row.x}:${row.y}:${row.refH}:${row.refW}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.y - b.y);
    console.log(`  boxes sized differently (${rows.length}):`);
    for (const row of rows) {
      const dh = row.appH - row.refH;
      const dw = row.appW - row.refW;
      console.log(
        `    y=${String(row.y).padStart(4)}  h ${String(row.refH).padStart(3)}->${String(row.appH).padEnd(3)} (${dh > 0 ? "+" : ""}${dh})  ` +
          `w ${String(row.refW).padStart(4)}->${String(row.appW).padEnd(4)} (${dw > 0 ? "+" : ""}${dw})  ${short(row.text)}`,
      );
    }
    continue;
  }

  /**
   * The gap between one row of text and the next, on each side.
   *
   * `--chain` shows that everything below some point is 3px high, which
   * localises the cause to "above here" and no further. What actually has to
   * change is one box's height or margin, and that shows up as the single
   * gap where the two sides disagree — every gap after it is back to zero,
   * because the drift is inherited rather than re-earned.
   *
   * Rows are collapsed by y first: six chips on one line are one row, and
   * pairing them individually would report five gaps of zero between them.
   */
  if (mode === "gaps") {
    // Cluster into lines, don't round into buckets. Text on one visual row
    // differs by a pixel or two of ink depending on ascenders, and rounding
    // splits exactly that case whenever the pair straddles a boundary
    // (y=5 and y=6 round to 4 and 8) while merging rows 3px apart that are
    // genuinely distinct. Walk them in order instead and start a new line
    // only where the step exceeds the ink jitter.
    const LINE = 3;
    const ordered = [];
    for (const [ref, app] of [...pairs].sort((a, b) => a[0].y - b[0].y)) {
      const line = ordered[ordered.length - 1];
      if (line && ref.y - line.refY <= LINE) continue;
      ordered.push({ refY: ref.y, appY: app.y, text: ref.text });
    }
    console.log(`  gaps (ref -> app, the row where they disagree is the one to fix):`);
    for (let at = 1; at < ordered.length; at++) {
      const previous = ordered[at - 1];
      const row = ordered[at];
      const refGap = row.refY - previous.refY;
      const appGap = row.appY - previous.appY;
      const delta = appGap - refGap;
      if (delta === 0) continue;
      console.log(
        `    ${String(refGap).padStart(4)} -> ${String(appGap).padStart(4)}  (${delta > 0 ? "+" : ""}${delta})  ` +
          `under "${short(previous.text)}"  before "${short(row.text)}"`,
      );
    }
    continue;
  }

  // Down the page in order, which is how vertical drift is actually read:
  // a block that starts 4px high carries everything under it, so the row
  // where dy first changes is the one to fix, not the forty below it.
  if (mode === "chain") {
    console.log(`  chain (ref y order):`);
    for (const row of [...moved].sort((a, b) => a.ref.y - b.ref.y)) {
      console.log(
        `    y=${String(row.ref.y).padStart(4)}  dy=${String(row.dy).padStart(3)}  dx=${String(row.dx).padStart(3)}  ${short(row.text)}`,
      );
    }
    continue;
  }

  if (moved.length) {
    console.log(`  moved (${moved.length}):`);
    console.log(`    ${"dx".padStart(4)} ${"dy".padStart(4)} ${"dw".padStart(4)}  ref@x,y      text`);
    for (const row of moved.slice(0, 24)) {
      console.log(
        `    ${String(row.dx).padStart(4)} ${String(row.dy).padStart(4)} ${String(row.dw).padStart(4)}  ` +
          `${String(`${row.ref.x},${row.ref.y}`).padEnd(12)} ${short(row.text)}`,
      );
    }
    if (moved.length > 24) console.log(`    ... and ${moved.length - 24} more`);
  }

  if (restyled.length) {
    console.log(`  different type (${restyled.length}):`);
    for (const { ref, app } of restyled.slice(0, 12)) {
      const bits = [];
      if (ref.size !== app.size) bits.push(`size ${ref.size} -> ${app.size}`);
      if (ref.weight !== app.weight) bits.push(`weight ${ref.weight} -> ${app.weight}`);
      if (ref.spacing !== app.spacing) bits.push(`spacing ${ref.spacing} -> ${app.spacing}`);
      if (ref.family !== app.family) bits.push(`family ${ref.family} -> ${app.family}`);
      console.log(`    ${short(ref.text).padEnd(44)} ${bits.join(", ")}`);
    }
    if (restyled.length > 12) console.log(`    ... and ${restyled.length - 12} more`);
  }

  // Said out loud: a string only the mock has is copy the app never shipped
  // (or shipped differently), and a string only the app has is the reverse.
  // Both are convergence work, and neither shows up as "moved".
  if (orphans.length) {
    console.log(`  only in the reference (${orphans.length}):`);
    for (const row of orphans.slice(0, 10)) console.log(`    ${short(row.text)}`);
    if (orphans.length > 10) console.log(`    ... and ${orphans.length - 10} more`);
  }
  if (extra.length) {
    console.log(`  only in the app (${extra.length}):`);
    for (const row of extra.slice(0, 10)) console.log(`    ${short(row.text)}`);
    if (extra.length > 10) console.log(`    ... and ${extra.length - 10} more`);
  }
}

// Frames COMPARED, not frames found. A run where every probe was missing
// used to end "0 of 5 frames carry drift" and exit 0, which reads as the
// all-clear it is the opposite of - and is reachable without any mistake,
// since only the home, session and wiz gates write an app-side probe.
console.log(`\n${framesWithDrift} of ${framesCompared} compared frames carry drift`);
if (framesCompared === 0) {
  console.error(
    `no app probes in ${appDir} — nothing was compared. Re-run the gate with RIG_PROBE=1` +
      ` (only the home, session and wiz gates write one).`,
  );
  process.exit(2);
}
