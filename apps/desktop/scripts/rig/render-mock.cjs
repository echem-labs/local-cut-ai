/**
 * Re-render design-mock HTML into comparable reference PNGs (plan doc 11,
 * rule 3). The as-reviewed mocks never load the app's font — this box
 * resolves "Inter" to Noto Sans — so the raw reference PNGs are layout
 * truth, not glyph truth. This script renders the same mocks with the
 * app's bundled InterVariable injected, plus the SNAP block: the small,
 * enumerated set of places where the mock's hand-tuned values sit off the
 * app's token scale and the token deliberately wins (each snap is a
 * recorded deviation in the plan).
 *
 * Runs under the repo's Electron (no browser download):
 *   npx electron scripts/rig/render-mock.cjs --mocks <dir> --out <dir>
 * or via `npm run rig:refs -- --mocks ... --out ...`.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const mocksDir = arg("mocks");
const outDir = arg("out");
if (!mocksDir || !outDir) {
  console.error("usage: electron render-mock.cjs --mocks <dir> --out <dir>");
  app.exit(2);
  return;
}

/** The five wizard reference frames — name → mock query. */
const STATES = [
  ["wiz-1", "wizard-mock.html?step=1"],
  ["wiz-2", "wizard-mock.html?step=2"],
  ["wiz-3", "wizard-mock.html?step=3"],
  ["wiz-3lib", "wizard-mock.html?step=3&lib=1"],
  ["wiz-4", "wizard-mock.html?step=4"],
];

/**
 * Data-bearing regions per frame (plan rule 3: masked and pinned by seed
 * data instead of diffed). Measured from the rendered mock DOM so the
 * mask file can never drift from the reference it belongs to:
 * - install-state metas, byte totals and hint lines: the mock poses an
 *   inconsistent state (rows "already installed" AND "2 downloads") that
 *   no truthful app state can reproduce;
 * - the brand mark: the app draws it as an SVG, the mock as CSS;
 * - checks and badge clusters: native checkbox vs hand-drawn span, and
 *   the app's license badge carries a verdict glyph the mock omits;
 * - the library filter: the app hides won't-fit rows under "Fits this
 *   machine", so the greyed-rows frame is captured under "All models";
 * - step 4's status column, overall bar and stage-count sentence: live
 *   numbers.
 */
const MASKABLE = {
  "wiz-1": [".mark"],
  "wiz-2": [],
  "wiz-3": [".row .meta", ".row .check", ".primary", ".hintline"],
  "wiz-3lib": [".mrow .meta", ".mrow .check", ".mrow .badge", ".libfilter", ".primary", ".hintline"],
  "wiz-4": [".srow .st", ".overall", ".sub"],
};
const MASK_PAD = 6;

const FONT = pathToFileURL(
  path.resolve(__dirname, "..", "..", "src", "assets", "fonts", "InterVariable.woff2"),
).href;

/* Every rule below either injects the app's real font or snaps one mock
   value to the app token that the implementation uses. Nothing else —
   geometry, color, structure stay the mock's, or the gate gates nothing. */
const SNAP = `
/* format MUST be "woff2": Chromium rejects "woff2-variations" and the
   face silently never loads — fonts.ready still resolves. */
@font-face {
  font-family: "Inter";
  src: url("${FONT}") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}
* { animation: none !important; transition: none !important; }
/* app body has no line-height override — UA normal, not the mock's 1.5.
   !important: the mock sets it via the font shorthand and insertCSS does
   not reliably out-cascade the document sheet. */
body, body * { line-height: normal !important; }
/* one control height (--control-h 32) and the app button type sizes */
.primary { min-height: 32px !important; font-size: 14px !important; padding: 8px 16px !important; }
.ghost { min-height: 32px !important; font-size: 13px !important; padding: 8px 12px !important; }
.link { font-size: 14px !important; }
/* the app's one eyebrow letter-spacing */
.steps, .srow .stage { letter-spacing: .1em !important; }
/* type scale: 13.5 -> --text-s, 12.5 -> --text-xs, 11.5 -> --text-xs */
.row .name, .mrow .name, .srow .model, .verdict { font-size: 14px !important; }
.st, .overall { font-size: 12px !important; }
.mono, .srow small { font-size: 12px !important; font-family: Consolas, "Cascadia Mono", ui-monospace, monospace !important; }
.badge { font-size: 12px !important; padding: 1px 8px !important; }
.libfilter span { padding: 4px 12px !important; font-size: 12px !important; min-height: 30px !important; display: inline-flex !important; align-items: center !important; }
/* 4px-grid spacing where the mock sits off it */
.machine { margin-top: 24px !important; }
.actions { margin-top: 24px !important; }
.group { margin-top: 16px !important; }
.verdict, .hintline, .overall { margin-top: 12px !important; }
.chips { margin-top: 12px !important; }
.row { padding: 8px 12px !important; }
/* the app's shipped .model-row padding is 12px all round (Settings
   library) — the wizard reuses that component, so the mock follows */
.mrow { padding: 12px !important; margin-top: 0 !important; }
.mrow + .mrow { margin-top: 8px !important; }
.srow { margin-top: 0 !important; }
.srow + .srow { margin-top: 8px !important; }
.mrow .meta { margin-top: 2px !important; }
.st .bar { margin-top: 4px !important; }
`;

async function render(win, name, file) {
  const [base, query] = file.split("?");
  const url = `${pathToFileURL(path.join(mocksDir, base)).href}${query ? `?${query}` : ""}`;
  await win.loadURL(url);
  await win.webContents.insertCSS(SNAP, { cssOrigin: "author" });
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => null)");
  // Two frames so the font swap has painted before measuring.
  await win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  // body is min-height:100vh, so its box reports the viewport, not the
  // content; the card is the content — its bottom edge (padding included)
  // is the true page height.
  const height = await win.webContents.executeJavaScript(
    "Math.ceil(document.querySelector('.card').getBoundingClientRect().bottom)",
  );
  win.setContentSize(960, height);
  await win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  console.log(`${name}.png ${960}x${height}`);

  const rects = await win.webContents.executeJavaScript(`
    (${JSON.stringify(MASKABLE[name] ?? [])}).flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(r.left) - ${MASK_PAD}),
          y: Math.max(0, Math.round(r.top) - ${MASK_PAD}),
          width: Math.round(r.width) + ${MASK_PAD * 2},
          height: Math.round(r.height) + ${MASK_PAD * 2},
        };
      }),
    )
  `);
  return rects;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 960,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  // Deterministic pixels: no HiDPI scaling in the capture.
  win.webContents.setZoomFactor(1);
  try {
    const masks = {};
    for (const [name, file] of STATES) {
      masks[`${name}.png`] = await render(win, name, file);
    }
    fs.writeFileSync(path.join(outDir, "masks.json"), JSON.stringify(masks, null, 1));
    console.log("masks.json written");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
