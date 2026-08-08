/**
 * Pixel-parity gate (plan doc 11, rule 3).
 *
 * Diffs app screenshots against full-res reference captures with
 * per-screen masks over data-bearing regions; pass = differing pixels
 * outside masks <= 1%. Emits an HTML contact sheet (ref | app | diff).
 *
 * Usage: node compare.mjs --refs <dir> --shots <dir> [--masks masks.json]
 *   masks.json: { "<name>.png": [ {x, y, width, height}, ... ] }
 *
 * References must be re-rendered with the app's bundled Inter injected
 * before they are comparable (see the plan; mock sources live in the
 * specs repo under artifacts/mocks/).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const refsDir = arg("refs");
const shotsDir = arg("shots");
const masksPath = arg("masks");
if (!refsDir || !shotsDir) {
  console.error("usage: node compare.mjs --refs <dir> --shots <dir> [--masks masks.json]");
  process.exit(2);
}
const masks = masksPath ? JSON.parse(readFileSync(masksPath, "utf8")) : {};
const outDir = path.join(shotsDir, "diff");
mkdirSync(outDir, { recursive: true });

const rows = [];
let failures = 0;
for (const name of readdirSync(refsDir).filter((file) => file.endsWith(".png"))) {
  const shotPath = path.join(shotsDir, name);
  if (!existsSync(shotPath)) {
    console.error(`MISS ${name} - no app screenshot`);
    failures += 1;
    continue;
  }
  const ref = PNG.sync.read(readFileSync(path.join(refsDir, name)));
  const shot = PNG.sync.read(readFileSync(shotPath));
  if (ref.width !== shot.width || ref.height !== shot.height) {
    console.error(
      `FAIL ${name} - size mismatch ref ${ref.width}x${ref.height} vs app ${shot.width}x${shot.height}`,
    );
    failures += 1;
    continue;
  }
  const diff = new PNG({ width: ref.width, height: ref.height });
  const differing = pixelmatch(ref.data, shot.data, diff.data, ref.width, ref.height, {
    threshold: 0.1,
  });
  // Count masked pixels out of the failure budget.
  //
  // Marked once, not summed per region: masks overlap (a tile's thumb and
  // its body share an edge, the rail's icon sits inside its row), and adding
  // each region's tally counted every shared pixel as many times as regions
  // covered it. The subtraction then over-ran the total — `library` reported
  // -813 differing px, which is not a number a pixel count can take, and in
  // the other direction it is a frame passing on pixels it never masked.
  const maskedPixels = new Uint8Array(ref.width * ref.height);
  for (const region of masks[name] ?? []) {
    const x0 = Math.max(0, region.x);
    const y0 = Math.max(0, region.y);
    const x1 = Math.min(ref.width, region.x + region.width);
    const y1 = Math.min(ref.height, region.y + region.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) maskedPixels[y * ref.width + x] = 1;
    }
  }
  let masked = 0;
  for (let at = 0; at < maskedPixels.length; at++) {
    if (!maskedPixels[at]) continue;
    const index = at * 4;
    // pixelmatch paints differing pixels red-ish; detect by alpha+color
    if (diff.data[index] === 255 && diff.data[index + 1] === 0) masked += 1;
  }
  const outside = differing - masked;
  // Impossible by construction, and it happened: a count of pixels cannot be
  // negative, and the day it is, the number beside every other frame is
  // wrong too. Loud, not clamped.
  if (outside < 0) {
    console.error(
      `FAIL ${name} - masked (${masked}) exceeds differing (${differing}); the mask counter is broken`,
    );
    failures += 1;
    continue;
  }
  const budget = ref.width * ref.height * 0.01;
  const ok = outside <= budget;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} - ${outside} differing px outside masks (budget ${Math.round(budget)})`,
  );
  writeFileSync(path.join(outDir, name), PNG.sync.write(diff));
  rows.push({ name, ok, outside });
}

const sheet = rows
  .map(
    (row) => `
  <h2>${row.name} — ${row.ok ? "pass" : `FAIL (${row.outside}px)`}</h2>
  <div style="display:flex;gap:8px">
    <figure><figcaption>reference</figcaption><img src="${path.relative(outDir, path.join(refsDir, row.name))}"></figure>
    <figure><figcaption>app</figcaption><img src="${path.relative(outDir, path.join(shotsDir, row.name))}"></figure>
    <figure><figcaption>diff</figcaption><img src="${row.name}"></figure>
  </div>`,
  )
  .join("\n");
writeFileSync(
  path.join(outDir, "contact-sheet.html"),
  `<style>img{max-width:32vw;border:1px solid #888}figure{margin:0}</style>${sheet}`,
);
console.log(`contact sheet: ${path.join(outDir, "contact-sheet.html")}`);
process.exit(failures > 0 ? 1 : 0);
