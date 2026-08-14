/**
 * U8 — the whole-app responsive sweep (plan doc 11).
 *
 * Every phase from U1 on added its own screens to `walk.mjs` and asserted
 * what that phase had just built. This asks the question none of those runs
 * could: is the APP responsive? The failures U0 found were interactions
 * between a viewport rule and something else, and an interaction is exactly
 * what per-phase checking cannot see — each phase looks at its own screen,
 * at the sizes it happened to choose, in the theme it happened to be in.
 *
 * So this file is a matrix rather than a script. It drives to every surface
 * in turn and runs ONE assertion set at each of eight window sizes — six
 * fixed, plus the two halves this display snaps to — in both
 * themes, and at three zoom levels on the stops that sit near a breakpoint.
 * The assertions live in `probe()` and know nothing about which screen they
 * are on; what each screen declares (its reading column, its grids, whether
 * it has workspace sashes) is data in STOPS.
 *
 * Reachability is part of the gate, not a precondition: a stop whose `go`
 * cannot get there FAILS. "A screen the walk could not reach is a failure,
 * not an absence" is the acceptance line, and every NOTE-and-continue in
 * walk.mjs is a place this run would rather go red.
 *
 * Isolation and determinism, both learned the hard way:
 *   LOCALCUT_USERDATA / LOCALCUT_DATA_DIR / LOCALCUT_ENGINE_PORT keep the
 *   developer's profile, database and engine out of it (see e2e's header).
 *   LOCALCUT_BACKEND=mock pins the generation chain. The app spawns its
 *   engine with `local,mock`, so on a machine with Ollama running the script
 *   tool reaches a REAL model — and if that model is not the engine's
 *   default it fails loudly, mid-sweep, for reasons that have nothing to do
 *   with layout. The sweep is about geometry; it gets the same content every
 *   time.
 *
 * Usage: node sweep.mjs [--ozone=x11] [--only=<substring of a stop id>]
 *
 * `--only` still DRIVES through every stop — each one navigates from where
 * the last left off — and measures just the ones that match. It is for
 * working on a single screen, and for proving the instrument still bites:
 * plant a break, run the one stop, watch it go red. A full run is the gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evalInApp,
  health,
  makeCheck,
  shotsDir,
  sizeWindowTo,
  startRig,
  stopRig,
} from "./rig.mjs";

const ozone = process.argv.find((arg) => arg.startsWith("--ozone="))?.slice(8);
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const dir = shotsDir(ozone ? `sweep-${ozone}` : "sweep");
const check = makeCheck();

/* ---------- the matrix ---------- */

/** 1000x700 is just above the app's 960x640 minimum; 980x800 is the rail's
 * own boundary. The rest are the sizes every phase gate has used. */
const SIZES = [
  { label: "1000x700", width: 1000, height: 700 },
  { label: "1200x800", width: 1200, height: 800 },
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "980x800", width: 980, height: 800 },
  { label: "maximized", maximize: true },
];

/** The eyeball pass wants the extremes of each screen, and 90 screenshots
 * is not a pass anyone performs. Shoot the narrowest and the widest. */
const SHOT_SIZES = new Set(["1000x700", "1920x1080"]);

/** Snap-left and snap-right, measured from the display rather than guessed.
 *
 * The plan reserved snapping as a manual line, on the grounds that it is the
 * window manager's behavior rather than the app's. Half of that is true: the
 * GESTURE is the compositor's, and on Wayland nothing this rig can reach will
 * perform it (there is no injection tool here, and gnome-shell's Eval is
 * off). What the app has to cope with is not the gesture, though — it is the
 * GEOMETRY the gesture leaves behind, and that is ordinary window bounds.
 *
 * Worth having as a size of its own rather than as an approximation of
 * 980x800: half of a 1920 display is 960, which is the app's minimum width
 * exactly, and a snapped window is the one shape a user reaches every day
 * that is simultaneously at the floor and full height. */
const snapSizes = (work) => {
  const width = Math.floor(work.width / 2);
  return [
    { label: "snap-left", width, height: work.height, x: work.x, y: work.y },
    { label: "snap-right", width, height: work.height, x: work.x + width, y: work.y },
  ];
};

/** Zoom is a second viewport: Ctrl +/- changes the CSS-pixel width, so it
 * crosses the same breakpoints a resize does. Run it where a step actually
 * crosses one — at 1200px, 125% leaves 960 CSS pixels, which is under the
 * rail's 1000px rule, and a rule that has only ever seen window resizes is
 * first found by a user who zoomed. */
const ZOOM_SIZE = { label: "1200x800", width: 1200, height: 800 };
const ZOOM_STEPS = [0.9, 1, 1.25];

const THEMES = ["dark", "light"];

/* ---------- fixtures ---------- */

const GB = 2 ** 30;
const license = { id: "apache-2.0", commercial: true, verdict: "commercial", notes: "" };
const gpu = { vendor: "NVIDIA", name: "NVIDIA GeForce RTX 3080", vram_gb: 8, backend: "cuda" };
const entry = (id, task, { external = false, family = "", version = "", size = GB } = {}) => ({
  id,
  task,
  family,
  version,
  quant: "",
  requirements: { vram_gb: 8, ram_gb: 8, disk_gb: 20, backends: [] },
  quality_score: 1,
  speed_score: 1,
  license,
  files: external ? [] : [{ url: "https://example.test/w", dest: "w", sha256: "0", size }],
  comfy_graph_template: "",
  custom: false,
  size_bytes: external ? 0 : size,
  // Installed, every one of them. This is a safety property, not a cosmetic
  // one: the wizard's primary button on the models step is "Download &
  // continue", and it starts REAL downloads of the recommended slate. The
  // sweep runs against a temp data dir where nothing is installed, so
  // without this fixture, walking the wizard to its fourth step would pull
  // tens of gigabytes down every run.
  downloaded: true,
  downloading: false,
  progress: null,
  partial_bytes: 0,
});

const MODELS = [
  entry("qwen3-8b-q4", "text.llm", { external: true, family: "qwen 3", version: "· 8B" }),
  entry("sdxl-base-1.0", "image.gen", { family: "sdxl", version: "1.0", size: 6.5 * GB }),
  entry("ltx-video-0.9-i2v", "video.i2v", { family: "ltx", version: "0.9", size: 11 * GB }),
  entry("kokoro-v1", "speech.tts", { family: "kokoro", version: "82M", size: 350 * 2 ** 20 }),
  entry("ace-step-v1-3.5b", "music.gen", { family: "ACE-Step", version: "3.5B", size: 7.2 * GB }),
  entry("faster-whisper-large-v3", "transcribe", { external: true, family: "whisper", version: "v3" }),
];

const SYSTEM = {
  hardware: {
    os: "linux",
    arch: "x86_64",
    ram_gb: 61.7,
    disk_free_gb: 87.6,
    gpus: [gpu],
    primary_gpu: gpu,
    tier: "A",
  },
  recommendations: [
    { task: "text.llm", model: MODELS[0], reason: "" },
    { task: "image.gen", model: MODELS[1], reason: "" },
    { task: "video.i2v", model: MODELS[2], reason: "" },
    { task: "speech.tts", model: MODELS[3], reason: "" },
    { task: "music.gen", model: MODELS[4], reason: "" },
    { task: "transcribe", model: MODELS[5], reason: "" },
  ],
  backend_mode: "mock",
};

/** Four fixed prompts, so a shelf that fits four columns has four tiles and
 * the Library has a page to lay out. Fixed rather than random: a run that
 * measured a different number of tiles each time would make every column
 * count a different question. */
const SEED_PROJECTS = [
  "A bee explains pollination to a skeptical flower",
  "How a lighthouse keeper spends a winter",
  "Three minutes inside a Roman bakery",
  "Why the sky is the colour it is",
];

/* ---------- driving ---------- */

const rail = (name) => `
  await page.evaluate((want) => {
    const label = (button) =>
      (button.textContent || "") + " " + (button.getAttribute("aria-label") || "");
    [...document.querySelectorAll(".rail button")]
      .find((button) => label(button).includes(want))
      ?.click();
  }, ${JSON.stringify(name)});
`;

/** Open a Settings pane by its tab label, from wherever the app is. */
const settingsPane = (label) => `
  await page.evaluate(() => {
    if (document.querySelector(".settings-layer")) return;
    const open = [...document.querySelectorAll("nav button")].find((b) =>
      /settings/i.test(b.getAttribute("aria-label") || b.textContent || ""));
    open?.click();
  });
  await page.waitForSelector(".settings-layer", { timeout: 10000 });
  await page.evaluate((name) => {
    const tab = [...document.querySelectorAll(".settings-grid nav button")].find(
      (b) => (b.textContent || "").trim() === name);
    tab?.click();
  }, ${JSON.stringify(label)});
  await page.waitForTimeout(400);
  return page.evaluate(() => !!document.querySelector(".settings-pane"));
`;

/**
 * Every surface the app has, in the order one run can reach them.
 *
 *   root     what the assertions are scoped to (the screen, not the shell)
 *   column   a READING surface's column and the cap it must honor
 *   grids    a BROWSING surface's shelves and the track floor each is
 *            declared with, so the column count can be derived rather than
 *            merely watched for shrinkage
 *   sashes   this stop mounts the dockview workspace
 *   zoom     this stop is run again at 90/100/125%
 */
const STOPS = [
  {
    id: "wizard/welcome",
    root: ".setup.wizard",
    column: { selector: ".setup.wizard", max: 660 },
    go: `
      await page.waitForSelector(".setup.wizard .wiz-body h1", { timeout: 30000 });
      return true;
    `,
  },
  {
    id: "wizard/machine",
    root: ".setup.wizard",
    column: { selector: ".setup.wizard", max: 660 },
    go: `
      await page.evaluate(() => document.querySelectorAll(".setup-actions button")[0]?.click());
      return page
        .waitForSelector(".setup-machine .spec-chips", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "wizard/models",
    root: ".setup.wizard",
    column: { selector: ".setup.wizard", max: 660 },
    go: `
      await page.evaluate(() => document.querySelectorAll(".setup-actions button")[0]?.click());
      return page
        .waitForSelector(".pipe-rail", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "wizard/library",
    root: ".setup.wizard",
    column: { selector: ".setup.wizard", max: 660 },
    // The full model library, which is the widest thing the wizard ever
    // shows: a filter, a row per model, and a license badge on each.
    go: `
      await page.evaluate(() => document.querySelectorAll(".setup-actions button")[1]?.click());
      return page
        .waitForSelector(".setup.wizard .model-row, .setup.wizard .filter-tabs", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "wizard/ready",
    root: ".setup.wizard",
    column: { selector: ".setup.wizard", max: 660 },
    // Back to the rail, then Continue. With every model in the fixture
    // installed there is nothing pending, so the primary is a plain
    // Continue and no download starts (see `entry`).
    go: `
      await page.evaluate(() => document.querySelectorAll(".setup-actions button")[1]?.click());
      await page.waitForSelector(".pipe-rail", { timeout: 10000 });
      await page.evaluate(() => document.querySelectorAll(".setup-actions button")[0]?.click());
      return page
        .waitForSelector(".setup.wizard .srow, .setup.wizard .overall", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "home",
    root: ".home",
    column: { selector: ".prompt-box", max: 840 },
    grids: [{ selector: ".recent .grid", track: 200 }],
    shelfEdges: true,
    zoom: true,
    go: `
      // Done with the wizard: its last action finishes first run.
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll(".setup-actions button")];
        (buttons.find((b) => /start|finish|done/i.test(b.textContent || "")) ?? buttons[0])?.click();
      });
      const home = await page
        .waitForSelector(".home", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (!home) return false;
      // Unfreeze: the wizard's fixture has done its job, and every screen
      // after this one should show what the engine actually says.
      await page.evaluate(() => window.__localcutSeed?.({ freeze: false }));

      // Give the shelves something to be shelves OF. A fresh profile's Home
      // has an empty state and no grid, and a grid that is not there passes
      // every assertion about grids — the exact shape of skipped check this
      // sweep exists to refuse.
      //
      // Made through the engine's own HTTP API, from the renderer, using the
      // connection the app itself is using: the desktop reaches the engine
      // over HTTP and nothing else, and a rig that wrote to the data
      // directory would be the first exception to that (doc 02).
      const made = await page.evaluate(async (prompts) => {
        const { connection } = await window.localcut.getEngineConnection();
        if (!connection) return 0;
        let count = 0;
        for (const prompt of prompts) {
          const response = await fetch(new URL("/projects", connection.url), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: \`Bearer \${connection.token}\`,
            },
            body: JSON.stringify({ prompt, target_duration_s: 60, aspect: "16:9" }),
          });
          if (response.ok) count += 1;
        }
        return count;
      }, ${JSON.stringify(SEED_PROJECTS)});
      if (made < ${SEED_PROJECTS.length}) return false;

      // Home refreshes its list on mount, so leave and come back rather than
      // waiting on a poll that may not be due.
      ${rail("Library")}
      await page.waitForSelector(".library", { timeout: 15000 });
      ${rail("Home")}
      await page.waitForSelector(".home", { timeout: 15000 });
      return page
        .waitForSelector(".recent .grid", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "home/clip-panel",
    root: ".home",
    // The widest controls row Home has — motion field, seconds, start
    // frame, aspect, generate — over a chip row that sits between the
    // textarea and the row, where nothing else would notice it escaping.
    go: `
      await page.evaluate(() => {
        const clip = [...document.querySelectorAll(".quick-tools button")].find((button) =>
          (button.getAttribute("aria-label") || "").startsWith("Clip"));
        clip?.click();
      });
      return page
        .waitForSelector(".tool-panel .chip-row", { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "library",
    root: ".library",
    grids: [{ selector: ".library .grid", track: 200 }],
    zoom: true,
    go: `
      await page.evaluate(() => document.querySelector(".tool-head .icon-btn")?.click());
      ${rail("Library")}
      return page
        .waitForSelector(".library", { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "tool-session",
    root: ".tool-shell",
    column: { selector: ".tool-shell", max: 840 },
    // A real run against the rig's own engine: the mock backend answers in
    // seconds, and the session page is the one reading surface that grows a
    // table from the engine's answer rather than from a fixture.
    go: `
      ${rail("Home")}
      await page.waitForSelector(".home", { timeout: 10000 });
      await page.evaluate(() => {
        const script = [...document.querySelectorAll(".quick-tools button")].find((button) =>
          (button.getAttribute("aria-label") || "").startsWith("Script"));
        script?.click();
      });
      await page.waitForSelector(".tool-panel .chip-row", { timeout: 10000 });
      await page.type(".tool-panel textarea", "How the sweep found its screens");
      const buttons = await page.$$(".tool-panel .row button");
      await buttons[buttons.length - 1].click();
      await page.waitForSelector(".tool-shell", { timeout: 30000 });
      return page
        .waitForSelector(".script-table", { timeout: 60000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "workspace/storyboard",
    root: ".dockview-theme-localcut",
    grids: [{ selector: ".scene-grid", track: 240 }],
    sashes: true,
    zoom: true,
    go: `
      await page.evaluate(() => {
        const button = [...document.querySelectorAll(".tool-actions button")].find((b) =>
          /turn into a video/i.test(b.textContent || ""));
        button?.click();
      });
      const mounted = await page
        .waitForSelector(".dockview-theme-localcut", { timeout: 60000 })
        .then(() => true)
        .catch(() => false);
      if (!mounted) return false;
      return page
        .waitForSelector(".tl-scroll", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
  {
    id: "workspace/flowchart",
    root: ".dockview-theme-localcut",
    sashes: true,
    go: `
      await page.evaluate(() => {
        const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((b) =>
          /view/i.test(b.getAttribute("aria-label") || ""));
        trigger?.click();
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find((b) =>
          /flowchart/i.test(b.textContent || ""));
        option?.click();
      });
      return page
        .waitForSelector(".canvas-stage", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
    `,
  },
];

/** The eight Settings panes, appended to STOPS as one shape. Each is a
 * reading surface in the same shell, so they differ only in what they
 * contain — which is the point: the shell is shared, the content is not,
 * and it is the content that overflows. */
for (const [id, label] of [
  ["general", "General"],
  ["defaults", "Defaults"],
  ["providers", "Providers"],
  ["models", "Models"],
  ["storage", "Storage"],
  ["engine", "Engine"],
  ["workflows", "Workflows"],
  ["about", "About"],
]) {
  STOPS.push({
    id: `settings/${id}`,
    root: ".settings-layer",
    column: { selector: ".settings", max: 840 },
    zoom: id === "models",
    go: settingsPane(label),
  });
}

/* ---------- the assertion set ---------- */

/**
 * One measurement of whatever is on screen. Everything here is a question
 * about layout that holds on every screen; anything screen-specific is
 * declared in the stop and passed in.
 */
const probe = (stop) => `
  return page.evaluate((stop) => {
    const round = (n) => Math.round(n);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.opacity !== "0";
    };
    const name = (el) => {
      const said =
        el.getAttribute("aria-label") ||
        (el.textContent || "").trim().slice(0, 24) ||
        el.className;
      return el.tagName.toLowerCase() + (said ? \`:\${said}\` : "");
    };

    const root = document.querySelector(stop.root) || document.body;
    const CONTROLS =
      'button, a[href], input, select, textarea, [role="menuitem"], [role="option"], [role="tab"], [role="switch"]';
    const controls = [...root.querySelectorAll(CONTROLS)].filter(visible);

    /* Which ancestor decides whether this control can be reached. The first
       one that scrolls horizontally means yes — the content is off-screen
       but a scroll brings it back, which is a design, not a defect. The
       first one that CLIPS means the control is simply gone. */
    const gate = (el) => {
      for (let up = el.parentElement; up; up = up.parentElement) {
        const overflow = getComputedStyle(up).overflowX;
        if (overflow === "auto" || overflow === "scroll") return { scrolls: up };
        if (overflow === "hidden" || overflow === "clip") return { clips: up };
      }
      return {};
    };
    const clipped = controls
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const by = gate(el);
        if (by.scrolls) return false;
        if (by.clips) {
          const b = by.clips.getBoundingClientRect();
          return r.left < b.left - 1 || r.right > b.right + 1;
        }
        return r.left < -1 || r.right > window.innerWidth + 1;
      })
      .map(name);

    /* A control something else is drawn over — asked as the only question
       that matters about it: click this control where it is drawn, and do
       you hit it?

       Three attempts, and the shape of the three is why the comment is this
       long.

       Pairwise rectangle intersection was wrong twice over. Boxes overlap
       without ever painting on each other — a scene card in a scrolling
       panel keeps a rect that runs straight through the panel below, which
       clips it — so it reported dozens that were not real. And boxes
       overlap ON PURPOSE wherever a control has to sit on another: a canvas
       node is itself a button, ARIA makes a button's children
       presentational, so its ports and its delete control ship as siblings
       over its box, and a project tile does the same with its kebab. Each
       needed an allowlist entry, and each entry was a small lie — nothing
       is wrong with any of them, because the thing on top is the thing you
       meant to click.

       elementFromPoint answers the real question and needs no allowlist: it
       is the browser's own hit test, so clipping, stacking order, opacity
       and pointer-events are already in the answer. But asked at the box's
       GEOMETRIC centre it invented a new false positive — a card scrolled
       half out of its panel has its midpoint past the panel's edge, so the
       answer came back "dockview sash" for a card that was perfectly
       clickable on the half still showing.

       So: ask at the middle of what is VISIBLE. The rect intersected with
       everything that clips or scrolls and with the window — which is the
       first attempt's arithmetic, back for a smaller job. It no longer
       decides the answer; it only chooses where to ask the question. */
    const visibleBox = (el) => {
      const r = el.getBoundingClientRect();
      const box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let up = el.parentElement; up; up = up.parentElement) {
        const s = getComputedStyle(up);
        const b = up.getBoundingClientRect();
        if (s.overflowX !== "visible") {
          box.left = Math.max(box.left, b.left);
          box.right = Math.min(box.right, b.right);
        }
        if (s.overflowY !== "visible") {
          box.top = Math.max(box.top, b.top);
          box.bottom = Math.min(box.bottom, b.bottom);
        }
      }
      box.left = Math.max(box.left, 0);
      box.top = Math.max(box.top, 0);
      box.right = Math.min(box.right, window.innerWidth);
      box.bottom = Math.min(box.bottom, window.innerHeight);
      return box;
    };
    const hitTest = (el) => {
      const box = visibleBox(el);
      // A sliver is not a point that can be sampled. A canvas node scrolled
      // until 3px of it shows at a panel's edge has its visible middle
      // inside the 4px sash that draws the boundary — which is the sash
      // doing its job, not a control being covered, and the node is one
      // scroll away from being whole. Below this width the question
      // belongs to the clipping check above, which asks whether the
      // control can be reached at all.
      const SLIVER = 8;
      if (box.right - box.left < SLIVER || box.bottom - box.top < SLIVER) return null;
      const top = document.elementFromPoint(
        Math.round((box.left + box.right) / 2),
        Math.round((box.top + box.bottom) / 2),
      );
      if (!top) return null;
      return top === el || el.contains(top) || top.contains(el) ? null : top;
    };
    const covered = [];
    for (const el of controls) {
      const over = hitTest(el);
      if (over) covered.push(\`\${name(el)} is under \${name(over)}\`);
    }

    /* U0's second failure mode, stated as the rule it broke rather than as
       a pixel count: a container whose children were spaced by margins was
       quietly made a grid, and adjacent margins that used to collapse
       started adding instead. Nothing errors and the symptom is a few
       pixels — but the rule is mechanical, so ask it directly of every
       container on screen. (.home is a grid ON PURPOSE, which is why its
       stylesheet says every gap must be stated by one side only. This is
       that comment, enforced.) */
    const doubled = [];
    for (const box of root.querySelectorAll("*")) {
      const s = getComputedStyle(box);
      const stacks =
        s.display === "grid" ||
        s.display === "inline-grid" ||
        ((s.display === "flex" || s.display === "inline-flex") && s.flexDirection.startsWith("column"));
      if (!stacks) continue;
      if (parseFloat(s.rowGap) > 0) continue; // a gap is the spacing; margins are not
      const kids = [...box.children].filter(visible);
      for (let i = 0; i + 1 < kids.length; i += 1) {
        const below = parseFloat(getComputedStyle(kids[i]).marginBottom);
        const above = parseFloat(getComputedStyle(kids[i + 1]).marginTop);
        if (below > 0 && above > 0) {
          doubled.push(\`\${name(box)} > \${name(kids[i])} + \${name(kids[i + 1])}\`);
        }
      }
    }

    /* A reading surface is its column: capped where the window is wide,
       filling it where the window is narrow. Both halves matter — a column
       that stops filling is as wrong as one that stops capping. */
    let column = null;
    if (stop.column) {
      const el = document.querySelector(stop.column.selector);
      if (el) {
        const parent = el.parentElement;
        const ps = getComputedStyle(parent);
        const room =
          parent.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
        column = {
          width: round(el.getBoundingClientRect().width),
          want: round(Math.min(stop.column.max, room)),
        };
      }
    }

    /* A browsing shelf shows the column count its own width implies.
       Monotonicity alone would pass a grid frozen at one count, so derive
       the number rather than watch it.

       The stop's "track" is the size auto-fill actually counts with, which
       is not always the one the rule leads with: for minmax(200px, 1fr) the
       maximum is flexible and the repetition count comes from the 200, but
       for the board's minmax(200px, 240px) the maximum is definite and 240
       is what governs. Reading the 200 off both said the board had lost a
       column at every width it was measured at, and it had not. */
    const grids = (stop.grids || []).map((want) => {
      const el = document.querySelector(want.selector);
      if (!el) return { selector: want.selector, present: false };
      const s = getComputedStyle(el);
      const gap = parseFloat(s.columnGap) || 0;
      const width = el.getBoundingClientRect().width;
      return {
        selector: want.selector,
        present: true,
        cols: s.gridTemplateColumns.split(" ").filter(Boolean).length,
        implied: Math.max(1, Math.floor((width + gap) / (want.track + gap))),
        width: round(width),
      };
    });

    /* The workspace's sash floors. Below them the fixed chrome inside a
       panel — the composer's controls row, the timeline's transport —
       clips away instead of shrinking, so a short window must push the
       board rather than crush its neighbours. */
    let sashes = null;
    if (stop.sashes) {
      const groupOf = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const group = el.closest('[class*="groupview"], .dv-group, .groupview');
        return group ? round(group.getBoundingClientRect().height) : null;
      };
      sashes = {
        composer: groupOf(".workspace-composer, .composer, .tool-composer"),
        timeline: groupOf(".tl-scroll, .timeline-strip"),
      };
    }

    const shelf = (() => {
      if (!stop.shelfEdges) return null;
      const strip = document.querySelector(".recent");
      const col = document.querySelector(".prompt-box, .empty-state");
      if (!strip || !col) return null;
      const a = strip.getBoundingClientRect();
      const b = col.getBoundingClientRect();
      return { left: round(a.left) - round(b.left), right: round(a.right) - round(b.right) };
    })();

    return {
      inner: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      dpr: window.devicePixelRatio,
      controls: controls.length,
      clipped: clipped.slice(0, 6),
      clippedCount: clipped.length,
      covered: covered.slice(0, 6),
      coveredCount: covered.length,
      doubled: [...new Set(doubled)].slice(0, 6),
      doubledCount: doubled.length,
      column,
      grids,
      sashes,
      shelf,
      rail: {
        compact: !!document.querySelector(".rail.compact"),
        // The preference the viewport rule overrides, read from where the
        // rail itself stores it (App.tsx, RAIL_KEY). Without it the wide
        // half of the rule has nothing to assert against and the check
        // passes by construction.
        expandedPref: (() => {
          try {
            return localStorage.getItem("localcut.rail.expanded") === "1";
          } catch {
            return false;
          }
        })(),
        toggleDisabled: (() => {
          const nav = document.querySelector("nav.rail");
          const buttons = nav ? [...nav.querySelectorAll("button")] : [];
          return buttons.length ? buttons[buttons.length - 1].disabled : null;
        })(),
      },
    };
  }, ${JSON.stringify(stop)});
`;

/** The renderer speaks CSS pixels; on scaled Wayland Electron's bounds come
 * back in physical ones (walk.mjs carries the same note). Either relation
 * counts as agreement; a renderer holding a stale size matches neither. */
const boundsAgree = (inner, bounds, dpr) =>
  Math.abs(inner - bounds) <= 2 || Math.abs(inner * dpr - bounds) <= 2 + dpr;

/* ---------- the run ---------- */

const profile = mkdtempSync(path.join(tmpdir(), "localcut-sweep-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-sweep-engine-"));

const rig = await startRig({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7932",
  LOCALCUT_BACKEND: "mock",
  LOCALCUT_SEED_HOOK: "1",
  // Boot at interface zoom 1, so a window sized 1000x700 lays out at
  // 1000x700 CSS pixels — see setSize below for what this cost before.
  GSETTINGS_BACKEND: "memory",
  ...(ozone ? { RIG_OZONE: ozone } : {}),
});

let firstWorkspaceAt = Number.MAX_SAFE_INTEGER;
/** Sizes the display could not actually provide, and what came back. */
const unreached = new Map();
try {
  await evalInApp("await page.waitForSelector('.setup, .home', { timeout: 30000 }); return null;");

  // The wizard's fixture, before any of its steps are measured: an
  // installed slate, so walking to step 4 downloads nothing.
  const seeded = await evalInApp(`
    return page.evaluate((patch) => {
      if (!window.__localcutSeed) return false;
      window.__localcutSeed(patch);
      return true;
    }, ${JSON.stringify({ system: SYSTEM, models: MODELS, freeze: true })});
  `);
  check("the seed hook is installed and took the wizard's fixture", seeded === true);

  /**
   * Put the LAYOUT viewport at the requested size.
   *
   * Every rule in this file is written in CSS pixels — the rail compacts at
   * 1000, the reading column caps at 840, the window floor is 960x640 — and
   * a window's bounds need not be CSS pixels. On this dev box a 1000px
   * content bounds laid out at 769, so the stop labelled "just above the
   * 960 minimum" was measuring a viewport a fifth BELOW it and every size
   * in the matrix was really some other size.
   *
   * The cause was NOT the display: the monitor runs at scale 1. It was the
   * app scaling itself. GNOME's text-scaling-factor is 1.3 here and the
   * renderer folds it into its zoom baseline on purpose (lib/zoom.ts), so
   * the layout viewport is the window divided by 1.3 and no Chromium switch
   * touches it — `--force-device-scale-factor` was the wrong lever, and for
   * a while the conclusion drawn from its not working was that this box
   * could not be made true to scale at all. The rig boots with
   * `GSETTINGS_BACKEND=memory` above, so the app's own `gsettings` read
   * returns the schema default and the baseline is 1.
   *
   * The conversion stays anyway, and is the identity at zoom 1: ask for
   * size x dpr, measure what the renderer got, correct once. It is the
   * VERIFY half that earns its keep — a size that did not take comes back
   * unreached rather than silently short, and the run says so at the end,
   * whatever the reason the renderer had for refusing it. Both halves are
   * `rig.mjs::sizeWindowTo` now, since the pixel gates need them too; only
   * `maximize` is this sweep's own, because nothing else asks for one.
   */
  const setSize = async (size) => {
    if (size.maximize) {
      await evalInApp(`
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
        await page.waitForTimeout(900);
        return null;
      `);
      return { ok: true };
    }
    // Four passes and the verify are rig.mjs's now — the pixel gates need
    // the same conversion for the same reason, and two copies of it is two
    // places to fix the next time a window manager surprises one of them.
    return sizeWindowTo(size.width, size.height, { x: size.x, y: size.y });
  };

  /** Stamp the theme the way theme.ts does, and tell the app it moved.
   * Not a reload: a reload would send the run back to first-run state and
   * lose every project this sweep has made to have something to measure. */
  const setTheme = (theme) =>
    evalInApp(`
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        window.dispatchEvent(new Event("localcut-themechange"));
      }, ${JSON.stringify(theme)});
      await page.waitForTimeout(120);
      return null;
    `);

  /** The app's own interface zoom, driven the way a user drives it. Ctrl 0
   * resets first so each level is reached from a known step. */
  const setZoom = async (factor) => {
    await evalInApp(`
      await page.keyboard.down("Control");
      await page.keyboard.press("Digit0");
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      return null;
    `);
    if (factor === 1) return;
    const key = factor > 1 ? "Equal" : "Minus";
    // 0.9 is one step down; 1.25 is two up (1 -> 1.1 -> 1.25).
    const presses = factor === 1.25 ? 2 : 1;
    for (let at = 0; at < presses; at += 1) {
      await evalInApp(`
        await page.keyboard.down("Control");
        await page.keyboard.press(${JSON.stringify(key)});
        await page.keyboard.up("Control");
        await page.waitForTimeout(250);
        return null;
      `);
    }
  };

  const shoot = (name) =>
    evalInApp(
      `await page.screenshot({ path: ${JSON.stringify(path.join(dir, `${name}.png`))} }); return null;`,
    );

  /** Every question this sweep asks, asked once. */
  const assertAll = (where, stop, report, { bounds = null } = {}) => {
    if (bounds) {
      check(
        `${where}: renderer matches window bounds`,
        boundsAgree(report.inner.width, bounds.width, report.dpr) &&
          boundsAgree(report.inner.height, bounds.height, report.dpr),
        `inner ${report.inner.width}x${report.inner.height} vs bounds ${bounds.width}x${bounds.height} (dpr ${report.dpr})`,
      );
    }
    check(
      `${where}: no horizontal scroll`,
      report.scrollWidth <= report.inner.width + 1,
      `scrollWidth ${report.scrollWidth} > innerWidth ${report.inner.width}`,
    );
    check(
      `${where}: nothing is clipped out of reach`,
      report.clippedCount === 0,
      JSON.stringify(report.clipped),
    );
    check(
      `${where}: every control can be clicked where it is drawn`,
      report.coveredCount === 0,
      JSON.stringify(report.covered),
    );
    check(
      `${where}: no stacking container doubles its children's margins`,
      report.doubledCount === 0,
      JSON.stringify(report.doubled),
    );
    // A screen with no controls at all means the stop measured the wrong
    // element, and every check above it passed vacuously.
    check(`${where}: the screen has controls to measure`, report.controls > 0, `${report.controls}`);

    if (report.column) {
      check(
        `${where}: the reading column is ${report.column.want}px`,
        Math.abs(report.column.width - report.column.want) <= 1,
        `measured ${report.column.width}`,
      );
    }
    for (const grid of report.grids) {
      check(`${where}: ${grid.selector} is on screen`, grid.present, "not found");
      if (!grid.present) continue;
      check(
        `${where}: ${grid.selector} shows the ${grid.implied} columns ${grid.width}px fits`,
        grid.cols === grid.implied,
        `drew ${grid.cols}`,
      );
    }
    if (report.shelf) {
      check(
        `${where}: the Continue shelf shares both edges with the page column`,
        report.shelf.left === 0 && report.shelf.right === 0,
        `left ${report.shelf.left}px, right ${report.shelf.right}px`,
      );
    }
    if (report.sashes) {
      // The floors Workspace.tsx pins on the groups (COMPOSER_MIN_H,
      // TIMELINE_MIN_H). Mirrored here rather than imported: this file
      // cannot import TypeScript, and the drift is what the check is for.
      check(
        `${where}: the composer keeps its sash floor`,
        report.sashes.composer === null || report.sashes.composer >= 156,
        `composer group ${report.sashes.composer}px`,
      );
      check(
        `${where}: the timeline keeps its sash floor`,
        report.sashes.timeline === null || report.sashes.timeline >= 170,
        `timeline group ${report.sashes.timeline}px`,
      );
    }

    // The rail rule, and the control that writes the preference it
    // overrides. U0's first failure mode: a viewport rule that silently
    // discards a click is worse than one that says no.
    //
    // Asked of the CSS width rather than the window's, which is why the
    // zoomed pass runs it at all: at 1200px and 125% the window never moved
    // and the rule must still fire.
    const narrow = report.inner.width <= 1000;
    // Both halves say something. Narrow: the rule fires whatever the
    // preference is. Wide: the rule is GONE and the preference decides
    // again — which is the half that matters, because the bug U0 found was
    // a preference that never came back.
    check(
      `${where}: the rail is ${narrow ? "compact whatever the preference says" : "back on the preference"}`,
      narrow ? report.rail.compact : report.rail.compact === !report.rail.expandedPref,
      `compact=${report.rail.compact}, expanded preference=${report.rail.expandedPref}, ${report.inner.width}px`,
    );
    if (report.rail.toggleDisabled !== null) {
      check(
        `${where}: the rail toggle is ${narrow ? "disabled rather than dead" : "live"}`,
        report.rail.toggleDisabled === narrow,
        `disabled=${report.rail.toggleDisabled} at ${report.inner.width}px`,
      );
    }
  };

  // Asked of the display rather than assumed: the work area is what a snap
  // actually fills (it is the screen minus the shell's own bars), and it is
  // the only size in the matrix this machine gets a vote on.
  const workArea = await evalInApp(
    "return app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);",
  );
  const sizes = [...SIZES, ...snapSizes(workArea)];
  console.log(
    `work area ${workArea.width}x${workArea.height} at ${workArea.x},${workArea.y} - ` +
      `snapping to ${Math.floor(workArea.width / 2)}x${workArea.height}`,
  );

  for (const stop of STOPS) {
    // Marked BEFORE driving, not after: mounting the workspace is what
    // fires the peaks requests, so a count taken once `go` returns is
    // already past the errors it exists to excuse.
    if (stop.sashes && firstWorkspaceAt === Number.MAX_SAFE_INTEGER) {
      firstWorkspaceAt = (await health()).consoleErrors.length;
    }
    const reached = await evalInApp(stop.go);
    // Reachability IS the gate (plan U8 acceptance): a stop that cannot be
    // driven to is a failure, and every check it would have run is missing
    // rather than passed — so say how many.
    check(`${stop.id}: reached`, reached === true, "the sweep could not drive to this screen");
    if (reached !== true) continue;

    if (only && !stop.id.includes(only)) continue;

    for (const theme of THEMES) {
      await setTheme(theme);
      for (const size of sizes) {
        const sized = await setSize(size);
        if (!sized.ok) {
          // Measured at the wrong width, every assertion below would be
          // about a viewport nobody asked for — and a pass at 1477 read as
          // a pass at 1920 is exactly the skipped check that must not look
          // green. Recorded, skipped, and answered for at the end.
          // Keyed by size and STOP: the same label is asked for at every
          // stop, and "1200x800 came back 1500x1000" without one does not
          // say where to look.
          unreached.set(
            `${size.label} at ${stop.id}`,
            sized.inner ? sized.inner.join("x") : "unknown",
          );
          continue;
        }
        const where = `${stop.id} ${theme} ${size.label}`;
        const bounds = await evalInApp(`
          return app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return { ...w.getContentBounds(), maximized: w.isMaximized() };
          });
        `);
        if (size.maximize) {
          check(`${where}: the window reports maximized`, bounds.maximized === true);
        }
        const before = check.failures();
        assertAll(where, stop, await evalInApp(probe(stop)), { bounds });
        const name = `${stop.id.replace(/\//g, "-")}-${theme}-${size.label}`;
        if (check.failures() > before) {
          // A failing stop leaves the picture of itself. Every one of these
          // checks is about geometry, and a description of geometry is a
          // poor substitute for the frame it was measured in.
          await shoot(`${name}-FAILED`);
        } else if (theme === "dark" && SHOT_SIZES.has(size.label)) {
          await shoot(name);
        }
      }
    }
    await setTheme("dark");

    if (stop.id === "home") {
      // U0's first failure mode, run as the sequence that produced it
      // rather than as a property of one frame: SET the preference, cross
      // the boundary, come back, and see whether the preference did. Every
      // per-size check above reads the preference as it finds it, so none
      // of them can see a preference that was quietly discarded on the way
      // through — which is exactly what happened.
      await setSize({ label: "1440x900", width: 1440, height: 900 });
      const toggled = await evalInApp(`
        await page.evaluate(() => {
          const nav = document.querySelector("nav.rail");
          const buttons = nav ? [...nav.querySelectorAll("button")] : [];
          buttons[buttons.length - 1]?.click();
        });
        await page.waitForTimeout(250);
        return page.evaluate(() => ({
          compact: !!document.querySelector(".rail.compact"),
          pref: localStorage.getItem("localcut.rail.expanded"),
        }));
      `);
      check(
        "the rail toggle writes the preference it says it does",
        toggled.compact === (toggled.pref !== "1"),
        JSON.stringify(toggled),
      );
      await setSize({ label: "980x800", width: 980, height: 800 });
      const narrowed = await evalInApp(`
        return page.evaluate(() => ({
          compact: !!document.querySelector(".rail.compact"),
          pref: localStorage.getItem("localcut.rail.expanded"),
        }));
      `);
      check(
        "crossing the boundary compacts the rail without touching the preference",
        narrowed.compact === true && narrowed.pref === toggled.pref,
        JSON.stringify({ toggled, narrowed }),
      );
      await setSize({ label: "1440x900", width: 1440, height: 900 });
      const restored = await evalInApp(`
        return page.evaluate(() => ({
          compact: !!document.querySelector(".rail.compact"),
          pref: localStorage.getItem("localcut.rail.expanded"),
        }));
      `);
      check(
        "the preference takes effect again on the way back out",
        restored.compact === toggled.compact && restored.pref === toggled.pref,
        JSON.stringify({ toggled, restored }),
      );
      // Put it back, so every stop after this one measures the same rail.
      if (restored.pref === "1") {
        await evalInApp(`
          await page.evaluate(() => {
            const nav = document.querySelector("nav.rail");
            const buttons = nav ? [...nav.querySelectorAll("button")] : [];
            buttons[buttons.length - 1]?.click();
          });
          await page.waitForTimeout(250);
          return null;
        `);
      }
    }

    if (stop.zoom) {
      // Zoom crosses the same breakpoints a resize does, at a fixed window
      // size — so the rail rule is being asked about the CSS width, which
      // is the width the rule is actually written against.
      // Checked, not just called: this one shares a size LABEL with the
      // matrix, so a silent failure here surfaced at the end of the run as
      // "1200x800 was never measured" with nothing to say which of the
      // twenty places that ask for it had missed.
      const zoomSized = await setSize(ZOOM_SIZE);
      check(
        `${stop.id}: the window took the zoom stop's size`,
        zoomSized.ok,
        zoomSized.inner ? `came back ${zoomSized.inner.join("x")}` : "",
      );
      for (const factor of ZOOM_STEPS) {
        await setZoom(factor);
        const report = await evalInApp(probe(stop));
        assertAll(`${stop.id} zoom ${Math.round(factor * 100)}%`, stop, report);
      }
      await setZoom(1);
    }
  }

  // Said as a check rather than a note, because it is one: the matrix is
  // the claim this file makes, and a size the display refused is a hole in
  // it. On a 1:1 display there are none; on a fractionally scaled one the
  // widest CSS viewport is the screen divided by the scale, and 1920 CSS
  // pixels simply do not exist there.
  check(
    "every size in the matrix was actually measured",
    unreached.size === 0,
    [...unreached].map(([label, got]) => `${label} came back ${got}`).join("; "),
  );

  const report = await health();
  // The peaks route answers 422 for anything that is not decodable audio,
  // which is every narration and music file the MOCK backend writes: JSON
  // placeholders with a .wav name. The audio lanes ask for peaks on each
  // one the moment a timeline is on screen, degrade exactly as designed
  // (`useArtifactPeaks` returns null, the segment draws empty), and
  // Chromium logs the failed response anyway. Scoped to after the first
  // workspace mounted and to that one status — walk.mjs and the e2e filter
  // the same thing the same way, and every other status still fails here.
  const peaksNoise = /Failed to load resource[^|]*422 \(Unprocessable/;
  const consoleErrors = report.consoleErrors.filter(
    (line, at) => !(at >= firstWorkspaceAt && peaksNoise.test(line)),
  );
  check(
    "no console errors across the sweep",
    consoleErrors.length === 0 && report.pageErrors.length === 0,
    JSON.stringify([...consoleErrors, ...report.pageErrors].slice(0, 3)),
  );
} finally {
  await stopRig(rig);
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  rmSync(profile, scrub);
  rmSync(engineData, scrub);
}

console.log(`shots: ${dir}`);
if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("sweep: all checks passed");
