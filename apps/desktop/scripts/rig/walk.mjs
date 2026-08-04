/**
 * Resize-correctness and responsive walk (plan doc 11, rules 5 + U0).
 *
 * At 1200x800, 1440x900, 1920x1080 (clamped by the display) and maximized:
 *   - the renderer's inner size matches BrowserWindow.getContentBounds()
 *     within 2px (the maximize bug's exact signature when it regresses);
 *   - no horizontal scroll on the document;
 *   - the project grid never LOSES columns as the window widens;
 *   - the rail auto-compacts below 1000px and expands back.
 * Screenshots land in shots/<stamp>-walk/ for the eyeball pass.
 *
 * Usage: node walk.mjs [--ozone=x11]
 */
import path from "node:path";
import { evalInApp, health, makeCheck, shotsDir, startRig, stopRig } from "./rig.mjs";

const ozone = process.argv.find((arg) => arg.startsWith("--ozone="))?.slice(8);
const dir = shotsDir(ozone ? `walk-${ozone}` : "walk");
const check = makeCheck();

/** The renderer speaks CSS pixels; on scaled Wayland Electron's bounds come
 * back in physical pixels (verified 2026-08-03: inner 1477 css, dpr 1.3,
 * bounds 1920 — the DOM laid out and fit exactly). Either unit relation
 * counts as agreement; a true regression (the renderer keeping a stale
 * size) matches neither. */
const boundsAgree = (inner, bounds, dpr) =>
  Math.abs(inner - bounds) <= 2 || Math.abs(inner * dpr - bounds) <= 2 + dpr;

const rig = await startRig(ozone ? { RIG_OZONE: ozone } : {});
try {
  // Let the renderer connect and paint Home.
  await evalInApp("await page.waitForSelector('.home, .setup', { timeout: 30000 }); return null;");

  // The shelf arrives with the engine's project list, which lands well
  // after Home paints: a cold `uv run localcut serve` against a real data
  // dir has taken over 20s here. Measuring before it arrives would skip
  // every grid assertion below and still print a green run - so wait
  // generously, and say so if it never comes.
  const shelfReady = await evalInApp(`
    return page
      .waitForSelector(".recent .grid", { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
  `);
  check(
    "home has a project shelf to measure",
    shelfReady,
    "the walk needs a profile with at least one project",
  );
  if (!shelfReady) {
    // Nearly always the engine, not the profile: it prints why it gave up
    // to the main process, which /health now carries. Printing it here
    // turns "no shelf" into the actual reason without a second run.
    const log = (await health()).mainLog ?? [];
    for (const line of log.filter((entry) => entry.includes("[engine]")).slice(-4)) {
      console.error(`       ${line}`);
    }
  }

  const measure = async () => {
    return evalInApp(`
      const win = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return { bounds: w.getContentBounds(), maximized: w.isMaximized() };
      });
      const dom = await page.evaluate(() => ({
        inner: { width: window.innerWidth, height: window.innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        gridCols: (() => {
          const grid = document.querySelector(".recent .grid");
          if (!grid) return null;
          return getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        })(),
        railCompact: !!document.querySelector(".rail.compact"),
        railToggleDisabled: (() => {
          const nav = document.querySelector("nav.rail");
          const buttons = nav ? [...nav.querySelectorAll("button")] : [];
          return buttons.length ? buttons[buttons.length - 1].disabled : null;
        })(),
        // Home is one column: the Continue shelf shares both edges with the
        // prompt above it, at every width (app.css, .home).
        shelf: (() => {
          const shelf = document.querySelector(".recent");
          const column = document.querySelector(".prompt-box, .empty-state");
          if (!shelf || !column) return null;
          const a = shelf.getBoundingClientRect();
          const b = column.getBoundingClientRect();
          return {
            width: Math.round(a.width),
            left: Math.round(a.left) - Math.round(b.left),
            right: Math.round(a.right) - Math.round(b.right),
          };
        })(),
        dpr: window.devicePixelRatio,
      }));
      return { win, dom };
    `);
  };

  const setSize = async (width, height) => {
    await evalInApp(`
      await app.evaluate(({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w.isMaximized()) w.unmaximize();
        w.setContentBounds({ x: 40, y: 40, width: size[0], height: size[1] });
      }, [${width}, ${height}]);
      await page.waitForTimeout(700);
      return null;
    `);
  };

  const shoot = (name) =>
    evalInApp(`await page.screenshot({ path: ${JSON.stringify(path.join(dir, name))} }); return null;`);

  const sizes = [
    [1200, 800],
    [1440, 900],
    [1920, 1080],
  ];
  let previousCols = 0;
  for (const [width, height] of sizes) {
    await setSize(width, height);
    const { win, dom } = await measure();
    const label = `${width}x${height}`;
    // The WM may clamp the request to the display; assert agreement, not
    // the requested number.
    check(
      `${label}: renderer matches window bounds`,
      boundsAgree(dom.inner.width, win.bounds.width, dom.dpr) &&
        boundsAgree(dom.inner.height, win.bounds.height, dom.dpr),
      `inner ${dom.inner.width}x${dom.inner.height} vs bounds ${win.bounds.width}x${win.bounds.height} (dpr ${dom.dpr})`,
    );
    check(
      `${label}: no horizontal scroll`,
      dom.scrollWidth <= dom.inner.width + 1,
      `scrollWidth ${dom.scrollWidth} > innerWidth ${dom.inner.width}`,
    );
    if (dom.gridCols !== null) {
      check(
        `${label}: grid columns never shrink as the window grows (${dom.gridCols})`,
        dom.gridCols >= previousCols,
        `${dom.gridCols} < ${previousCols}`,
      );
      previousCols = dom.gridCols;
    }
    // Independent of gridCols: a profile with no projects has a shelf-less
    // Home, and reading .shelf under the gridCols branch would have thrown
    // rather than skipped.
    if (dom.shelf) {
      if (dom.gridCols !== null) {
        // Monotonicity alone would also pass a grid frozen at one count, so
        // pin the count the shelf's own width implies: auto-fill of
        // minmax(200px, 1fr) at a 12px gap.
        const implied = Math.floor((dom.shelf.width + 12) / 212);
        check(
          `${label}: ${dom.gridCols} columns is what ${dom.shelf.width}px fits`,
          dom.gridCols === implied,
          `expected ${implied}`,
        );
      }
      // The shelf head carries "Open the library ->" on its right edge, so a
      // shelf wider than the page column hangs that link past every other
      // block — the reason the breakout came out (review v5, follow-up).
      check(
        `${label}: the Continue shelf shares both edges with the page column`,
        dom.shelf.left === 0 && dom.shelf.right === 0,
        `left ${dom.shelf.left}px, right ${dom.shelf.right}px off the column`,
      );
    }
    await shoot(`${label}.png`);
  }

  // Maximize round-trip — the exact regression walk exists to catch.
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await page.waitForTimeout(900);
    return null;
  `);
  const maxed = await measure();
  check("maximized: window reports maximized", maxed.win.maximized);
  check(
    "maximized: renderer matches window bounds",
    boundsAgree(maxed.dom.inner.width, maxed.win.bounds.width, maxed.dom.dpr) &&
      boundsAgree(maxed.dom.inner.height, maxed.win.bounds.height, maxed.dom.dpr),
    `inner ${maxed.dom.inner.width}x${maxed.dom.inner.height} vs bounds ${maxed.win.bounds.width}x${maxed.win.bounds.height} (dpr ${maxed.dom.dpr})`,
  );
  check(
    "maximized: no horizontal scroll",
    maxed.dom.scrollWidth <= maxed.dom.inner.width + 1,
  );
  await shoot("maximized.png");
  await evalInApp(`
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await page.waitForTimeout(700);
    return null;
  `);
  const restored = await measure();
  check(
    "unmaximize: renderer matches window bounds",
    boundsAgree(restored.dom.inner.width, restored.win.bounds.width, restored.dom.dpr),
  );

  // Rail auto-compact under 1000px, and back. The "and back" half is the
  // point: the preference has to survive the narrow spell, so it is read
  // before narrowing and compared after widening.
  await setSize(1440, 900);
  const preference = (await measure()).dom.railCompact;
  await setSize(980, 800);
  const narrow = await measure();
  check("980px: rail auto-compacts", narrow.dom.railCompact);
  check(
    "980px: the rail toggle is disabled rather than dead",
    narrow.dom.railToggleDisabled === true,
    `disabled=${narrow.dom.railToggleDisabled}`,
  );
  await shoot("980x800.png");
  await setSize(1440, 900);
  const wide = await measure();
  check(
    "1440px: rail returns to the stored preference",
    wide.dom.railCompact === preference,
    `was ${preference}, now ${wide.dom.railCompact}`,
  );
  check("1440px: the rail toggle works again", wide.dom.railToggleDisabled === false);

  const report = await health();
  check(
    "no console errors during the walk",
    report.consoleErrors.length === 0 && report.pageErrors.length === 0,
    JSON.stringify([...report.consoleErrors, ...report.pageErrors].slice(0, 3)),
  );
} finally {
  await stopRig(rig);
}

console.log(`shots: ${dir}`);
if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("walk: all checks passed");
