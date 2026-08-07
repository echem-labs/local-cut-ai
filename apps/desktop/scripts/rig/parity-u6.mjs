/**
 * About pixel-parity gate (plan doc 11, U6).
 *
 * The frame is the About pane's own 640px column — the mock's width is not
 * a coincidence: `.settings` caps at `--content-col` (840) over a
 * `176px 1fr` grid with a 24px gap, so the pane the app renders IS 640.
 * The window is fixed at 1440x900 like every other panel gate, and the
 * capture is clipped to `.about`.
 *
 * One thing is POSED, and it has to be. The update controls do not render
 * until a release feed is configured (U6: "the button hides behind a
 * config flag"), which is the shipping state and the one the mock does not
 * draw. So this gate starts a loopback server answering as a release feed,
 * points the shell at it through the environment — the same variable a
 * release build would set — and clicks Check for updates. That renders the
 * up-to-date row the mock shows. Posing it in the store instead would gate
 * a state the app cannot actually reach.
 *
 * Usage: node parity-u6.mjs --refs <dir>   (dir holds about.png + masks.json)
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
  console.error("usage: node parity-u6.mjs --refs <dir>");
  process.exit(2);
}

const FRAME_NAME = "about.png";
const dir = shotsDir("parity-u6");
const check = makeCheck();
const reference = PNG.sync.read(readFileSync(path.join(refsDir, FRAME_NAME)));
const FRAME = { width: reference.width, height: reference.height };
const MASK_PAD = 6;

/**
 * What each masked region is, in the app — a mask is a promise that only
 * the DATA differs there, so each of these is either a drawing difference
 * or a deviation recorded in the plan.
 *
 * `.mark`      → the app's BrandMark is an SVG; the mock is a CSS box.
 * `.uptodate`  → the check ran just now here and "2 hours ago" in the mock.
 * `.whatsnew`  → same row, same reason.
 * `.chips`     → both draw a chip per fact, but the facts are this
 *                machine's: the mock names an RTX 3080 and the reference
 *                would otherwise gate whatever GPU the runner has.
 * `.kv dd`     → the same, in the list under it: tier, backend chain,
 *                engine URL, data folder. The `dt` labels are diffed.
 * `.privacy p` → the app says "LocalCut AI" where the mock said
 *                "LocalCut", so the sentence wraps a word earlier.
 */
const MASKED_AS = {
  ".mark": ".about-version svg",
  ".uptodate": ".about-update-row",
  ".whatsnew": ".about-whatsnew",
  ".chips": ".about-card .spec-chips",
  ".kv dd": ".about-kv dd",
  ".privacy p": ".about-privacy p",
};

/** A stand-in for the release feed, answering with THIS build's version so
 * the app lands on "Up to date" rather than offering an update to itself. */
function startFeed(version) {
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tag_name: `v${version}`, html_url: "https://example.invalid" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/latest`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}

const appVersion = JSON.parse(
  readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"),
).version;

const feed = await startFeed(appVersion);
let rig;
try {
  rig = await startRigTrueToScale({ LOCALCUT_UPDATE_FEED: feed.url });
} catch (error) {
  await feed.close();
  throw error;
}

try {
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentBounds({ x: 40, y: 40, width: 1440, height: 900 });
    });
    await page.waitForTimeout(700);
    return null;
  `);
  if (!(await layoutTrue())) {
    console.error("the renderer booted off-scale - retry");
    process.exit(RETRYABLE_EXIT);
  }

  // Settings → About, then run the update check so the card carries the
  // row the mock draws.
  const opened = await evalInApp(`
    await page.evaluate(() => {
      const rail = [...document.querySelectorAll("button")].find((b) =>
        /settings/i.test(b.getAttribute("aria-label") || b.textContent || ""));
      rail?.click();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".settings-grid nav button")].find(
        (b) => (b.textContent || "").trim() === "About");
      tab?.click();
    });
    await page.waitForSelector(".about", { timeout: 10000 });
    const checked = await page.evaluate(async () => {
      const button = [...document.querySelectorAll(".about-update-row button")][0];
      if (!button) return false;
      button.click();
      return true;
    });
    // The check is one IPC round trip to a loopback server; a beat is
    // enough, and waiting on the text would hide a check that never ran.
    await page.waitForTimeout(900);
    return page.evaluate((ran) => {
      const about = document.querySelector(".about");
      const box = about.getBoundingClientRect();
      return {
        ran,
        upToDate: !!document.querySelector(".about-uptodate"),
        chips: document.querySelectorAll(".about-card .spec-chip").length,
        box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) },
        height: Math.ceil(box.height),
      };
    }, checked);
  `);

  check(
    "the pane is the 640px reading column the mock is drawn to",
    opened.box.width === FRAME.width,
    `pane ${opened.box.width}px, reference ${FRAME.width}px`,
  );
  // Without the posed feed there is no update row at all, and the frame
  // would differ from the mock by a whole band for a reason that has
  // nothing to do with the design.
  check(
    "the posed release feed reached the update check",
    opened.ran && opened.upToDate,
    JSON.stringify(opened),
  );
  // Said out loud rather than passed over: no engine means no chips, and
  // the frame would then differ in a region this gate has masked.
  if (opened.chips === 0) {
    console.log("NOTE About: no spec chips (the engine reported no system) - masked region empty");
  }

  const shot = path.join(dir, FRAME_NAME);
  await evalInApp(`
    await page.screenshot({
      path: ${JSON.stringify(shot)},
      scale: "css",
      clip: ${JSON.stringify({
        x: opened.box.x,
        y: opened.box.y,
        width: FRAME.width,
        height: FRAME.height,
      })},
    });
    return null;
  `);

  // Mask geometry: every control a mask was drawn for is still under one.
  // Same doctrine as the panel gates before this — a mask that has drifted
  // off its control is hiding real pixels, and the check is per-BOX rather
  // than per-selector because the mask file carries geometry only.
  const boxes = await evalInApp(`
    return page.evaluate((selectors) => {
      const about = document.querySelector(".about").getBoundingClientRect();
      return selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            selector,
            x: Math.round(r.x - about.x),
            y: Math.round(r.y - about.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }),
      );
    }, ${JSON.stringify(Object.values(MASKED_AS))});
  `);

  const masks = JSON.parse(readFileSync(path.join(refsDir, "masks.json"), "utf8"));
  const drawn = masks[FRAME_NAME] ?? [];
  const inFrame = boxes.filter(
    (box) =>
      box.width > 0 &&
      box.x + box.width > 0 &&
      box.y + box.height > 0 &&
      box.x < FRAME.width &&
      box.y < FRAME.height,
  );
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
    JSON.stringify({
      uncovered: inFrame.filter((box) => !covered.includes(box)),
      drawn,
    }),
  );

  // --masks, or the regions checked for geometry above are still diffed as
  // pixels: compare.mjs masks nothing unless it is handed the file, and the
  // "outside masks" in its own verdict line then means outside no masks at
  // all.
  const compared = spawnSync(
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
  check("the pane matches the mock within budget", compared.status === 0, `compare exited ${compared.status}`);
} finally {
  await stopRig(rig);
  await feed.close();
}

console.log(`shots: ${dir}`);
if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("parity-u6: all checks passed");
