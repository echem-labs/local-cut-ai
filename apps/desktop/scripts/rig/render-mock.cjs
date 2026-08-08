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
const { COLLECT } = require("./textprobe.cjs");

// The offscreen frame inherits the PRIMARY display's scale at launch, and
// capturePage returns physical pixels — on a 125% display the "960-wide"
// references came out 1202 wide and poisoned every geometry downstream.
// Offscreen rendering has no window manager to fight, so forcing 1 here is
// deterministic on every box.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Electron's default handler for an uncaught main-process throw is a modal
// error box that waits for OK — which on a headless run is not a failure
// but a hang, with no output to say why. Print and exit instead. (Earned:
// one stray backtick inside a SNAP block turns the CSS into a tagged
// template call, and the run wedged with an empty stdout.)
process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

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
      [
        "session-clip-rendering",
        "session-mock.html?view=session-clip-rendering",
      ],
    ],
  },
  /* The flowchart panel (U4). Not a window: the canvas is one panel of the
     workspace, so the frame is the panel and the gate clips the app to it.
     Fixed size — the mock's own `.panel` box IS the frame, drawn to what
     the panel measures in a 1440x900 window (see parity-canvas.mjs). */
  canvas: {
    width: 629,
    height: 143,
    states: [["canvas", "canvas-mock.html"]],
  },
  /* The out-of-memory failure card (U5). Same doctrine as the canvas set:
     not a window, and not even a panel — the card sits past the fold of a
     scrolling inspector, so the frame is the card's own box at the size it
     measures in a 1440x900 window (see parity-u5.mjs). */
  u5: {
    width: 388,
    height: 142,
    states: [["inspector-failure", "u5-mock.html"]],
  },
  /* About (U6). The mock is a 640px reading column on a padded body, and
     the app's About pane is the same column inside the Settings layer —
     so the frame is `main`, not a window, and the gate clips the app to
     the pane's own box (see parity-u6.mjs). */
  about: {
    width: 640,
    states: [["about", "about-mock.html"]],
  },
};
const setName = arg("set", "wizard");
const SET = SETS[setName];
if (!SET) {
  console.error(
    `unknown --set ${setName}; expected one of ${Object.keys(SETS).join(", ")}`,
  );
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
  home: [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".tool .well",
    ".models",
  ],
  "home-downloads": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".dlsum",
    ".tool .well",
    ".models",
  ],
  "home-downloads-open": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".dlsum",
    ".srow .st",
    ".srow .model",
    ".tool .well",
    ".models",
  ],
  "home-empty": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".tool .well",
    ".models",
  ],
  library: [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".libbar .seg",
    ".chip",
  ],
  "library-tools": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".libbar .seg",
    ".chip",
  ],
  "library-menu": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".libbar .seg",
    ".chip",
  ],
  /* The card masks only its warning mark: a 14px lucide triangle in the
     app, a text glyph here. Everything else in the frame IS the design. */
  "inspector-failure": [".head .mark"],
  "wiz-1": [".mark"],
  "wiz-2": [],
  "wiz-3": [".row .meta", ".row .check", ".primary", ".hintline"],
  "wiz-3lib": [
    ".mrow .meta",
    ".mrow .check",
    ".mrow .badge",
    ".libfilter",
    ".primary",
    ".hintline",
  ],
  "wiz-4": [".srow .st", ".overall", ".sub"],
  /* session set (U3). Same doctrine: tiles, rail glyphs and counts as the
     home set; plus — the status row (model name and wall time are live),
     the wave plot and player (the bars are the artifact's real peaks and
     the player is native browser chrome), the image preview (a generated
     slate), and the small lucide-vs-unicode glyphs inside controls (the
     tool-head icon and close button, the swatch play cells, the models
     readiness dot). Geometry is checked for every one of them. */
  "panel-script": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".tool .well",
    ".models",
    ".phead .ticon",
    ".phead .x",
  ],
  "panel-voiceover": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".tool .well",
    ".models",
    ".phead .ticon",
    ".phead .x",
    ".swatch .play",
  ],
  "panel-clip": [
    ".tile .thumb",
    ".tile .tbody",
    ".rail .item .count",
    ".rail .item .glyph",
    ".tool .well",
    ".models",
    ".phead .ticon",
    ".phead .x",
    ".ghost.sf",
  ],
  "session-script": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".status",
    ".composer .models",
  ],
  "session-voiceover": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".status",
    ".waveplot",
    ".wtoggle",
    ".wtime",
    ".actions .ghost",
    ".clone .box",
    ".composer .models",
  ],
  "session-music": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".status",
    ".waveplot",
    ".wtoggle",
    ".wtime",
    ".actions .ghost",
    ".composer .models",
  ],
  "session-image": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".status",
    ".preview",
    ".actions .ghost",
    ".composer .models",
  ],
  "session-clip-rendering": [
    ".rail .item .count",
    ".rail .item .glyph",
    ".status",
  ],
  /* canvas set (U4). The graph's GEOMETRY is the whole point of this frame,
     so almost nothing is masked — the layout is derived and the pose is
     fixed, which is exactly what makes the node grid diffable. What is
     masked is what the two renderers draw differently rather than what the
     data says: the search glyph and the help mark (unicode here, lucide
     paths in the app), and the one node thumbnail (a JPEG here, a generated
     artifact there). */
  canvas: [".search .gl", ".help", ".thumb"],
  /* About (U6). Each region is a decision or a machine fact, never a
     difference waived to get green:
     - `.mark` — the app draws the Cut-Play mark as an SVG, the mock as a
       CSS box with a clip-path triangle.
     - `.uptodate` — the update controls do not render until a release feed
       is configured (plan U6: "the button hides behind a config flag"), so
       the gate poses a feed and the check runs "just now" against the
       mock's "2 hours ago".
     - `.whatsnew` — the same row, the same reason.
     - `.chips` — this machine's GPU, RAM and free disk. The mock names an
       RTX 3080; the reference would otherwise gate whatever the runner has.
     - `.kv dd` — the same, one step down: tier, backend chain, engine URL
       and data folder are all facts about the box the gate runs on. The
       `dt` labels beside them are NOT masked; those are the design.
     - `.privacy p` — the app names itself "LocalCut AI" where the mock
       wrote "LocalCut", so the sentence wraps at a different word.
     What stays diffed and costs a little: the pane title, where the app
     draws a lucide mark and the mock a unicode glyph. It is under a tenth
     of a percent, and a mask big enough to hide it would take the word
     "About" out of the frame with it. */
  about: [".mark", ".uptodate", ".whatsnew", ".chips", ".kv dd", ".privacy p"],
};
const MASK_PAD = 6;

const FONT = pathToFileURL(
  path.resolve(
    __dirname,
    "..",
    "..",
    "src",
    "assets",
    "fonts",
    "InterVariable.woff2",
  ),
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
/* Form controls do not inherit font-family. No mock says otherwise, so
   every button in every reference was drawn in the UA default (Arial on
   this box) while the app draws Inter — "Copy diagnostics" measured 99px
   in the reference and 106px in the app, and every row a button sat in was
   off by the difference. The app's reset gives controls the body face; the
   reference has to as well, or the font injected above reaches only half
   the frame. */
button, input, select, textarea { font-family: inherit !important; }
* { animation: none !important; transition: none !important; }
/* The app's captures hide the scrollbar; the mock must too. Otherwise a
   frame whose content lands within a pixel of the window reserves 15px,
   which re-flows an auto-fill grid into a whole extra column. */
::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
/* app body has no line-height override — UA normal, not the mock's 1.5.
   !important: the mock sets it via the font shorthand and insertCSS does
   not reliably out-cascade the document sheet.

   The bare body selector, NOT the descendant form: line-height inherits,
   so this already reaches every element that does not state one - which
   is the whole intent - while leaving alone the ones that do. The
   descendant form reached those too, and a mock stating a height is a
   mock agreeing with the app: the session's script table says 18px, as
   the app's .script-table does, and stomping it to normal made every row
   6px short and the last one 45px out of place. Where the mock states a
   height the app does not share, the snap blocks below say so by name. */
body { line-height: normal !important; }
/* one control height (--control-h 32) and the app button type sizes */
.primary { min-height: 32px !important; font-size: 14px !important; padding: 8px 16px !important; }
/* The app's .btn-primary states line-height:1 and says why: at 18px the
   14px label makes 8+18+8 = 34, one taller than every control beside it
   in the composer row, and --control-h stops deciding the height. The
   mocks that state a line box here say 18. */
.primary { line-height: 1 !important; }
.ghost { min-height: 32px !important; font-size: 13px !important; padding: 8px 12px !important; }
.link { font-size: 14px !important; }
/* the app's one eyebrow letter-spacing */
.steps, .srow .stage { letter-spacing: .1em !important; }
/* ...and its one eyebrow line box. The blanket line-height:normal above is
   right wherever the app inherits the UA's and wrong on every row where
   the app states a height instead - and the app's .eyebrow rule states 16
   for exactly this reason: an 11px line left to Inter's metrics rounds one
   way in the app and the other here. It is 2-3px per heading, and it
   accumulates: the wizard's library draws five group headings above its
   last model row, which sat 12px low. */
.eyebrow { line-height: 16px !important; }
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

/* ---- the window's own chrome, shared by every mock that draws it.
   The rail and the title bar are ONE shipped component pair; the home and
   session mocks each hand-drew them, so a snap that lived in the home
   block left the session's rail 3px tall in places and its brand in the
   wrong weight - the same difference, gated on one screen and waived on
   the other. */
const SNAP_SHELL = `
/* rail rows are --text-s, and the readiness button is an --control-h icon */
.rail .item { font-size: 14px !important; }
/* the rail's group label sits on the rail's own rhythm, not the wizard's */
.rail .group { margin-top: 0 !important; }
/* the shipped engine chip is 11/10 type on a 44px box, not the mock's 12/11 */
.rail .engine { min-height: 44px !important; padding: 8px !important; border-radius: 6px !important; }
.rail .engine b { font-size: 11px !important; }
.rail .engine small { font-size: 10px !important; }
.models { width: 32px !important; height: 32px !important; }
.titlebar { height: 38px !important; }
/* the brand is the app's own type: --text-xs at the brand weight, where the
   mock hand-set 12.5px/400. 12.5 is not on the scale, and 650 is the same
   weight About's heading was snapped to in U6 */
.titlebar { font-size: 12px !important; font-weight: 650 !important; letter-spacing: -0.01em !important; }
/* ...but only the brand. The project name beside it is the app's
   .tb-project - same size, normal weight, no tracking - and the mock
   writes the brand as a bare text node, so the weight has to be set on
   the bar and taken back here. */
.titlebar .proj { font-weight: 400 !important; letter-spacing: normal !important; }
body { padding-top: 38px !important; }
.frame { min-height: calc(100vh - 38px) !important; }
`;

/* ---- the home set's snaps (same rule: each one is a token the app owns) */
const SNAP_HOME = `
/* 12.5px is not on the scale: --text-xs everywhere it appears */
.tbody .t, .shelfhead a, .search, .srow .st, .overall, .fromtpl, .dlsum, .note,
.rail .item, .sortmenu div, .menu div { font-size: 12px !important; }
/* the 4px grid where the mock sits off it */
.fromtpl { margin-top: 12px !important; }
/* ...and the app's stated 16px line box. Both sides drew this row at
   whatever Inter's metrics made of a 12px line, and the fraction rounded
   differently on each - one pixel, inherited by the downloads panel under
   it, which then drew all fourteen of its borders on the wrong row. */
.fromtpl { line-height: 16px !important; }
.toolhead { margin: 24px 0 12px !important; }
.shelfhead { margin: 32px 0 12px !important; }
/* a seg-toggle's cells sit inside its border, so 30 + 2 is the app's 32 */
.seg span, .sortwrap .chip { min-height: 30px !important; align-items: center !important; }
/* Generate carries the app's min-width so the row's right edge matches */
.primary { min-width: 128px !important; justify-content: center !important; }
/* ...and its HEIGHT, which nothing else was pinning. The mock writes the
   CTA's icon as a "✦" character, and that glyph falls back to a font whose
   line box is 35px - taller than the button, so it won over the mock's own
   min-height of 32px. A fallback glyph was therefore deciding the height of
   the CTA, and with it the prompt box's control row, and with that every
   row below the prompt: the whole main column sat 3px high. --control-h is
   32 and the mock already says 32; this stops a font from disagreeing. */
.primary { height: 32px !important; }
.hero .row { padding: 12px !important; }
/* the shipped page gutter (main.content) is 32px, not the mock's 24 */
.page { padding: 32px 32px 40px !important; }
.sub { margin: 8px 0 16px !important; }
/* the empty card's box on the 4px grid, and its buttons at --text-xs */
.empty { margin-top: 16px !important; padding: 24px !important; }
.empty h2 { font-size: 16px !important; }
.empty p { font-size: 12px !important; margin: 8px 0 12px !important; }
/* The starter rows are the app's ghost BUTTON, which is what they are - one
   click each, and they set the prompt. So they carry its box: 13/18 type on
   a 32px floor, not the mock's 12.5px span. The old snap took them to 12px,
   which was neither the mock's value nor the app's, and left every row 3px
   short - the three rows drifted 2, 1 and 4px apart down the card. */
.empty .tpl span {
  font-size: 13px !important;
  line-height: 18px !important;
  padding: 8px 12px !important;
}
/* quick-tool cards are the app's --space-3 box with a 76px floor */
.tool { padding: 12px !important; min-height: 76px !important; }
.tools { gap: 8px !important; }
.seg span { padding: 4px 12px !important; display: inline-flex !important; align-items: center !important; }
/* tiles: the app's tile body padding, meta gap and 12px grid gaps */
.tbody { padding: 8px 10px !important; }
.tbody .m { margin-top: 4px !important; }
.grid { gap: 12px !important; }
/* the shelf head is an eyebrow at the app's letter-spacing (its line box
   is snapped in SNAP_COMMON, where every set needs it) */
.eyebrow { letter-spacing: .1em !important; }
`;

/* ---- the session set's snaps: authored ON the token scale, so what it
   needs is protection from SNAP_COMMON's wizard-shaped rules — the wizard's
   .actions sit 24px under a form; the session's ride the column's 16px flex
   gap. */
const SNAP_SESSION = `
.actions { margin-top: 0 !important; }
/* The script table's header row is the only cell in it that forgets to
   state a line box; the app gives th and td the same 18px, and left to
   Inter's metrics at 11px the reference's header was 4px short - which
   the whole table inherited. */
.stable th { line-height: 18px !important; }
`;

/* ---- the u5 set's snap. The app's `.chip` pins an 18px line box (it is
   what anchors the chip-row's rhythm), and SNAP_COMMON's blanket
   line-height:normal would otherwise draw every chip 3px shorter here than
   the app draws it. */
const SNAP_U5 = `
.chip { line-height: 18px !important; }
`;

/* ---- the about set's snaps. The mock's card geometry already IS the
   token scale (surface-1 on border at radius-m, 16px padding), so what is
   left is type: a 12.5/13px reading size that predates --text-xs, a name
   one step above --text-s, and a key column the app's own .kv fixes at
   140px. Snapping these is what makes the remaining pixels mean
   something. */
const SNAP_ABOUT = `
/* The mock centres its column inside a 36px-padded body. Drop the padding
   so the frame IS the 640px reading column and nothing else — the app's
   pane is clipped to the same column, and a frame carrying the mock's page
   margins would be diffing the margin against the Settings layer. */
body { padding: 0 !important; }
/* The title and the line under it belong to the SETTINGS pane, not to
   About: every pane draws the same .settings section h2 (--text-s at 650,
   --space-2 under it) over the same .hint (--text-xs on a 16px rhythm
   anchor, --space-3 to what follows). The mock's 16px/1.5 title is a pixel
   taller than every other pane's, and that pixel shifts the whole column. */
h1 { font-size: 14px !important; font-weight: 650 !important; }
.sub { margin: 8px 0 12px !important; line-height: 16px !important; }
/* The one colour this file snaps, and it is deliberate. Everywhere else
   colour stays the mock's, because a gate that recolours the reference to
   match the app gates nothing. Here the mock drew About's subtitle one
   step brighter (--text-secondary) than the .hint every other Settings
   pane uses, and About is not a special pane: the alternative is one
   subtitle in Settings that does not match its seven siblings. */
.sub { color: #767b88 !important; }
.sub, h2, .whatsnew, .links { font-size: 12px !important; }
/* SNAP_COMMON's .chips rule is the WIZARD's - there the chip row follows a
   paragraph and needs the gap. Here it is the card's first child, as the
   app's .spec-chips is, so the rule has to be taken back or the whole card
   below it sits 12px low. (The split-by-set comment above this block is
   about exactly this hazard; the about mock shares three class names with
   the wizard's.) */
.chips { margin-top: 0 !important; }
.vrow .name { font-size: 14px !important; }
.vrow .ver, .ok, .kv dd, .whatsnew a, .privacy p { font-size: 12px !important; }
/* The app's .btn-ghost is 13px on an 18px rhythm anchor inside 8/12 padding
   and a border - 36px, not the 32px floor SNAP_COMMON states. Left at 32
   the whole Support card, and everything under it, sat 4px high. */
.ghost { min-height: 32px !important; line-height: 18px !important; }
/* the app's .kv, which About shares with the pairing review: a 140px key
   column on --space-2/--space-3 gaps, keys at --text-s over mono values at
   --text-xs */
.kv { grid-template-columns: 140px 1fr !important; gap: 8px 12px !important; font-size: 14px !important; }
.privacy b { font-size: 14px !important; }
/* the version card is a grid in the app: one --space-4 gap serves both the
   mark-to-name column and the row above the checked-at line */
.vrow { gap: 16px !important; }
.whatsnew { margin-top: 16px !important; }
/* the mock's 22/14px vertical rhythm is hand-tuned off the scale; the
   app's --space-6 / --space-3 win */
h2 { margin-top: 24px !important; margin-bottom: 8px !important; }
/* the mock's own .card + h2 (14px) would out-specify the rule above, so
   it is restated: the app's section heading keeps --space-6 above it
   whatever precedes it. No backticks in here - this block IS a template
   literal, and one would close it. */
.card + h2 { margin-top: 24px !important; }
/* and the card under a heading rides the heading's --space-2, not a
   margin of its own */
h2 + .card { margin-top: 0 !important; }
.card + .card { margin-top: 12px !important; }
/* The privacy card is set apart from the stack above it. Two classes, not
   one: a bare .privacy loses to .card + .card on specificity and the extra
   air silently disappears - which is the bug this snap found in the app's
   own sheet, where .about-privacy lost to .about-card + .about-card the
   same way. */
.card.privacy { margin-top: 24px !important; }
.links { gap: 16px !important; margin-top: 16px !important; }
`;

const SNAP =
  SNAP_COMMON +
  /* the two sets whose mocks draw the whole window */
  (setName === "home" || setName === "session" ? SNAP_SHELL : "") +
  (setName === "home" ? SNAP_HOME : "") +
  (setName === "session" ? SNAP_SESSION : "") +
  (setName === "u5" ? SNAP_U5 : "") +
  (setName === "about" ? SNAP_ABOUT : "");

async function render(win, name, file) {
  const [base, query] = file.split("?");
  const url = `${pathToFileURL(path.join(mocksDir, base)).href}${query ? `?${query}` : ""}`;
  await win.loadURL(url);
  await win.webContents.insertCSS(SNAP, { cssOrigin: "author" });
  await win.webContents.executeJavaScript(
    "document.fonts.ready.then(() => null)",
  );
  // Two frames so the font swap has painted before measuring.
  await win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  // body is min-height:100vh, so its box reports the viewport, not the
  // content; the card is the content — its bottom edge (padding included)
  // is the true page height.
  const height =
    SET.height ??
    (await win.webContents.executeJavaScript(
      setName === "home"
        ? "Math.max(640, Math.ceil(document.getElementById('main').getBoundingClientRect().bottom) + 40)"
        : setName === "session"
          ? "Math.max(640, Math.ceil(document.querySelector('.page > .col').getBoundingClientRect().bottom) + 40)"
          : setName === "about"
            ? "Math.ceil(document.querySelector('main').getBoundingClientRect().bottom)"
            : "Math.ceil(document.querySelector('.card').getBoundingClientRect().bottom)",
    ));
  // Resize, then paint the frame fresh: an offscreen window that grows after
  // painting composites the old frame under the new one, which ghosts
  // anything positioned against a moved edge.
  win.setContentSize(SET.width, height);
  await win.loadURL(url);
  await win.webContents.insertCSS(SNAP, { cssOrigin: "author" });
  await win.webContents.executeJavaScript(
    "document.fonts.ready.then(() => null)",
  );
  await win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  console.log(`${name}.png ${SET.width}x${height}`);

  // Where the mock puts its text, for the convergence probe. Written beside
  // the frame rather than gated behind a flag: it is a few KB, it is only
  // meaningful for the reference it was measured from, and a probe you have
  // to remember to enable is one that is stale when you finally look.
  const text = await win.webContents.executeJavaScript(COLLECT);
  fs.writeFileSync(
    path.join(outDir, `${name}.text.json`),
    JSON.stringify(text, null, 1),
  );

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
    fs.writeFileSync(
      path.join(outDir, "masks.json"),
      JSON.stringify(masks, null, 1),
    );
    console.log("masks.json written");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
