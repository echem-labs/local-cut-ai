/**
 * Inspector failure-card pixel-parity gate (plan doc 11, U5).
 *
 * The frame is the workspace's INSPECTOR panel at a fixed 1440x900 window,
 * with a clip whose render ran out of memory selected. Same reasoning as the
 * flowchart gate before it: a panel is one group of the workspace and takes
 * a fraction of it, so a panel sized to order would want a window several
 * times the display. Fixing the window makes the frame reproducible and the
 * mock is drawn to whatever size that produces.
 *
 * Everything in the frame is POSED (scripts/rig/u5-pose.mjs), and it has to
 * be. `nodeFailures` exists only on the websocket — the scheduler computes
 * `suggestions` at publish time and persists nothing — so the only way to
 * reach this card by driving the app would be to exhaust a real GPU on
 * demand. The model rows are posed for the same reason: which model the
 * "Use X" chip names is a function of what is installed, and a reference
 * frame must not depend on this machine's library.
 *
 * Usage: node parity-inspector.mjs --refs <dir>  (dir holds inspector-failure.png + masks.json)
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
import { POSE_FAILURE, POSE_JOBS, POSE_MODELS, POSE_NODE, poseBoard } from "./u5-pose.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const refsArg = process.argv.indexOf("--refs");
const refsDir = refsArg >= 0 ? path.resolve(process.argv[refsArg + 1]) : null;
if (!refsDir) {
  console.error("usage: node parity-inspector.mjs --refs <dir>");
  process.exit(2);
}

const FRAME_NAME = "inspector-failure.png";
const dir = shotsDir("parity-inspector");
const check = makeCheck();
const masks = JSON.parse(readFileSync(path.join(refsDir, "masks.json"), "utf8"));
const MASK_PAD = 6;

const reference = PNG.sync.read(readFileSync(path.join(refsDir, FRAME_NAME)));
const FRAME = { width: reference.width, height: reference.height };

/** What each masked region is, in the app. The card is almost entirely
 * unmasked on purpose — its layout IS the thing being gated — so this is
 * only what the two renderers draw differently: the warning mark and the
 * status ring are lucide/SVG here and unicode in the mock. */
const MASKED_AS = [".failure-head svg"];

const profile = mkdtempSync(path.join(tmpdir(), "localcut-parity-inspector-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-parity-inspector-engine-"));
let scaleHeld = true;

const rig = await startRigTrueToScale({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7936",
  // The app spawns its engine with `local,mock`, so on a machine running
  // Ollama this gate reaches a REAL model - and if that model is not the
  // one installed, generation fails, the project never gets what this gate
  // poses on top of, and the failure reads as a layout defect. The gate is
  // about pixels; pinning the chain gets it the same content everywhere.
  // (sweep.mjs learned this first; its header carries the same note.)
  LOCALCUT_BACKEND: "mock",
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
    });
    await page.reload();
    await page.waitForSelector('.home', { timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
    });
    return null;
  `);

  await evalInApp(`
    await page.addStyleTag({ content: [
      "::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
      // The WRAPPER, not just the banner inside it. content-banners
      // collapses through :empty, and an element hidden with display
      // none is still a child - so hiding only the banner left the
      // wrapper laid out, and its 24px bottom margin pushed every frame
      // down by that much. Which reads as "the app has drifted from the
      // mock", in every frame at once, and is what it did.
      ".content-banners { display: none !important; }",
      ".queue-tray { display: none !important; }",
      ".notice-bar { display: none !important; }",
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

  const engineFetch = (script) =>
    evalInApp(`
      return page.evaluate(async () => {
        const { connection: conn } = await window.localcut.getEngineConnection();
        const call = async (method, route, body) => {
          const response = await fetch(conn.url + route, {
            method,
            headers: {
              Authorization: "Bearer " + conn.token,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          if (!response.ok) throw new Error(route + " -> " + response.status);
          return response.json();
        };
        ${script}
      });
    `);

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

  // A real project supplies the workspace chrome the panel is measured
  // inside; everything the frame is ABOUT is posed over it a moment later.
  const project = await engineFetch(`
    return call("POST", "/projects", { title: "Failure reference", prompt: "a reference failure" });
  `);
  check("a project to open the inspector in", Boolean(project?.id), JSON.stringify(project));

  await evalInApp(`
    await page.evaluate((id) => window.__localcutSeed({ openProjects: [id] }), ${JSON.stringify(project.id)});
    await page.evaluate(() => document.querySelector(".rail-tab button")?.click());
    await page.waitForSelector(".dockview-theme-localcut", { timeout: 30000 });
    return null;
  `);

  // The window is fixed BEFORE the pose so the panel the mock was drawn to
  // is the panel that gets photographed.
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(1440, 900);
    });
    await page.waitForTimeout(400);
    return null;
  `);
  const windowSize = await evalInApp(`
    return page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  `);
  check(
    "the window is the size the reference was drawn at",
    windowSize.w === 1440,
    JSON.stringify(windowSize),
  );

  // Freeze FIRST, then let anything already in flight land, then pose.
  //
  // `refreshBoard` reads the freeze flag when it starts, so a refresh that
  // began before the flag was set still writes its result — and it writes
  // `jobs`, which is where `modelThatFailed` reads the model the chip is
  // named after. Seeding both in one call raced that write: the same pose
  // produced "Use ltx-video-2b" on one run and "Use wan-2.2-i2v-a14b" on the
  // next, which is a reference frame that disagrees with itself.
  await seed({ freeze: true });
  await evalInApp(`await page.waitForTimeout(600); return null;`);
  const posed = await seed({
    board: poseBoard(),
    jobs: POSE_JOBS,
    models: POSE_MODELS,
    nodeFailures: POSE_FAILURE,
    selectedNode: POSE_NODE,
  });
  check("board, jobs, models and the failure are posed", posed === true);

  await evalInApp(`
    await page.waitForSelector(".failure-card", { timeout: 20000 });
    return null;
  `);

  // The chips are the reason this frame exists: three of them, one carrying
  // a model id, in a panel narrower than the page. Their count and their
  // enabled/disabled split are what a mock cannot claim for itself.
  const chips = await evalInApp(`
    return page.evaluate(() => {
      const card = document.querySelector(".failure-card");
      const buttons = [...card.querySelectorAll(".chip-row .chip")];
      return {
        count: buttons.length,
        labels: buttons.map((b) => (b.textContent || "").trim()),
        disabled: buttons.filter((b) => b.disabled).length,
        rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      };
    });
  `);
  check(
    "all three suggestions render, and the one this machine can serve names its model",
    chips.count === 3 && chips.labels.some((label) => label.includes("ltx-video-2b")),
    JSON.stringify(chips),
  );
  check(
    "no suggestion is disabled in the posed state",
    chips.disabled === 0,
    JSON.stringify(chips),
  );

  // Logged, not asserted: when the pixel diff fails, the first thing worth
  // knowing is WHICH row moved, and reading that off a contact sheet is
  // guesswork. These are the three boxes the mock has to reproduce.
  // Every read below asks whether the card is still there rather than
  // assuming it. It is not paranoia: the posed failure lives on the
  // websocket, the rig's own engine renders an `s1.clip` of its own, and
  // that job's `job.done` used to delete the pose mid-gate — reported as a
  // `getBoundingClientRect` of null, a node stack trace in place of a
  // verdict. The store bails on the freeze now; this is what makes the next
  // way it can vanish readable instead of cryptic.
  const gone = "the failure card left the page mid-gate";
  const rows = await evalInApp(`
    return page.evaluate(() => {
      const root = document.querySelector(".failure-card");
      if (!root) return null;
      const card = root.getBoundingClientRect();
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top - card.top),
          height: Math.round(r.height),
          font: getComputedStyle(el).fontSize,
        };
      };
      return {
        head: box(".failure-head"),
        why: box(".failure-why"),
        chips: box(".failure-card .chip-row"),
      };
    });
  `);
  check("the card is still on screen to be measured", rows !== null, gone);
  console.log(`  ROWS ${JSON.stringify(rows)}`);

  // The card lives at the BOTTOM of a scrolling inspector, well past the
  // panel's fold, so the frame is the card itself rather than the panel
  // around it — the panel's own chrome is U3-era and already gated by
  // reference/v6. Scrolled into view first: an element clipped to its
  // off-screen box photographs whatever happens to be at those coordinates.
  const panel = await evalInApp(`
    await page.evaluate(() => {
      document.querySelector(".failure-card")?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const root = document.querySelector(".failure-card");
      if (!root) return null;
      const card = root.getBoundingClientRect();
      const inspector = document.querySelector(".inspector").getBoundingClientRect();
      return {
        x: Math.round(card.left),
        y: Math.round(card.top),
        width: Math.round(card.width),
        height: Math.round(card.height),
        insidePanel: card.left >= inspector.left - 1 && card.right <= inspector.right + 1,
      };
    });
  `);
  check(
    "the card is the reference's size",
    panel !== null &&
      Math.abs(panel.width - FRAME.width) <= 1 &&
      Math.abs(panel.height - FRAME.height) <= 1,
    panel === null
      ? gone
      : `card ${panel.width}x${panel.height}, reference ${FRAME.width}x${FRAME.height}`,
  );
  // Nothing below this can run without a box to clip to, and every later
  // check would fail for the same one reason. Stop with the verdict already
  // reached rather than adding noise to it.
  if (panel === null) process.exit(1);
  // What a card-sized frame cannot see for itself. This is the property the
  // panel-sized alternative would have been gating, kept as geometry —
  // where it is a sharper check than a pixel diff anyway.
  check("the card stays inside the inspector panel", panel.insidePanel === true, JSON.stringify(panel));

  scaleHeld = await layoutTrue();
  if (!scaleHeld) throw new Error("the renderer lost true scale — retry");

  const shot = path.join(dir, FRAME_NAME);
  await evalInApp(`
    await page.screenshot({
      path: ${JSON.stringify(shot)},
      scale: "css",
      clip: ${JSON.stringify({ x: panel.x, y: panel.y, width: FRAME.width, height: FRAME.height })},
    });
    return null;
  `);

  // Mask geometry: every drawn box still sits over the control it was drawn
  // for, and every control is covered. A mask is a promise that only the
  // DATA differs there (plan doc 11, U1).
  const boxes = await evalInApp(`
    return page.evaluate((selectors) => {
      const root = document.querySelector(".failure-card");
      if (!root) return null;
      const panel = root.getBoundingClientRect();
      return selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            selector,
            x: Math.round(r.left - panel.left),
            y: Math.round(r.top - panel.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }),
      );
    }, ${JSON.stringify(MASKED_AS)});
  `);
  check("the card survived to have its masks measured", boxes !== null, gone);
  const inFrame = (boxes ?? []).filter(
    (box) =>
      box.x + box.width > 0 &&
      box.y + box.height > 0 &&
      box.x < FRAME.width &&
      box.y < FRAME.height,
  );
  const drawn = masks[FRAME_NAME] ?? [];
  const covered = inFrame.filter((box) =>
    drawn.some(
      (mask) =>
        box.x >= mask.x - MASK_PAD &&
        box.y >= mask.y - MASK_PAD &&
        box.x + box.width <= mask.x + mask.width + MASK_PAD &&
        box.y + box.height <= mask.y + mask.height + MASK_PAD,
    ),
  );
  check(
    "masked regions keep the reference geometry",
    covered.length === inFrame.length,
    JSON.stringify({ inFrame, drawn }),
  );

  // --masks: without it compare.mjs masks nothing, and the region checked
  // for geometry just above is diffed as pixels anyway.
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
      "--only",
      FRAME_NAME,
    ],
    { stdio: "inherit" },
  );
  if (compare.status !== 0) check(`${FRAME_NAME} pixel parity`, false, "compare.mjs failed");
} finally {
  await stopRig(rig);
  // Retries, like every other gate: on Windows the engine holds queue.db
  // open for a beat after it exits, and an EPERM here would crash the
  // script AFTER its checks — reporting a node stack trace instead of the
  // verdict it had already reached.
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  rmSync(profile, scrub);
  rmSync(engineData, scrub);
}

if (!scaleHeld) process.exit(RETRYABLE_EXIT);
process.exit(check.failures() > 0 ? 1 : 0);
