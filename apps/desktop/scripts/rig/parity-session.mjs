/**
 * Quick-tool panel + session-page pixel-parity gate (plan doc 11, U3).
 *
 * Same shape as parity-home.mjs with one difference of substance: the five
 * sessions are REAL. Each is created through POST /tools against the rig's
 * own engine, so every recipe string, table row and title in the frames is
 * one the engine reproduced rather than a posed lookalike. What no truthful
 * run can hold still — a wall time, live peaks, native player chrome, a
 * mid-render percentage — is masked and geometry-checked, or seeded frozen
 * through the board patch the hook grew for exactly this.
 *
 * The audio frames need a real decodable artifact (the mock backend's
 * "audio" is a JSON placeholder): the fixture wav is uploaded through the
 * assets door — as PLAIN audio, no consent, which is the engine behavior
 * U3 introduced — and the board patch points the node at its hash.
 *
 * Usage: node parity-session.mjs --refs <dir>  (dir holds *.png + masks.json)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
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
import { writeProbe } from "./textprobe.cjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const refsArg = process.argv.indexOf("--refs");
const refsDir = refsArg >= 0 ? path.resolve(process.argv[refsArg + 1]) : null;
if (!refsDir) {
  console.error("usage: node parity-session.mjs --refs <dir>");
  process.exit(2);
}

/** The fixture media live beside the references, in the specs repo. */
const FIXTURE_WAV = path.join(refsDir, "..", "..", "tools", "session-fixture-voice.wav");
const FIXTURE_PNG = path.join(refsDir, "..", "..", "tools", "session-fixture-image.png");

const dir = shotsDir("parity-session");
const check = makeCheck();

const GB = 2 ** 30;
const DAY = 86_400;
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

/** The mock's Continue shelf — the same four videos the v5 home poses. */
const VIDEOS = [
  project("p-bee", "prompt", "How Honeybees Make Honey", 0, { duration_s: 57 }),
  project("p-cat", "prompt", "Why cats purr - a cozy explainer", 1, { duration_s: 46 }),
  project("p-cloud", "prompt", "Puff the Little Cloud - a kids poem", 2, { duration_s: 63 }),
  project("p-solar", "prompt", "A tour of the solar system", 14, { duration_s: 65 }),
];
const OPEN_TABS = ["p-bee", "p-cloud"];
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
const MODELS = [
  model("qwen3-8b-q4", "text.llm", { external: true, family: "qwen 3", version: "· 8B" }),
  model("sdxl-base-1.0", "image.gen", { family: "sdxl", version: "1.0", size: 6.5 * GB, downloaded: true }),
  model("ltx-video-0.9-i2v", "video.i2v", { family: "ltx", version: "0.9", size: 11 * GB }),
  model("ace-step-v1-3.5b", "music.gen", { family: "ACE-Step", version: "3.5B", size: 7.2 * GB }),
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
  recommendations: MODELS.map((row) => ({ task: row.task, model: row, reason: "" })),
  backend_mode: "local",
};

/** The five sessions, created for real. Prompts are the mock's strings. */
const HARBOR =
  "The harbor wakes before the city does. Nets come in silver, gulls argue over the first catch, " +
  "and the old lighthouse keeper writes the weather in a book nobody reads. " +
  "By noon the fog will lift, and the water will look like hammered tin.";
const TOOL_BODIES = {
  script: {
    tool: "script",
    prompt: "How Istanbul was captured - the fall of 1453",
    target_duration_s: 60,
    aspect: "16:9",
  },
  voiceover: { tool: "voiceover", text: HARBOR, voice: "deep" },
  music: {
    tool: "music",
    prompt: "Lo-fi beat, warm keys, gentle vinyl crackle",
    target_duration_s: 60,
  },
  image: {
    tool: "image",
    prompt: "Bioluminescent waves on a black-sand beach at night",
    aspect: "16:9",
  },
  clip: {
    tool: "clip",
    prompt: "A hummingbird hovering at a red flower, macro detail",
    motion: "smooth orbit around the subject",
    duration_s: 5,
    aspect: "16:9",
  },
};

/** Home drafts posed for the panel frames — written to localStorage, which
 * is how the draft actually persists, then read back by a reload. */
const DRAFTS = {
  "panel-script": {
    prompt: "",
    tool: "script",
    toolInput: "Why octopuses have three hearts",
    voice: "",
    motion: "",
    scriptModel: "",
    toolAspect: "16:9",
    toolDuration: 60,
    clipSeconds: 5,
  },
  "panel-voiceover": {
    prompt: "",
    tool: "voiceover",
    toolInput: "The harbor wakes before the city does.",
    voice: "deep",
    motion: "",
    scriptModel: "",
    toolAspect: "16:9",
    toolDuration: 60,
    clipSeconds: 5,
  },
  "panel-clip": {
    prompt: "",
    tool: "clip",
    toolInput: "A hummingbird hovering at a red flower, macro detail",
    voice: "",
    motion: "smooth orbit around the subject",
    scriptModel: "",
    toolAspect: "16:9",
    toolDuration: 60,
    clipSeconds: 5,
  },
};

const refSize = (name) => {
  const png = PNG.sync.read(readFileSync(path.join(refsDir, `${name}.png`)));
  return { width: png.width, height: png.height };
};

const masks = JSON.parse(readFileSync(path.join(refsDir, "masks.json"), "utf8"));
const MASK_PAD = 6;

const RAIL_ICONS = ".rail button:not(.rail-tab-close):not(.menu-pop button) > svg";

/** What each masked region of the reference is, in the app — a mask hides
 * pixels, never geometry (U1's lesson, now doctrine). */
const MASKED_AS = {
  "panel-script": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".quick-tools .tool-well",
    ".models-pop-wrap",
    ".tool-head > svg",
    ".tool-head .icon-btn",
  ],
  "panel-voiceover": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".quick-tools .tool-well",
    ".models-pop-wrap",
    ".tool-head > svg",
    ".tool-head .icon-btn",
    ".voice-swatch .swatch-play",
  ],
  "panel-clip": [
    ".project-tile .tile-thumb",
    ".project-tile .tile-body",
    ".rail-count",
    RAIL_ICONS,
    ".quick-tools .tool-well",
    ".models-pop-wrap",
    ".tool-head > svg",
    ".tool-head .icon-btn",
    ".tool-panel .row .btn-ghost",
  ],
  "session-script": [".rail-count", RAIL_ICONS, ".tool-status", ".tool-composer .models-pop-wrap"],
  "session-voiceover": [
    ".rail-count",
    RAIL_ICONS,
    ".tool-status",
    ".wave-plot",
    ".wave-toggle",
    ".wave-time",
    ".tool-actions .btn-ghost",
    ".clone-panel .consent input",
    ".tool-composer .models-pop-wrap",
  ],
  "session-music": [
    ".rail-count",
    RAIL_ICONS,
    ".tool-status",
    ".wave-plot",
    ".wave-toggle",
    ".wave-time",
    ".tool-actions .btn-ghost",
    ".tool-composer .models-pop-wrap",
  ],
  "session-image": [
    ".rail-count",
    RAIL_ICONS,
    ".tool-status",
    ".tool-preview",
    ".tool-actions .btn-ghost",
    ".tool-composer .models-pop-wrap",
  ],
  "session-clip-rendering": [".rail-count", RAIL_ICONS, ".tool-status"],
};
/** Design-owned sizes: matched rigidly. */
const RIGID = /thumb|wave-plot|tool-preview|swatch-play|wave-toggle/;
/** Content-sized boxes: matched on where they start HORIZONTALLY, not on
 * how wide they are (a status row's width is a model name and a wall time;
 * a time readout and the composer's model line are whatever their text
 * measures). Loose is a statement about x only - the vertical band binds
 * every box, loose or not, because without it a box could claim a mask
 * several rows above it. */
const LOOSE = /tile-body|rail-count|tool-status|audio|btn-ghost|consent|icon-btn|wave-plot|wave-time|models-pop|swatch-play/;
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
        // Content-sized boxes (a status row is a model name and a wall
        // time; a right-aligned cell grows leftward) are matched on
        // vertical position plus horizontal overlap; design-owned boxes
        // must sit wholly inside the mask that was drawn for them. The
        // vertical band binds both: "loose" is a statement about x, and
        // left unbounded below it lets a box claim a mask far above it.
        box.y >= ref.y - TOL &&
        box.y + box.height <= ref.y + ref.height + TOL &&
        box.x < ref.x + ref.width &&
        box.x + box.width > ref.x &&
        (LOOSE.test(box.sel) ||
          // Inside the mask, or pinned to the edge the control is
          // anchored on (a right-aligned control grows leftward past
          // the box the mask was drawn around).
          box.x >= ref.x - TOL ||
          Math.abs(box.x + box.width - (ref.x + ref.width - MASK_PAD)) <= TOL),
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

const profile = mkdtempSync(path.join(tmpdir(), "localcut-parity-session-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-parity-session-engine-"));

// The peaks route needs a real decoder. The engine resolves the managed
// <data_dir>/bin/ffmpeg first, so plant the developer's managed copy into
// the rig's temp data dir; without one the waveform frames have no bars
// and fail their geometry check rather than passing empty.
const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const managed = path.join(homedir(), ".localcut", "bin", exe);
let scaleHeld = true;
try {
  mkdirSync(path.join(engineData, "bin"), { recursive: true });
  copyFileSync(managed, path.join(engineData, "bin", exe));
} catch {
  console.error(`no managed ffmpeg at ${managed} — the waveform frames will fail`);
}

const rig = await startRigTrueToScale({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7934",
  LOCALCUT_SEED_HOOK: "1",
});

try {
  await evalInApp(`
    await page.waitForSelector('.setup, .home', { timeout: 30000 });
    await page.evaluate(() => {
      localStorage.setItem("localcut.firstRunDone", "1");
      localStorage.setItem("localcut.theme", "dark");
      localStorage.setItem("localcut.rail.expanded", "1");
      localStorage.setItem("localcut.openTabs", JSON.stringify([]));
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

  /** Capture-only styles, re-applied after every reload. The notice bar is
   * hidden with the tray: a mock script is shorter than any target, so the
   * shortfall notice is live data the mock deliberately does not pose. */
  const CAPTURE_CSS = `
    await page.addStyleTag({ content: [
      "::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
      ".banner.error { display: none !important; }",
      ".queue-tray { display: none !important; }",
      ".notice-bar { display: none !important; }",
    ].join("\\n") });
    return null;
  `;
  await evalInApp(CAPTURE_CSS);

  const seed = (patch) =>
    evalInApp(`
      return page.evaluate((patch) => {
        if (!window.__localcutSeed) return false;
        window.__localcutSeed(patch);
        return true;
      }, ${JSON.stringify(patch)});
    `);

  /** Talk to the rig's engine from the page (the renderer already holds the
   * url + token; the rig script itself has neither). */
  const engineFetch = (script) =>
    evalInApp(`
      return page.evaluate(async () => {
        const { connection: conn } = await window.localcut.getEngineConnection();
        const call = async (method, route, body, raw) => {
          const response = await fetch(conn.url + route, {
            method,
            headers: {
              Authorization: "Bearer " + conn.token,
              // Explicit either way: fetch's default text/plain makes
              // FastAPI refuse a perfectly good JSON body with a 422.
              "Content-Type": raw ? "application/octet-stream" : "application/json",
            },
            body: raw ? raw : body ? JSON.stringify(body) : undefined,
          });
          if (!response.ok) throw new Error(route + " -> " + response.status);
          return response.json();
        };
        ${script}
      });
    `);

  // 0. The engine boots well after Home paints; nothing below can start
  // until its API answers.
  const engineUp = await evalInApp(`
    return page.evaluate(async () => {
      for (let attempt = 0; attempt < 240; attempt++) {
        try {
          const { connection: conn } = await window.localcut.getEngineConnection();
          if (conn?.url) {
            const response = await fetch(conn.url + "/health");
            if (response.ok) return true;
          }
        } catch {
          /* not yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    });
  `);
  check("the rig's engine answers /health", engineUp === true);

  // 1. Create the five sessions for real and wait for every node to settle.
  const created = await engineFetch(`
    const bodies = ${JSON.stringify(TOOL_BODIES)};
    const ids = {};
    for (const [kind, body] of Object.entries(bodies)) {
      const project = await call("POST", "/tools", body);
      ids[kind] = project.id;
    }
    for (const [kind, id] of Object.entries(ids)) {
      for (let attempt = 0; attempt < 120; attempt++) {
        const { board } = await call("GET", "/projects/" + id);
        const nodes = Object.values(board.aux);
        if (nodes.length && nodes.every((node) => node.artifact_hash || node.error)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return ids;
  `);
  check("five real sessions created", Object.keys(created).length === 5, JSON.stringify(created));

  // 2. Plant the decodable fixtures: plain audio (no consent — U3's engine
  // change is exactly what makes this possible) and the slate image.
  const wav64 = readFileSync(FIXTURE_WAV).toString("base64");
  const png64 = readFileSync(FIXTURE_PNG).toString("base64");
  const fixtures = await engineFetch(`
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const wav = await call(
      "POST",
      "/projects/${created.voiceover}/assets?filename=session-fixture-voice.wav",
      null,
      bytes("${wav64}"),
    );
    const wavMusic = await call(
      "POST",
      "/projects/${created.music}/assets?filename=session-fixture-voice.wav",
      null,
      bytes("${wav64}"),
    );
    const slate = await call(
      "POST",
      "/projects/${created.image}/assets?filename=session-fixture-image.png",
      null,
      bytes("${png64}"),
    );
    return { voice: wav.hash, music: wavMusic.hash, image: slate.hash };
  `);
  check(
    "fixture media entered through the assets door",
    Boolean(fixtures.voice && fixtures.music && fixtures.image),
    JSON.stringify(fixtures),
  );

  /** Everything the Library counts: the four posed videos + the five real
   * sessions — the rail's 9. */
  const realProjects = await engineFetch(`return call("GET", "/projects");`);
  const sessionProjects = realProjects.filter((entry) =>
    Object.values(created).includes(entry.id),
  );
  const ALL = [...VIDEOS, ...sessionProjects];

  // ---- frame driving ------------------------------------------------------
  // Frames are shot on the MAIN window with exactly the U2 gate's pattern
  // (parity-home.mjs): resize via setContentBounds, park the pointer,
  // plain page.screenshot, geometry read after — the one recipe verified
  // to hold this box's display stack steady. Every alternative tried here
  // (offscreen twins, device emulation, capturePage, zoom compensation)
  // eventually met a state where the layout viewport decoupled from the
  // window; the U2 pattern demonstrably does not.
  const shoot = async (name) => {
    const { width, height } = refSize(name);
    await evalInApp(`
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        BrowserWindow.getAllWindows()[0].setContentBounds({ x: 0, y: 0, width: w, height: h });
      }, [${width}, ${height}]);
      await page.mouse.move(4, 4);
      await page.waitForTimeout(350);
      // ...and then until the layout stops moving. The resize above
      // re-flows the whole page, so a fixed wait after it is the same
      // gamble the panel-expand step used to take - and it is the one that
      // actually decides the picture, since every settle done BEFORE the
      // resize is re-laid-out by it. home-downloads-open shot its quick
      // tools 84px high about one run in four this way.
      //
      // Never throws: a frame that will not settle is a frame worth
      // diffing anyway, and compare.mjs reports it with a number.
      await page
        .waitForFunction(
          () => {
            const now = document.documentElement.scrollHeight;
            const settled = window.__rigHeight === now;
            window.__rigHeight = now;
            return settled;
          },
          null,
          { timeout: 4000, polling: 120 },
        )
        .catch(() => {});
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
    // Convergence only: the frame's own text, measured the same way the
    // reference measured its own, so `converge.mjs` can say which element
    // moved rather than how many pixels did.
    await writeProbe(dir, name, evalInApp);
    // Frame-level, not just run-level: the off-scale flip strikes on a
    // shrinking resize and every frame after it measures 1.25x wide.
    scaleHeld &&= await layoutTrue();
  };

  // 3. Panel frames: pose the draft, reload so the store reads it, freeze
  // the fixture in, blur the autofocused textarea (the mock draws the
  // resting panel; a caret is not a design decision).
  for (const name of ["panel-script", "panel-voiceover", "panel-clip"]) {
    await evalInApp(`
      await page.evaluate((draft) => {
        localStorage.setItem("localcut.home.draft", JSON.stringify(draft));
        localStorage.setItem("localcut.openTabs", JSON.stringify(${JSON.stringify(OPEN_TABS)}));
      }, ${JSON.stringify(DRAFTS[name])});
      await page.reload();
      await page.waitForSelector(".tool-panel", { timeout: 30000 });
      return null;
    `);
    await evalInApp(CAPTURE_CSS);
    // Freeze first and let the boot's in-flight refreshes land — their
    // writes would otherwise replace the pose with the engine's truth.
    await seed({ freeze: true });
    await evalInApp("await page.waitForTimeout(800); return null;");
    const seeded = await seed({
      system: SYSTEM,
      models: MODELS,
      projects: ALL,
      allJobs: JOBS,
      openProjects: OPEN_TABS,
      freeze: true,
    });
    check(`${name}: seed accepted`, seeded === true);
    await evalInApp(`
      await page.evaluate(() => document.activeElement?.blur());
      return null;
    `);
    await shoot(name);
    await seed({ freeze: false });
  }

  // 4. Session frames: open each session through the rail's Open row — the
  // real openProject path — then freeze the board into the posed state.
  const board = (id) =>
    engineFetch(`return (await call("GET", "/projects/" + ${JSON.stringify(id)})).board;`);

  const EMPTY_POSE = {
    prompt: "",
    tool: null,
    toolInput: "",
    voice: "",
    motion: "",
    scriptModel: "",
    toolAspect: "16:9",
    toolDuration: 60,
    clipSeconds: 5,
  };

  const openSessionFrame = async (name, id, boardPatch, prepare) => {
    await evalInApp(`
      await page.evaluate((draft) => {
        localStorage.setItem("localcut.home.draft", JSON.stringify(draft));
        localStorage.setItem("localcut.openTabs", JSON.stringify([]));
      }, ${JSON.stringify(EMPTY_POSE)});
      await page.reload();
      await page.waitForSelector(".home", { timeout: 30000 });
      return null;
    `);
    await evalInApp(CAPTURE_CSS);
    await seed({ projects: ALL, openProjects: [id], freeze: false });
    await evalInApp(`
      await page.evaluate(() => {
        document.querySelector(".rail-tab button")?.click();
      });
      await page.waitForSelector(".tool-shell", { timeout: 15000 });
      return null;
    `);
    // Same in-flight discipline as the panels: freeze, settle, pose.
    await seed({ freeze: true });
    await evalInApp("await page.waitForTimeout(800); return null;");
    if (boardPatch) {
      check(`${name}: board posed`, await seed({ board: boardPatch, freeze: true }));
    }
    await seed({ projects: ALL, openProjects: [id], freeze: true });
    if (prepare) await prepare();
    await shoot(name);
    await seed({ freeze: false });
  };

  const waitFor = (selector) =>
    evalInApp(`
      return page
        .waitForSelector(${JSON.stringify(selector)}, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    `);

  // script — everything real; freeze only steadies the frame.
  await openSessionFrame("session-script", created.script, null, async () => {
    check("session-script: table rendered", await waitFor(".script-table"));
  });

  // voiceover — point the node at the real wav, open the clone panel.
  const voBoard = await board(created.voiceover);
  voBoard.aux.voiceover = {
    ...voBoard.aux.voiceover,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: fixtures.voice,
  };
  await openSessionFrame("session-voiceover", created.voiceover, voBoard, async () => {
    check("session-voiceover: waveform drawn", await waitFor(".wave-plot"));
    await evalInApp(`
      await page.evaluate(() => {
        [...document.querySelectorAll(".tool-actions button")]
          .find((button) => button.textContent.includes("Clone a voice"))
          ?.click();
      });
      return null;
    `);
    check("session-voiceover: clone panel open", await waitFor(".clone-panel"));
  });

  // music — same wav, plus the loop-seam action in shot.
  const musicBoard = await board(created.music);
  musicBoard.aux.music = {
    ...musicBoard.aux.music,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: fixtures.music,
  };
  await openSessionFrame("session-music", created.music, musicBoard, async () => {
    check("session-music: waveform drawn", await waitFor(".wave-plot"));
  });

  // image — the slate as the artifact, takes recorded, seed visible.
  const imageBoard = await board(created.image);
  imageBoard.aux.image = {
    ...imageBoard.aux.image,
    status: "draft",
    progress: 1,
    error: null,
    artifact_hash: fixtures.image,
    seed: 4242,
    takes: [
      { output_hash: "t-41", seed: 41, model: null, at: now - DAY, available: true, current: false },
      { output_hash: fixtures.image, seed: 4242, model: null, at: null, available: true, current: true },
    ],
  };
  await openSessionFrame("session-image", created.image, imageBoard, async () => {
    check("session-image: takes strip present", await waitFor(".takes-strip"));
  });

  // clip — the frame bytes never hold still for: rendering at 42%.
  const clipBoard = await board(created.clip);
  clipBoard.aux.keyframe = {
    ...clipBoard.aux.keyframe,
    status: "final",
    progress: 1,
    error: null,
  };
  clipBoard.aux.clip = {
    ...clipBoard.aux.clip,
    status: "rendering",
    progress: 0.42,
    error: null,
    artifact_hash: null,
  };
  await openSessionFrame("session-clip-rendering", created.clip, clipBoard);
  // The off-scale state can strike mid-run; a run it touched is
  // invalid, not red — the retry runner reruns it.
  scaleHeld = await layoutTrue();
} finally {
  await stopRig(rig);
  // Tolerated, not fatal: a handle that outlives the process by a beat must
  // not replace the run's real failure with an EPERM about a temp dir.
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  try {
    rmSync(profile, scrub);
    rmSync(engineData, scrub);
  } catch (error) {
    console.error(`temp scrub left residue: ${error.message}`);
  }
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
