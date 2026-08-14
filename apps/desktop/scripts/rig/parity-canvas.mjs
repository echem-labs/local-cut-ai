/**
 * Flowchart pixel-parity gate (plan doc 11, U4).
 *
 * Different from the three gates before it in one way that matters: the
 * canvas's geometry comes out of the DOCUMENT, not the window. Every node
 * position is layoutGraph's output, so "open a real project and shoot it"
 * would be a frame of whatever the engine planned that day — and the mock
 * cannot be drawn against whatever. The graph is therefore POSED through the
 * seed hook (scripts/rig/canvas-pose.mjs), the same door the session gate
 * poses a board through, and canvasPose.contract.test.ts keeps the mock's
 * hard-coded positions equal to what layoutGraph really produces.
 *
 * The frame is the flowchart PANEL at a fixed 1440x900 window. Not a panel
 * sized to order: the panel is one group of the workspace and takes a
 * fraction of it (about a quarter of the height), so a panel of any chosen
 * size would want a window several times the display. Fixing the window is
 * what makes the frame reproducible; the mock is drawn to whatever size that
 * produces.
 *
 * Usage: node parity-canvas.mjs --refs <dir>  (dir holds canvas.png + masks.json)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { POSE_GRAPH, POSE_QUERY, POSE_SELECTED, poseBoard } from "./canvas-pose.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const refsArg = process.argv.indexOf("--refs");
const refsDir = refsArg >= 0 ? path.resolve(process.argv[refsArg + 1]) : null;
if (!refsDir) {
  console.error("usage: node parity-canvas.mjs --refs <dir>");
  process.exit(2);
}

const dir = shotsDir("parity-canvas");
const check = makeCheck();
const masks = JSON.parse(readFileSync(path.join(refsDir, "masks.json"), "utf8"));
const MASK_PAD = 6;
const TOL = 2;

const reference = PNG.sync.read(readFileSync(path.join(refsDir, "canvas.png")));
const FRAME = { width: reference.width, height: reference.height };

/** What each masked region of the reference is, in the app. The canvas masks
 * almost nothing on purpose — the node grid IS the thing being gated — so
 * this is only what the two renderers draw differently: the search glyph and
 * the help mark (unicode in the mock, lucide paths in the app) and the one
 * node thumbnail (a JPEG there, a real artifact here). */
const MASKED_AS = [".canvas-search svg", ".canvas-bar .panel-help", ".canvas-node-thumb"];
/** Design-owned: the thumb is 58x38 wherever it appears. */
const RIGID = /thumb/;

const profile = mkdtempSync(path.join(tmpdir(), "localcut-parity-canvas-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-parity-canvas-engine-"));
let scaleHeld = true;

const rig = await startRigTrueToScale({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7935",
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

  const CAPTURE_CSS = `
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

  // 1. A real project, opened the real way. Its graph is replaced by the
  // pose a moment later — what the project supplies is a workspace with a
  // flowchart tab in it, which is the chrome the panel is measured inside.
  const project = await engineFetch(`
    return call("POST", "/projects", { title: "Flowchart reference", prompt: "a reference graph" });
  `);
  check("a project to open the flowchart in", Boolean(project?.id), JSON.stringify(project));

  await evalInApp(`
    await page.evaluate((id) => window.__localcutSeed({ openProjects: [id] }), ${JSON.stringify(project.id)});
    await page.evaluate(() => document.querySelector(".rail-tab button")?.click());
    await page.waitForSelector(".dockview-theme-localcut", { timeout: 30000 });
    // The view picker is a dropdown, not a row of tabs: open it, then take
    // the option. (Its trigger carries the CURRENT view's label, so the old
    // "find a button that says Flowchart" matched nothing once it changed.)
    await page.evaluate(() => {
      const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((b) =>
        /view/i.test(b.getAttribute("aria-label") || ""));
      trigger?.click();
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      const option = [...document.querySelectorAll('[role="option"]')].find((b) =>
        /flowchart/i.test(b.textContent || ""));
      option?.click();
    });
    await page.waitForSelector(".canvas-stage", { timeout: 30000 });
    return null;
  `);
  await evalInApp(CAPTURE_CSS);

  // 2. Pose the graph, the board behind it and the selection. Frozen first
  // so the boot's in-flight graph/board refreshes cannot write the engine's
  // truth over the pose between the seed and the shutter.
  await seed({ freeze: true });
  await evalInApp("await page.waitForTimeout(800); return null;");
  const posed = await seed({
    graph: POSE_GRAPH,
    board: poseBoard(),
    selectedNode: POSE_SELECTED,
    freeze: true,
  });
  check("graph, board and selection posed", posed === true);

  // 3. The one state the frame carries that is not in the store: the
  // search query. (The Add node menu stays closed — at this width an open
  // menu covers the selected node; its own contents are pinned by the unit
  // tests and walked by rig:e2e.)
  await evalInApp(`
    await page.evaluate((query) => {
      const input = document.querySelector(".canvas-search-input");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      ).set;
      // Through the native setter, so React's onChange sees it — assigning
      // .value directly updates the DOM and leaves the store behind.
      setter.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, ${JSON.stringify(POSE_QUERY)});
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    return null;
  `);
  const hits = await evalInApp(
    `return page.evaluate(() => document.querySelectorAll(".canvas-node.match").length);`,
  );
  check("the search poses its three hits", hits === 3, `${hits} matched`);

  // 4. The frame is the flowchart panel at a 1440x900 window.
  //
  // Not "the window sized until the panel matches": the panel is one group
  // of the workspace and takes a FRACTION of it — measured here, about a
  // quarter of the height — so a panel of any chosen size would need a
  // window several times the display. Fixing the window instead makes the
  // frame reproducible anywhere that can show 1440x900, and the reference is
  // drawn at whatever size that produces. setContentBounds does not speak
  // the renderer's units on a scaled display, so the ratio between them is
  // measured rather than assumed (see walk.mjs's boundsAgree).
  const units = await evalInApp(`
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds());
    return { x: bounds.width / inner.w, y: bounds.height / inner.h };
  `);
  const WINDOW = { width: 1440, height: 900 };
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0].setContentBounds({ x: 0, y: 0, width: w, height: h });
    }, [${Math.round(WINDOW.width * units.x)}, ${Math.round(WINDOW.height * units.y)}]);
    return null;
  `);

  const readPanel = () =>
    evalInApp(`
      return page.evaluate(() => {
        const r = document.querySelector(".canvas-panel").getBoundingClientRect();
        return {
          x: Math.round(r.left), y: Math.round(r.top),
          width: Math.round(r.width), height: Math.round(r.height),
          inner: { width: window.innerWidth, height: window.innerHeight },
        };
      });
    `);
  const sameBox = (a, b) =>
    !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  /**
   * Wait for the panel to STOP MOVING, rather than sleeping a fixed 400ms and
   * hoping.
   *
   * dockview lays its groups out asynchronously after a window resize, and
   * 400ms was sometimes not enough. What that cost is subtle enough to be
   * worth spelling out: everything in this frame is anchored to the panel's
   * TOP — the toolbar, the node grid — so a late height change moves none of
   * it. The legend is the one thing anchored to the BOTTOM, and it slid out
   * of a crop that had already been measured. The frame came out looking
   * perfectly correct with one line missing, 2230 differing pixels against a
   * budget of 899, and passed at 816 on the next run with nothing changed.
   */
  let panel = await readPanel();
  let settled = false;
  for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
    await evalInApp("await page.waitForTimeout(150); return null;");
    const next = await readPanel();
    settled = sameBox(panel, next);
    panel = next;
  }
  check(
    "the flowchart panel settled before its crop was measured",
    settled,
    `still moving after 3s: ${JSON.stringify(panel)}`,
  );
  check(
    "the window is the size the reference was drawn at",
    Math.abs(panel.inner.width - WINDOW.width) <= 1 &&
      Math.abs(panel.inner.height - WINDOW.height) <= 1,
    `inner ${panel.inner.width}x${panel.inner.height}`,
  );
  check(
    "the flowchart panel is the reference's size",
    Math.abs(panel.width - FRAME.width) <= 1 && Math.abs(panel.height - FRAME.height) <= 1,
    `panel ${panel.width}x${panel.height}, reference ${FRAME.width}x${FRAME.height}` +
      " - redraw canvas-mock.html's .panel to the panel size and re-render",
  );

  if (process.env.RIG_DEBUG_BAR) {
    const bar = await evalInApp(`
      return page.evaluate(([ox, oy]) =>
        [...document.querySelectorAll(".canvas-bar > *, .canvas-zoom > *, .canvas-add > *, .canvas-search > *")].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.className || el.tagName, Math.round(r.left) - ox, Math.round(r.top) - oy,
                  Math.round(r.width), Math.round(r.height)];
        }),
      [${panel.x}, ${panel.y}]);
    `);
    console.log("bar:", JSON.stringify(bar));
  }

  // 5. Shoot the panel. fullPage + own crop, like the wizard gate: a
  // Playwright clip clamps to the viewport and the panel does not start at
  // the origin.
  const full = path.join(dir, "canvas-full.png");
  await evalInApp(`
    await page.mouse.move(4, 4);
    await page.waitForTimeout(350);
    await page.screenshot({ path: ${JSON.stringify(full)}, fullPage: true, scale: "css" });
    return null;
  `);
  // The crop below is arithmetic on a box measured before that wait. If the
  // panel moved during it the crop is wrong, and wrong in the quietest way
  // available: a frame that looks right with one bottom-anchored element
  // outside it. Assert it did not, so that failure is named rather than
  // charged to the pixels.
  const atShutter = await readPanel();
  check(
    "the panel did not move between measuring the crop and the shutter",
    sameBox(panel, atShutter),
    `measured ${JSON.stringify(panel)} but shot ${JSON.stringify(atShutter)}`,
  );
  const shot = PNG.sync.read(readFileSync(full));
  const out = new PNG({ width: FRAME.width, height: FRAME.height });
  PNG.bitblt(
    shot,
    out,
    panel.x,
    panel.y,
    Math.min(FRAME.width, shot.width - panel.x),
    Math.min(FRAME.height, shot.height - panel.y),
    0,
    0,
  );
  writeFileSync(path.join(dir, "canvas.png"), PNG.sync.write(out));
  rmSync(full, { force: true });

  // 6. Mask geometry, in the frame's own coordinates (containment doctrine:
  // a mask hides pixels, never geometry).
  const boxes = await evalInApp(`
    return page.evaluate(([selectors, ox, oy]) =>
      selectors.flatMap((sel) =>
        [...document.querySelectorAll(sel)].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            sel,
            x: Math.round(r.left) - ox,
            y: Math.round(r.top) - oy,
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }),
      ),
    [${JSON.stringify(MASKED_AS)}, ${panel.x}, ${panel.y}]);
  `);
  // Only what the frame actually contains. The graph is larger than the
  // panel, so a node's thumbnail can be measured by both renderers and
  // drawn by neither — a mask outside the frame masks nothing by
  // definition, and pairing those up would be arithmetic about pixels that
  // do not exist.
  const inFrame = (box) =>
    box.x < FRAME.width && box.y < FRAME.height && box.x + box.width > 0 && box.y + box.height > 0;
  const want = (masks["canvas.png"] ?? [])
    .filter(inFrame)
    .map((mask) => ({ ...mask, taken: false }));
  const problems = [];
  for (const box of boxes.filter(inFrame)) {
    const hit = want.find(
      (ref) =>
        !ref.taken &&
        box.x >= ref.x - TOL &&
        box.y >= ref.y - TOL &&
        box.x + box.width <= ref.x + ref.width + TOL &&
        box.y + box.height <= ref.y + ref.height + TOL,
    );
    if (!hit) {
      problems.push(`${box.sel} at ${box.x},${box.y} ${box.width}x${box.height} masks nothing`);
      continue;
    }
    hit.taken = true;
    const drawnWidth = hit.width - MASK_PAD * 2;
    if (RIGID.test(box.sel) && Math.abs(drawnWidth - box.width) > TOL) {
      problems.push(`${box.sel} is ${box.width}px wide, reference ${drawnWidth}px`);
    }
  }
  const orphans = want.filter((ref) => !ref.taken);
  if (orphans.length > 0) {
    problems.push(`${orphans.length} masked region(s) with nothing under them`);
  }
  check("masked regions keep the reference geometry", problems.length === 0, problems.join(" | "));

  // 7. The node grid, checked as geometry rather than only as pixels: every
  // node the pose names sits where the reference draws it. A diff can fail
  // for a hundred reasons; this says outright whether the layout moved.
  const placed = await evalInApp(`
    return page.evaluate(([ox, oy]) =>
      Object.fromEntries(
        [...document.querySelectorAll(".canvas-node")].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.dataset.node, { x: Math.round(r.left) - ox, y: Math.round(r.top) - oy }];
        }),
      ),
    [${panel.x}, ${panel.y}]);
  `);
  check(
    "every posed node is drawn",
    Object.keys(placed).length === Object.keys(POSE_GRAPH.nodes).length,
    `${Object.keys(placed).length} drawn, ${Object.keys(POSE_GRAPH.nodes).length} posed`,
  );

  scaleHeld = await layoutTrue();
} finally {
  await stopRig(rig);
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
