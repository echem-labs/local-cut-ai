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

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const refDir = arg("ref");
const appDir = arg("app");
const only = arg("frame");
const TOL = Number(arg("tol", "0"));
if (!refDir || !appDir) {
  console.error("usage: node converge.mjs --ref <refs-dir> --app <shots-dir> [--frame name] [--tol n]");
  process.exit(2);
}

const frames = readdirSync(refDir)
  .filter((file) => file.endsWith(".text.json"))
  .map((file) => file.replace(/\.text\.json$/, ""))
  .filter((name) => !only || name === only);

if (frames.length === 0) {
  console.error(`no text probes in ${refDir} — re-render the references`);
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
  const byText = new Map();
  for (const row of appRows) {
    const k = key(row.text);
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(row);
  }
  const pairs = [];
  const orphans = [];
  for (const row of refRows) {
    const bucket = byText.get(key(row.text));
    if (!bucket || bucket.length === 0) {
      // A row whose text is only punctuation or a lone icon glyph carries
      // no label to match on; it is the pixel diff's business, not this.
      if (key(row.text)) orphans.push(row);
      continue;
    }
    pairs.push([row, bucket.shift()]);
  }
  const extra = [...byText.values()].flat();
  return { pairs, orphans, extra };
};

const short = (text) => (text.length > 42 ? `${text.slice(0, 39)}...` : text);

let framesWithDrift = 0;
for (const name of frames) {
  const refPath = path.join(refDir, `${name}.text.json`);
  const appPath = path.join(appDir, `${name}.text.json`);
  if (!existsSync(appPath)) {
    console.log(`\n### ${name}\n  no app probe — run the gate with RIG_PROBE=1`);
    continue;
  }
  const refRows = JSON.parse(readFileSync(refPath, "utf8"));
  const appRows = JSON.parse(readFileSync(appPath, "utf8"));
  const { pairs, orphans, extra } = pair(refRows, appRows);

  const moved = pairs
    .map(([ref, app]) => ({
      text: ref.text,
      dx: app.x - ref.x,
      dy: app.y - ref.y,
      dw: app.width - ref.width,
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

  // Down the page in order, which is how vertical drift is actually read:
  // a block that starts 4px high carries everything under it, so the row
  // where dy first changes is the one to fix, not the forty below it.
  if (process.argv.includes("--chain")) {
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

console.log(`\n${framesWithDrift} of ${frames.length} frames carry drift`);
