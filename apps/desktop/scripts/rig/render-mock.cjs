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

// The offscreen frame inherits the PRIMARY display's scale at launch, and
// capturePage returns physical pixels — on a 125% display the "960-wide"
// references came out 1202 wide and poisoned every geometry downstream.
// Offscreen rendering has no window manager to fight, so forcing 1 here is
// deterministic on every box.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

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

/** Reference frames per set — name → mock query. `--set` picks one; the
 * wizard's frames are a 960-wide card, the home set is a whole window. */
const SETS = {
  wizard: {
    width: 960,
    states: [
      ["wiz-1", "wizard-mock.html?step=1"],
      ["wiz-2", "wizard-mock.html?step=2"],
      ["wiz-3", "wizard-mock.html?step=3"],
      ["wiz-3lib", "wizard-mock.html?step=3&lib=1"],
      ["wiz-4", "wizard-mock.html?step=4"],
    ],
  },
  home: {
    width: 1450,
    states: [
      ["home", "home-rail-mock.html?view=home"],
      ["home-downloads", "home-rail-mock.html?view=home-downloads"],
      ["home-downloads-open", "home-rail-mock.html?view=home-downloads-open"],
      ["home-empty", "home-rail-mock.html?view=home-empty"],
      ["library", "home-rail-mock.html?view=library"],
      ["library-tools", "home-rail-mock.html?view=library-tools"],
      ["library-menu", "home-rail-mock.html?view=library-menu"],
    ],
  },
  session: {
    width: 1450,
    states: [
      ["panel-script", "session-mock.html?view=panel-script"],
      ["panel-voiceover", "session-mock.html?view=panel-voiceover"],
      ["panel-clip", "session-mock.html?view=panel-clip"],
      ["session-script", "session-mock.html?view=session-script"],
      ["session-voiceover", "session-mock.html?view=session-voiceover"],
      ["session-music", "session-mock.html?view=session-music"],
      ["session-image", "session-mock.html?view=session-image"],
      ["session-clip-rendering", "session-mock.html?view=session-clip-rendering"],
    ],
  },
};
const setName = arg("set", "wizard");
const SET = SETS[setName];
if (!SET) {
  console.error(`unknown --set ${setName}; expected one of ${Object.keys(SETS).join(", ")}`);
  app.exit(2);
  return;
}
const STATES = SET.states;

/**
 * Data-bearing regions per frame (plan rule 3: masked and pinned by seed
 * data instead of diffed). Measured from the rendered mock DOM so the
 * mask file can never drift from the reference it belongs to:
 * - install-state metas, byte totals and hint lines: the mock poses an
 *   inconsistent state (rows "already installed" AND "2 downloads") that
 *   no truthful app state can reproduce;
 * - the brand mark and the rail's icon column: the app draws these as
 *   SVGs, the mock as a CSS box and unicode characters — the mask hides
 *   the drawing, and the geometry check keeps the position;
 * - checks and badge clusters: native checkbox vs hand-drawn span, and
 *   the app's license badge carries a verdict glyph the mock omits;
 * - the library filter: the app hides won't-fit rows under "Fits this
 *   machine", so the greyed-rows frame is captured under "All models";
 * - step 4's status column, overall bar and stage-count sentence: live
 *   numbers.
 */
const MASKABLE = {
  /* home/library: every tile carries engine data — a thumbnail the mock
     fakes with a JPEG, a title, a status word and a relative time. The
     frame gates the LAYOUT of the shelf and the chrome around it; what a
     tile says is the seed's business, and the geometry of these regions is
     checked against the reference boxes (parity-home.mjs). */
  home: [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".tool .well", ".models"],
  "home-downloads": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".dlsum", ".tool .well", ".models"],
  "home-downloads-open": [".rail .item .count", ".rail .item .glyph", ".dlsum", ".srow .st", ".srow .model", ".tool .well", ".models"],
  "home-empty": [".rail .item .count", ".rail .item .glyph", ".tool .well", ".models"],
  library: [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".libbar .seg", ".chip"],
  "library-tools": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".libbar .seg", ".chip"],
  "library-menu": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".libbar .seg", ".chip"],
  "wiz-1": [".mark"],
  "wiz-2": [],
  "wiz-3": [".row .meta", ".row .check", ".primary", ".hintline"],
  "wiz-3lib": [".mrow .meta", ".mrow .check", ".mrow .badge", ".libfilter", ".primary", ".hintline"],
  "wiz-4": [".srow .st", ".overall", ".sub"],
  /* session set (U3). Same doctrine: tiles, rail glyphs and counts as the
     home set; plus — the status row (model name and wall time are live),
     the wave plot and player (the bars are the artifact's real peaks and
     the player is native browser chrome), the image preview (a generated
     slate), and the small lucide-vs-unicode glyphs inside controls (the
     tool-head icon and close button, the swatch play cells, the models
     readiness dot). Geometry is checked for every one of them. */
  "panel-script": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".tool .well", ".models", ".phead .ticon", ".phead .x"],
  "panel-voiceover": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".tool .well", ".models", ".phead .ticon", ".phead .x", ".swatch .play"],
  "panel-clip": [".tile .thumb", ".tile .tbody", ".rail .item .count", ".rail .item .glyph", ".tool .well", ".models", ".phead .ticon", ".phead .x", ".ghost.sf"],
  "session-script": [".rail .item .count", ".rail .item .glyph", ".status"],
  "session-voiceover": [".rail .item .count", ".rail .item .glyph", ".status", ".waveplot", ".player", ".actions .ghost", ".clone .box"],
  "session-music": [".rail .item .count", ".rail .item .glyph", ".status", ".waveplot", ".player", ".actions .ghost"],
  "session-image": [".rail .item .count", ".rail .item .glyph", ".status", ".preview", ".actions .ghost"],
  "session-clip-rendering": [".rail .item .count", ".rail .item .glyph", ".status"],
};
const MASK_PAD = 6;

const FONT = pathToFileURL(
  path.resolve(__dirname, "..", "..", "src", "assets", "fonts", "InterVariable.woff2"),
).href;

/* Every rule below either injects the app's real font or snaps one mock
   value to the app token that the implementation uses. Nothing else —
   geometry, color, structure stay the mock's, or the gate gates nothing.

   Split by set on purpose: the home mock and the wizard mock share class
   names (.sub, .group, .row, .primary), so a home rule in the shared block
   silently re-lays-out the wizard's card and invalidates references nobody
   re-rendered. */
const SNAP_COMMON = `
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
/* The app's captures hide the scrollbar; the mock must too. Otherwise a
   frame whose content lands within a pixel of the window reserves 15px,
   which re-flows an auto-fill grid into a whole extra column. */
::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
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

/* ---- the home set's snaps (same rule: each one is a token the app owns) */
const SNAP_HOME = `
/* 12.5px is not on the scale: --text-xs everywhere it appears */
.tbody .t, .shelfhead a, .search, .srow .st, .overall, .fromtpl, .dlsum, .note,
.rail .item, .sortmenu div, .menu div { font-size: 12px !important; }
/* rail rows are --text-s, and the readiness button is an --control-h icon */
.rail .item { font-size: 14px !important; }
/* the rail's group label sits on the rail's own rhythm, not the wizard's */
.rail .group { margin-top: 0 !important; }
/* the shipped engine chip is 11/10 type on a 44px box, not the mock's 12/11 */
.rail .engine { min-height: 44px !important; padding: 8px !important; border-radius: 6px !important; }
.rail .engine b { font-size: 11px !important; }
.rail .engine small { font-size: 10px !important; }
.models { width: 32px !important; height: 32px !important; }
/* the 4px grid where the mock sits off it */
.fromtpl { margin-top: 12px !important; }
.toolhead { margin: 24px 0 12px !important; }
.shelfhead { margin: 32px 0 12px !important; }
/* a seg-toggle's cells sit inside its border, so 30 + 2 is the app's 32 */
.seg span, .sortwrap .chip { min-height: 30px !important; align-items: center !important; }
/* Generate carries the app's min-width so the row's right edge matches */
.primary { min-width: 128px !important; justify-content: center !important; }
.hero .row { padding: 12px !important; }
/* the shipped page gutter (main.content) is 32px, not the mock's 24, and
   the title bar is --titlebar-h 38 */
.page { padding: 32px 32px 40px !important; }
.titlebar { height: 38px !important; }
body { padding-top: 38px !important; }
.frame { min-height: calc(100vh - 38px) !important; }
.sub { margin: 8px 0 16px !important; }
/* the empty card's box on the 4px grid, and its buttons at --text-xs */
.empty { margin-top: 16px !important; padding: 24px !important; }
.empty h2 { font-size: 16px !important; }
.empty p { font-size: 12px !important; margin: 8px 0 12px !important; }
.empty .tpl span { font-size: 12px !important; padding: 8px 12px !important; }
/* quick-tool cards are the app's --space-3 box with a 76px floor */
.tool { padding: 12px !important; min-height: 76px !important; }
.tools { gap: 8px !important; }
.seg span { padding: 4px 12px !important; display: inline-flex !important; align-items: center !important; }
/* tiles: the app's tile body padding, meta gap and 12px grid gaps */
.tbody { padding: 8px 10px !important; }
.tbody .m { margin-top: 4px !important; }
.grid { gap: 12px !important; }
/* the shelf head is an eyebrow at the app's letter-spacing */
.eyebrow { letter-spacing: .1em !important; }
`;

/* ---- the session set's snaps: authored ON the token scale, so the only
   rule it needs is protection from SNAP_COMMON's wizard-shaped .group. */
const SNAP_SESSION = `
.rail .group { margin-top: 0 !important; }
`;

const SNAP =
  SNAP_COMMON +
  (setName === "home" ? SNAP_HOME : "") +
  (setName === "session" ? SNAP_SESSION : "");

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
    setName === "home"
      ? "Math.max(640, Math.ceil(document.getElementById('main').getBoundingClientRect().bottom) + 40)"
      : setName === "session"
        ? "Math.max(640, Math.ceil(document.querySelector('.page > .col').getBoundingClientRect().bottom) + 40)"
        : "Math.ceil(document.querySelector('.card').getBoundingClientRect().bottom)",
  );
  // Resize, then paint the frame fresh: an offscreen window that grows after
  // painting composites the old frame under the new one, which ghosts
  // anything positioned against a moved edge.
  win.setContentSize(SET.width, height);
  await win.loadURL(url);
  await win.webContents.insertCSS(SNAP, { cssOrigin: "author" });
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => null)");
  await win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  console.log(`${name}.png ${SET.width}x${height}`);

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
    width: SET.width,
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
