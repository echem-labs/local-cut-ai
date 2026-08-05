/**
 * Home + Library pixel-parity gate (plan doc 11, rule 3; phase U2).
 *
 * Same shape as parity-wiz.mjs, one frame bigger: these references are a
 * whole 1450px window — rail, titlebar and all — because U2's subject IS the
 * chrome. The store is seeded with the mock's own lists and frozen, the
 * window is sized to each reference, and what no truthful app state can
 * reproduce (thumbnails the mock fakes with photographs, relative times,
 * counts) is masked and checked by geometry instead.
 *
 * Usage: node parity-home.mjs --refs <dir>   (dir must hold *.png + masks.json)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  RETRYABLE_EXIT,
  evalInApp,
  layoutTrue,
  makeCheck,
  shotsDir,
  startRigTrueToScale,
  stopRig,
} from "./rig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const refsArg = process.argv.indexOf("--refs");
const refsDir = refsArg >= 0 ? path.resolve(process.argv[refsArg + 1]) : null;
if (!refsDir) {
  console.error("usage: node parity-home.mjs --refs <dir>");
  process.exit(2);
}

const dir = shotsDir("parity-home");
const check = makeCheck();

const GB = 2 ** 30;
const DAY = 86_400;
/** Stamps are relative to now so the tiles' "4d ago" is true rather than
 * posed — the metas are masked, but a truthful fixture keeps them readable
 * in the contact sheet. */
const now = Math.floor(Date.now() / 1000);

const project = (id, mode, title, days, extra = {}) => ({
  id,
  title,
  mode,
  created_at: now - days * DAY,
  updated_at: now - days * DAY,
  approvals: [],
  ...extra,
});

/** Four videos and five one-off outputs. Home's Continue shelf takes the
 * four most recent of the whole list, so no two stamps here may tie: a tie
 * would leave the shelf's order up to the sort's stability. */
const PROJECTS = [
  project("p-bee", "prompt", "How Honeybees Make Honey", 0, { duration_s: 57 }),
  project("p-cat", "prompt", "Why cats purr - a cozy explainer", 1, { duration_s: 46 }),
  project("p-cloud", "prompt", "Puff the Little Cloud - a kids poem", 2, { duration_s: 63 }),
  project("p-solar", "prompt", "A tour of the solar system", 14, { duration_s: 65 }),
  project("t-ocean", "tool:clip", "Ocean waves rolling onto a beach", 4, {
    duration_s: 5,
    tool_artifact_hash: "h1",
  }),
  project("t-uke", "tool:music", "Upbeat ukulele and glockenspiel", 4),
  project("t-thumb", "tool:thumbnail", "Shocked scientist, glowing honeycomb", 4, {
    tool_artifact_hash: "h2",
  }),
  project("t-script", "tool:script", "A 60s script on how Istanbul was captured", 0.5),
  project("t-voice", "tool:voiceover", "Calm narrator, 40 seconds", 13, {
    tool_artifact_hash: "h3",
  }),
];

/** The rail's Open group, as the mock draws it. */
const OPEN_TABS = ["p-bee", "p-cloud"];

/** Statuses the mock poses: one final, one generating, the rest drafts. */
const JOBS = [
  {
    id: "j-bee",
    project_id: "p-bee",
    status: "done",
    progress: 1,
    error: null,
    created_at: 1,
    started_at: 1,
    finished_at: 2,
    model: null,
    spec: { node_id: "export", kind: "export" },
  },
  {
    id: "j-cloud",
    project_id: "p-cloud",
    status: "rendering",
    progress: 0.4,
    error: null,
    created_at: 3,
    started_at: 3,
    finished_at: null,
    model: null,
    spec: { node_id: "clip", kind: "clip" },
  },
];

const gpu = {
  vendor: "NVIDIA",
  name: "NVIDIA GeForce RTX 3080 Laptop GPU",
  vram_gb: 8,
  backend: "cuda",
};
const license = { id: "apache-2.0", commercial: true, verdict: "commercial", notes: "" };
const model = (id, task, { external = false, family = "", version = "", size = GB, ...rest } = {}) => ({
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
  downloaded: false,
  downloading: false,
  progress: null,
  partial_bytes: 0,
  ...rest,
});

/** The mock's download strip: script external, keyframes installed, clips
 * at 51%, music queued — 2 of 4 ready, 6.9 of 18 GB. */
const MODELS = [
  model("qwen3-8b-q4", "text.llm", { external: true, family: "qwen 3", version: "· 8B" }),
  model("sdxl-base-1.0", "image.gen", { family: "sdxl", version: "1.0", size: 6.5 * GB, downloaded: true }),
  model("ltx-video-0.9-i2v", "video.i2v", {
    family: "ltx",
    version: "0.9",
    size: 11 * GB,
    downloading: true,
    progress: { done: 0.51 * 11 * GB, total: 11 * GB },
  }),
  model("ace-step-v1-3.5b", "music.gen", { family: "ACE-Step", version: "3.5B", size: 7.2 * GB }),
];
const SETTLED = MODELS.map((row) => ({ ...row, downloading: false, progress: null }));

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
  recommendations: MODELS.map((row) => ({ task: row.task, model: row, reason: "" })),
  backend_mode: "local",
};

const refSize = (name) => {
  const png = PNG.sync.read(readFileSync(path.join(refsDir, `${name}.png`)));
  return { width: png.width, height: png.height };
};

const masks = JSON.parse(readFileSync(path.join(refsDir, "masks.json"), "utf8"));
const MASK_PAD = 6;

/** The rail's icon column: six lucide glyphs the mock writes as unicode
 * characters. Not the open-project rows — those carry a status dot, which
 * the mock draws the same way the app does. */
const RAIL_ICONS = ".rail button:not(.rail-tab-close) > svg";

/** What each masked region of the reference is, in the app — a mask hides
 * pixels, never geometry (plan doc 11, U1's lesson). */
const MASKED_AS = {
  home: [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".quick-tools .tool-well",
    ".models-pop-wrap",
  ],
  "home-downloads": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    // Collapsed, the mock's one-line strip IS the whole card.
    ".dl-summary",
    ".quick-tools .tool-well",
    ".models-pop-wrap",
  ],
  "home-downloads-open": [
    ".rail-count",
    RAIL_ICONS,
    ".dl-summary-head",
    ".srow .st",
    ".srow .model",
    ".quick-tools .tool-well",
    ".models-pop-wrap",
  ],
  "home-empty": [".rail-count", RAIL_ICONS, ".quick-tools .tool-well", ".models-pop-wrap"],
  library: [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".library-bar .filter-tabs",
    ".chip-btn",
  ],
  "library-tools": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".library-bar .filter-tabs",
    ".chip-btn",
  ],
  "library-menu": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".library-bar .filter-tabs",
    ".chip-btn",
  ],
};
const RIGID = /thumb|filter-tabs/;
/** Content-sized boxes: matched on where they start, not how tall they are
 * (a tile's body is a title that may wrap and a status line). */
const LOOSE = /tile-body|rail-count/;
const TOL = 2;

const checkMaskGeometry = (name, boxes) => {
  // The reference masks as drawn - pad included. The pad IS the tolerance:
  // the property gated here is that every mask still sits over exactly the
  // control it was drawn for (and every such control is covered), not that
  // the mock's text engine and the app's round line boxes identically.
  // Anything that drifts beyond the pad leaks unmasked pixels, and the
  // pixel diff still owns that.
  const want = (masks[`${name}.png`] ?? []).map((mask) => ({ ...mask, taken: false }));
  const problems = [];
  if (process.env.RIG_DUMP_MASKS) {
    console.log(`--- ${name} app:`, JSON.stringify(boxes));
    console.log(`--- ${name} ref:`, JSON.stringify(want.map(({ taken, ...rest }) => rest)));
  }
  for (const box of boxes) {
    const hit = want.find(
      (ref) =>
        !ref.taken &&
        box.y >= ref.y - TOL &&
        // Content-sized boxes (a status row is a model name and a wall
        // time; a right-aligned cell grows leftward) are matched on
        // vertical position plus horizontal overlap; design-owned boxes
        // must sit wholly inside the mask that was drawn for them.
        box.x < ref.x + ref.width &&
        box.x + box.width > ref.x &&
        (LOOSE.test(box.sel) ||
          (box.y + box.height <= ref.y + ref.height + TOL &&
            // Inside the mask, or pinned to the edge the control is
            // anchored on (a right-aligned control grows leftward past
            // the box the mask was drawn around).
            (box.x >= ref.x - TOL ||
              Math.abs(box.x + box.width - (ref.x + ref.width - MASK_PAD)) <= TOL))),
    );
    if (!hit) {
      problems.push(`${box.sel} at ${box.x},${box.y} ${box.width}x${box.height} masks nothing`);
      continue;
    }
    hit.taken = true;
    const drawnWidth = hit.width - MASK_PAD * 2; // the control the mask was drawn around
    if (RIGID.test(box.sel) && Math.abs(drawnWidth - box.width) > TOL) {
      problems.push(`${box.sel} is ${box.width}px wide, reference ${drawnWidth}px`);
    }
  }
  const orphans = want.filter((ref) => !ref.taken);
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} masked region(s) with nothing under them: ${JSON.stringify(orphans.slice(0, 2))}`,
    );
  }
  check(
    `${name}: masked regions keep the reference geometry`,
    problems.length === 0,
    problems.slice(0, 4).join(" | "),
  );
};

const profile = mkdtempSync(path.join(tmpdir(), "localcut-parity-home-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-parity-home-engine-"));
const rig = await startRigTrueToScale({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7932",
  LOCALCUT_SEED_HOOK: "1",
});

let scaleHeld = true;
try {
  // Straight past first-run: this phase's subject is what comes after it.
  await evalInApp(`
    await page.waitForSelector('.setup, .home', { timeout: 30000 });
    await page.evaluate(() => {
      localStorage.setItem("localcut.firstRunDone", "1");
      localStorage.setItem("localcut.theme", "dark");
      localStorage.setItem("localcut.rail.expanded", "1");
      localStorage.setItem("localcut.openTabs", JSON.stringify(["p-bee", "p-cloud"]));
      // The mock's defaults: 16:9 at 60s, cinematic, auto.
      localStorage.setItem(
        "localcut.defaults.v1",
        JSON.stringify({ aspect: "16:9", duration: 60, style: "cinematic", mode: "prompt", voice: "", videoModel: null }),
      );
    });
    await page.reload();
    await page.waitForSelector('.home', { timeout: 30000 });
    return null;
  `);

  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
    });
    await page.waitForTimeout(300);
    return null;
  `);

  // Capture-only: the engine is irrelevant here (state is seeded and frozen)
  // and its port-bind flake would leak a red banner into the frame.
  await evalInApp(`
    await page.addStyleTag({ content: [
      "::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
      ".banner.error { display: none !important; }",
      // The tray is a live overlay the mock does not draw; a seeded
      // rendering job would otherwise park it in the corner of every frame.
      ".queue-tray { display: none !important; }",
    ].join("\\n") });
    return null;
  `);

  const seed = (patch) =>
    evalInApp(`
      return page.evaluate((patch) => {
        if (!window.__localcutSeed) return false;
        window.__localcutSeed(patch);
        return true;
      }, ${JSON.stringify(patch)});
    `);

  // Home focuses the prompt on first landing; the reference has no focus
  // ring, and a caret is not a design decision.
  await evalInApp(`
    await page.evaluate(() => (document.activeElement)?.blur());
    return null;
  `);

  const seeded = await seed({
    system: SYSTEM,
    models: SETTLED,
    projects: PROJECTS,
    allJobs: JOBS,
    // The restored tabs were pruned by the first (empty) engine answer.
    openProjects: OPEN_TABS,
    freeze: true,
  });
  check("seed hook is installed and accepted the fixture", seeded === true);

  const shoot = async (name) => {
    const { width, height } = refSize(name);
    await evalInApp(`
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        BrowserWindow.getAllWindows()[0].setContentBounds({ x: 0, y: 0, width: w, height: h });
      }, [${width}, ${height}]);
      // A click parks the pointer where it landed, and the tile it lands on
      // lifts 2px under :hover — a pose the mock does not draw, and one that
      // moved the geometry of a masked region. Park it on the title bar.
      await page.mouse.move(4, 4);
      await page.waitForTimeout(350);
      await page.screenshot({
        path: ${JSON.stringify(path.join(dir, `${name}.png`))},
        scale: "css",
        clip: { x: 0, y: 0, width: ${width}, height: ${height} },
      });
      return null;
    `);
    const boxes = await evalInApp(`
      return page.evaluate((selectors) =>
        selectors.flatMap((sel) =>
          [...document.querySelectorAll(sel)].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              sel,
              x: Math.round(r.left),
              y: Math.round(r.top),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          }),
        ),
      ${JSON.stringify(MASKED_AS[name] ?? [])});
    `);
    checkMaskGeometry(name, boxes);
    // Frame-level, not just run-level: the off-scale flip strikes on a
    // shrinking resize and every frame after it measures 1.25x wide.
    scaleHeld &&= await layoutTrue();
  };

  await shoot("home");

  await seed({ models: MODELS });
  await shoot("home-downloads");

  await evalInApp(`
    await page.click(".dl-summary-head");
    await page.waitForTimeout(250);
    return null;
  `);
  await shoot("home-downloads-open");

  await evalInApp(`
    await page.click(".dl-summary-head");
    await page.waitForTimeout(150);
    return null;
  `);
  // A machine that has made nothing has nothing open either.
  await seed({ models: SETTLED, projects: [], openProjects: [] });
  await shoot("home-empty");

  await seed({ projects: PROJECTS, openProjects: OPEN_TABS });
  await evalInApp(`
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".rail button")].find((button) =>
        button.textContent?.includes("Library"),
      );
      row?.click();
    });
    await page.waitForSelector(".library", { timeout: 5000 });
    await page.waitForTimeout(250);
    return null;
  `);
  await shoot("library");

  await evalInApp(`
    const buttons = await page.$$(".library-bar .filter-tabs button");
    await buttons[2].click();
    await page.waitForTimeout(250);
    return null;
  `);
  await shoot("library-tools");

  await evalInApp(`
    const buttons = await page.$$(".library-bar .filter-tabs button");
    await buttons[0].click();
    await page.waitForTimeout(200);
    const kebabs = await page.$$(".project-tile .tile-kebab");
    await kebabs[2].click();
    await page.waitForTimeout(250);
    return null;
  `);
  await shoot("library-menu");
  // The off-scale state can strike mid-run; a run it touched is
  // invalid, not red — the retry runner reruns it.
  scaleHeld = await layoutTrue();
} finally {
  await stopRig(rig);
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  rmSync(profile, scrub);
  rmSync(engineData, scrub);
}

if (!scaleHeld) {
  console.error("run went off-scale - invalid, not failed; rerunning");
  process.exit(RETRYABLE_EXIT);
}

if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed before comparing`);
}

const compare = spawnSync(
  process.execPath,
  [
    path.join(HERE, "compare.mjs"),
    "--refs",
    refsDir,
    "--shots",
    dir,
    "--masks",
    path.join(refsDir, "masks.json"),
  ],
  { stdio: "inherit" },
);
process.exit(check.failures() > 0 ? 1 : (compare.status ?? 1));
