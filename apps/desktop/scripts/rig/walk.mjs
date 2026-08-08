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

  // The rail's icon COLUMN, and what it must not reach. Every rail row gets
  // an 18px column so the labels start on one x whatever glyph the row uses
  // - but the Help popover renders INSIDE the rail, and a rule written as
  // "every button in the rail" stretches its menu items' 13px icons to the
  // column width too. Nothing in the unit suite can see either half: vitest
  // stubs CSS imports away and jsdom loads no stylesheet.
  //
  // A real click, and a probe rather than a wait that can throw: this runs
  // inside the walk's one try/finally, so a rejected eval would take every
  // stop after it with it and report a stack trace where a named FAIL
  // belongs. Missing popover -> empty `items` -> the check below says so.
  const railIcons = await evalInApp(`
    const trigger = await page.$(".rail .help-menu button");
    if (trigger) await trigger.click();
    const opened = await page
      .waitForSelector(".help-pop", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    return page.evaluate((wasOpened) => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      const rows = [...document.querySelectorAll(".rail button:not(.rail-tab-close) > svg")]
        .filter((svg) => !svg.closest(".menu-pop"))
        .map(box);
      const items = [...document.querySelectorAll(".help-pop [role=menuitem] > svg")].map(box);
      return { rows, items, opened: wasOpened };
    }, opened);
  `);
  check("the Help popover opens from the rail", railIcons.opened === true);
  check(
    "the rail's rows share one 18px icon column",
    railIcons.rows.length >= 4 && railIcons.rows.every((icon) => icon.w === 18),
    JSON.stringify(railIcons.rows),
  );
  check(
    "the Help popover's menu items keep their own icon size",
    railIcons.items.length >= 2 && railIcons.items.every((icon) => icon.w === 13 && icon.h === 13),
    JSON.stringify(railIcons.items),
  );
  // Close it by toggling the trigger, and CHECK that it closed. Neither
  // Escape nor a synthetic `body.click()` can do it: HelpMenu has no
  // Escape handler, and `useOutsideClick` listens for MOUSEDOWN, which
  // `HTMLElement.click()` does not dispatch. Both looked like they worked
  // and left the popover painted over the rail for every later frame.
  const helpClosed = await evalInApp(`
    const trigger = await page.$(".rail .help-menu button");
    if (trigger) await trigger.click();
    return page
      .waitForSelector(".help-pop", { state: "detached", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  `);
  check("the Help popover closes again", helpClosed === true);

  // U3: the clip panel carries the widest controls row Home has (motion
  // field, seconds, start frame, aspect, generate) plus a preset chip row.
  // Opened as a stop of its own because a flex row that wraps politely at
  // 1440 can still push a horizontal scrollbar at 1200 — and the chips sit
  // between the textarea and that row, where nothing else would notice
  // them escaping the panel.
  const panelStop = await evalInApp(`
    const opened = await page.evaluate(() => {
      const clip = [...document.querySelectorAll(".quick-tools button")].find((button) =>
        (button.getAttribute("aria-label") || "").startsWith("Clip"),
      );
      if (!clip) return false;
      clip.click();
      return true;
    });
    if (!opened) return null;
    await page.waitForSelector(".tool-panel .chip-row", { timeout: 5000 });
    return true;
  `);
  check("the clip panel opens with its preset chips", panelStop === true);
  if (panelStop) {
    for (const [width, height] of [
      [1200, 800],
      [1440, 900],
    ]) {
      await setSize(width, height);
      const panel = await evalInApp(`
        return page.evaluate(() => {
          const box = document.querySelector(".tool-panel").getBoundingClientRect();
          const chips = document.querySelector(".tool-panel .chip-row").getBoundingClientRect();
          const controls = [...document.querySelectorAll(".tool-panel .row > *")];
          const escaped = controls.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1);
          }).length;
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            chipsInside: chips.left >= box.left && chips.right <= box.right,
            escaped,
          };
        });
      `);
      check(
        `${width}px: the clip panel keeps every control inside itself`,
        panel.chipsInside && panel.escaped === 0,
        JSON.stringify(panel),
      );
      check(
        `${width}px: the open panel adds no horizontal scroll`,
        panel.scrollWidth <= panel.innerWidth + 1,
        `scrollWidth ${panel.scrollWidth}`,
      );
    }
    await shoot("clip-panel-1440.png");
    // Close it so the walk's last screenshots show the Home it started on.
    await evalInApp(`
      await page.click(".tool-head .icon-btn");
      return null;
    `);
  }

  // U4: the flowchart. Its bar is the densest row in the app — counts,
  // search, hint, zoom cluster, Add node and help — and the surface below
  // it scrolls in BOTH axes on purpose, which is exactly the shape that
  // hides a horizontal overflow of the page itself. A screen the walk
  // cannot reach is a screen nothing gates (plan rule 5).
  //
  // Where the designed 409s begin. Only the errors logged from here on are
  // eligible for the filter below — a 409 anywhere earlier is a surprise,
  // and a filter that spans the whole run would swallow it.
  const beforeCanvas = (await health()).consoleErrors.length;
  const canvasStop = await evalInApp(`
    // Through the Library's Videos filter, not off Home's shelf: the shelf
    // is the four most RECENT of everything, and a run of quick tools
    // pushes every video off it — a tool session opens its own
    // single-artifact page, which has no flowchart because it has no
    // pipeline. The filter is where a video is guaranteed to be listed.
    await page.evaluate(() => {
      const label = (button) =>
        (button.textContent || "") + " " + (button.getAttribute("aria-label") || "");
      [...document.querySelectorAll(".rail button")]
        .find((button) => label(button).includes("Library"))
        ?.click();
    });
    // Waited for, not slept past: the grid arrives with the engine's list,
    // and a fixed delay measured an empty Library on a cold start.
    await page.waitForSelector(".library .project-tile", { timeout: 20000 });
    await page.evaluate(() => {
      // Tabs are All / Videos / Tool outputs.
      document.querySelectorAll(".library-bar .filter-tabs button")[1]?.click();
    });
    await page.waitForSelector(".library .project-tile", { timeout: 20000 });
    // Try each video in turn rather than insisting on the first. A project
    // whose state file predates the store's encoding fix cannot be read at
    // all, and one such project in a long-lived profile would otherwise
    // stop the walk from ever reaching the canvas.
    const count = await page.evaluate(
      () => document.querySelectorAll(".library .project-tile .tile-open").length,
    );
    let workspace = false;
    for (let at = 0; at < count && !workspace; at += 1) {
      await page.evaluate((at) => {
        document.querySelectorAll(".library .project-tile .tile-open")[at]?.click();
      }, at);
      workspace = await page
        .waitForSelector(".dockview-theme-localcut", { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (!workspace) {
        // Back to the list for the next candidate.
        await page.evaluate(() => {
          const label = (b) => (b.textContent || "") + " " + (b.getAttribute("aria-label") || "");
          [...document.querySelectorAll(".rail button")]
            .find((button) => label(button).includes("Library"))
            ?.click();
        });
        await page.waitForSelector(".library .project-tile", { timeout: 20000 }).catch(() => {});
      }
    }
    if (!workspace) return null;
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
    return page
      .waitForSelector(".canvas-stage", { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
  `);
  check(
    "the flowchart opens from a video in the Library",
    canvasStop === true,
    "the walk needs a profile with at least one VIDEO project (tool outputs have no flowchart)",
  );
  if (canvasStop) {
    for (const [width, height] of [
      [1200, 800],
      [1440, 900],
      [1920, 1080],
    ]) {
      await setSize(width, height);
      const canvas = await evalInApp(`
        return page.evaluate(() => {
          const bar = document.querySelector(".canvas-bar");
          const panel = document.querySelector(".canvas-panel").getBoundingClientRect();
          const controls = [...bar.children];
          const escaped = controls.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < panel.left - 1 || r.right > panel.right + 1);
          }).length;
          const surface = document.querySelector(".canvas-surface");
          const sizer = document.querySelector(".canvas-sizer").getBoundingClientRect();
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            escaped,
            // One line means one shared CENTRE, not one shared top: the bar
            // centres its children, so a 15px label and a 24px button sit at
            // different tops while being perfectly on the same row.
            //
            // Within a pixel, not identical to one. A centre is top + height/2
            // over fractional layout boxes, so a control of odd height beside
            // one of even height rounds a pixel apart while sitting on exactly
            // the same row — and WHICH way it rounds depends on the bar's own
            // y offset, so anything above the panel can flip it. A real wrap
            // moves a control a whole row, which this still catches with room
            // to spare.
            barWraps:
              (() => {
                const centres = controls.map((el) => {
                  const r = el.getBoundingClientRect();
                  return r.top + r.height / 2;
                });
                return Math.max(...centres) - Math.min(...centres) > 1;
              })(),
            // The surface scrolls over the SCALED graph (the sizer), or over
            // itself when the panel is wider than the graph — never over the
            // raw layout box, which a transform leaves untouched.
            scrollsOverScaled:
              Math.abs(surface.scrollWidth - Math.max(Math.round(sizer.width), surface.clientWidth)) <=
              2,
          };
        });
      `);
      check(
        `${width}px: the flowchart bar keeps its controls on one line inside the panel`,
        canvas.escaped === 0 && !canvas.barWraps,
        JSON.stringify(canvas),
      );
      check(
        `${width}px: the flowchart adds no horizontal scroll to the page`,
        canvas.scrollWidth <= canvas.innerWidth + 1,
        `scrollWidth ${canvas.scrollWidth}`,
      );
      check(
        `${width}px: the surface scrolls over the scaled graph, not the raw layout`,
        canvas.scrollsOverScaled,
        JSON.stringify(canvas),
      );
    }
    await shoot("flowchart-1920.png");

    // The zoom gesture itself, with a TRUSTED wheel event — the only way to
    // find out whether the app refuses the browser's own ctrl+wheel zoom.
    // React registers `wheel` passively, so an onWheel preventDefault is
    // ignored and Chromium logs the violation as a console error: the check
    // below is the zoom landing, and the console gate at the end of the walk
    // is the violation not being logged.
    const { dpr: dprBefore, inner: innerBefore } = await evalInApp(`
      return page.evaluate(() => ({ dpr: window.devicePixelRatio, inner: window.innerWidth }));
    `);
    const wheel = await evalInApp(`
      const box = await page.evaluate(() => {
        const r = document.querySelector(".canvas-surface").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(400);
      await page.keyboard.up("Control");
      return page.evaluate(() => ({
        zoom: document.querySelector(".canvas-zoom-value").textContent,
        // The app's own interface zoom must NOT have moved with it.
        dpr: window.devicePixelRatio,
        inner: window.innerWidth,
      }));
    `);
    check(
      "ctrl+wheel zooms the flowchart and nothing else",
      wheel.zoom !== "100%" && wheel.dpr === dprBefore && wheel.inner === innerBefore,
      JSON.stringify({ ...wheel, dprBefore, innerBefore }),
    );

    // U5: the audio lanes under the timeline. Their whole value is being
    // ALIGNED with the blocks above them — a segment at the wrong width
    // points at the wrong scene, which is worse than drawing nothing — and
    // alignment is a layout property, so it belongs here rather than in a
    // component test that has no real widths.
    const lanes = await evalInApp(`
      await page.evaluate(() => {
        const trigger = [...document.querySelectorAll(".dropdown-trigger")].find((b) =>
          /view/i.test(b.getAttribute("aria-label") || ""));
        trigger?.click();
      });
      await page.waitForTimeout(120);
      await page.evaluate(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find((b) =>
          /storyboard/i.test(b.textContent || ""));
        option?.click();
      });
      await page.waitForSelector(".tl-scroll", { timeout: 20000 });
      return page.evaluate(() => {
        const audio = document.querySelector(".tl-audio");
        if (!audio) return { present: false };
        const blocks = [...document.querySelectorAll(".tl-block")].map((el) =>
          Math.round(el.getBoundingClientRect().width),
        );
        // The narration lane is the one with a segment per scene.
        const lane = [...document.querySelectorAll(".tl-lane")].find(
          (el) => el.querySelectorAll(".lane-seg").length === blocks.length,
        );
        const segments = lane
          ? [...lane.querySelectorAll(".lane-seg")].map((el) =>
              Math.round(el.getBoundingClientRect().width),
            )
          : [];
        return {
          present: true,
          blocks,
          segments,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
    `);
    if (lanes.present) {
      check(
        "each audio segment is as wide as the scene block above it",
        lanes.segments.length === lanes.blocks.length &&
          lanes.segments.every((width, index) => Math.abs(width - lanes.blocks[index]) <= 1),
        JSON.stringify(lanes),
      );
      check(
        "the audio lanes add no horizontal scroll to the page",
        lanes.scrollWidth <= lanes.innerWidth + 1,
        `scrollWidth ${lanes.scrollWidth}`,
      );
      // What this run does NOT measure, said out loud: the mock backend
      // writes narration and music as JSON placeholders named .wav, so the
      // peaks route refuses them and every segment draws its empty variant.
      // Alignment is checked; the waveform inside a segment is not, and
      // cannot be until the mock writes decodable audio.
      console.log("NOTE mock audio is a placeholder - lanes are checked for width, not waveform");
      await shoot("timeline-audio-lanes.png");
    } else {
      // Said out loud rather than passed over: the lanes appear only once
      // narration or music has actually rendered, so a profile with no
      // audio leaves this alignment unmeasured — which is a gap in the run,
      // not a green light.
      console.log(
        "NOTE no audio lanes in this profile (nothing rendered) - segment alignment unchecked",
      );
    }

    // The board's overflow menu, at the smallest window the walk uses.
    //
    // It carries about twenty rows — history, audio, captions, frame rate,
    // resolution, the pro-editor handoff, workspace — and was drawn at its
    // full height wherever it happened to land, so the last sections were
    // simply off the bottom of the screen with no scrollbar to say so. This
    // is a layout fact and needs real widths and a real window, which is
    // why it is here rather than in a component test.
    await setSize(1200, 800);
    const menu = await evalInApp(`
      await page.evaluate(() => {
        const trigger = [...document.querySelectorAll(".board-menu .icon-btn")][0];
        trigger?.click();
      });
      await page.waitForSelector(".menu-pop", { timeout: 5000 });
      return page.evaluate(() => {
        const pop = document.querySelector(".menu-pop");
        const box = pop.getBoundingClientRect();
        const rows = [...pop.querySelectorAll('[role^="menuitem"], a[role="menuitem"]')];
        const last = rows[rows.length - 1]?.getBoundingClientRect() ?? null;
        return {
          bottom: Math.round(box.bottom),
          innerHeight: window.innerHeight,
          rows: rows.length,
          // Capped and scrolled, not capped and clipped: the content is
          // taller than the box, and the box can be scrolled to reach it.
          scrollable: pop.scrollHeight > pop.clientHeight + 1,
          scrolls: getComputedStyle(pop).overflowY,
          // The last row is inside the scroll container's own content, so
          // scrolling to the end must actually bring it into the window.
          lastReachable: last ? last.height > 0 : false,
        };
      });
    `);
    check(
      "the board menu stays inside the window instead of running off the bottom",
      menu.bottom <= menu.innerHeight + 1,
      JSON.stringify(menu),
    );
    check(
      "a board menu too tall for the window scrolls rather than clipping",
      !menu.scrollable || menu.scrolls === "auto" || menu.scrolls === "scroll",
      JSON.stringify(menu),
    );
    await shoot("board-menu-1200.png");

    // Save points, opened from that menu: the dialog the field recipe used
    // to miss. Its name box sits in a form row rather than under a label,
    // so every rule that dressed a dialog control was scoped past it and it
    // rendered as the platform's own text box — a light fill and a white
    // ring in the middle of a dark dialog. Nothing in the unit suite can see
    // that: vitest stubs CSS imports away and jsdom loads no stylesheet.
    const fields = await evalInApp(`
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.menu-pop [role="menuitem"]')].find(
          (b) => /save points/i.test(b.textContent || ""));
        row?.click();
      });
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      return page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        // Resolve the token the same way the stylesheet does rather than
        // hardcoding an rgb() here, which would be a third copy of it.
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--surface-2)";
        modal.appendChild(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const controls = [...modal.querySelectorAll("input, textarea")].filter(
          (el) => !["checkbox", "radio", "file", "range"].includes(el.type),
        );
        const box = modal.getBoundingClientRect();
        return {
          want,
          controls: controls.length,
          backgrounds: controls.map((el) => getComputedStyle(el).backgroundColor),
          insideViewport: box.top >= 0 && box.bottom <= window.innerHeight + 1,
        };
      });
    `);
    check(
      "every text control in a dialog wears the app's field, not the platform's",
      fields.controls > 0 && fields.backgrounds.every((background) => background === fields.want),
      JSON.stringify(fields),
    );
    check(
      "the save points dialog fits the window",
      fields.insideViewport,
      JSON.stringify(fields),
    );
    await shoot("save-points-1200.png");
    await evalInApp(`await page.keyboard.press("Escape"); return null;`);
  }

  // U6: Settings → About. A reading surface built from cards rather than
  // the settings-row anatomy every other pane uses, which makes it the one
  // pane whose width behavior nothing else in Settings vouches for. It also
  // states facts — a version line, a hardware summary, a folder path — so
  // the checks here are that each renders SOMETHING rather than the blank
  // an unanswered engine or a renamed field would leave. A blank where a
  // version belongs reads as a version of "".
  for (const [width, height] of [
    [1200, 800],
    [1920, 1080],
  ]) {
    await setSize(width, height);
    const about = await evalInApp(`
      await page.evaluate(() => {
        const rail = [...document.querySelectorAll("button")].find((b) =>
          /settings/i.test(b.getAttribute("aria-label") || b.textContent || ""));
        rail?.click();
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const tab = [...document.querySelectorAll(".settings-grid nav button")].find(
          (b) => (b.textContent || "").trim() === "About");
        tab?.click();
      });
      await page.waitForSelector(".about", { timeout: 10000 });
      return page.evaluate(() => {
        const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
        const values = [...document.querySelectorAll(".about-kv dd")].map((el) => el.textContent.trim());
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          cards: document.querySelectorAll(".about-card").length,
          versions: text(".about-versions"),
          chips: document.querySelectorAll(".about-card .spec-chip").length,
          values,
          actions: document.querySelectorAll(".about-actions button").length,
          links: document.querySelectorAll(".about-links a, .about-links button").length,
          // Every card inside its own column, and no control clipped by one.
          escaped: [...document.querySelectorAll(".about-card")].filter((card) => {
            const box = card.getBoundingClientRect();
            return [...card.querySelectorAll("button, a, dd")].some((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1);
            });
          }).length,
        };
      });
    `);
    const label = `${width}px About`;
    check(
      `${label}: the pane renders its four cards`,
      about.cards === 4 && about.actions === 4 && about.links === 4,
      JSON.stringify(about),
    );
    check(
      `${label}: adds no horizontal scroll`,
      about.scrollWidth <= about.innerWidth + 1,
      `scrollWidth ${about.scrollWidth} > innerWidth ${about.innerWidth}`,
    );
    check(
      `${label}: nothing overflows the card it is in`,
      about.escaped === 0,
      JSON.stringify(about),
    );
    // The facts, present rather than correct: what they SAY is pinned by
    // AboutPane.test.tsx against fixtures. What no unit test can see is a
    // real engine's answer arriving and landing nowhere.
    check(
      `${label}: the version line names this build`,
      /app\s+\d+\.\d+\.\d+/.test(about.versions),
      about.versions,
    );
    check(
      `${label}: every machine row has a value`,
      about.values.length === 4 && about.values.every((value) => value.length > 0),
      JSON.stringify(about.values),
    );
    if (about.chips === 0) {
      // Not a failure: the chips need /system, and a run against an engine
      // that never answered has nothing to draw. Said out loud so a green
      // walk cannot be read as "the hardware row was checked".
      console.log("NOTE About: no spec chips (the engine reported no system) - hardware unchecked");
    }
    await shoot(`about-${width}.png`);
  }
  // U6: Settings → Workflows. Two list shapes the rest of Settings has no
  // equivalent of — a pack row with a repo URL (long, unbreakable, and the
  // widest thing on the pane) beside a right-aligned button, and the grant
  // dialog, which carries the engine's code-execution warning as a
  // paragraph inside a modal that also holds a field and a checkbox.
  await setSize(1200, 800);
  const packs = await evalInApp(`
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".settings-grid nav button")].find(
        (b) => (b.textContent || "").trim() === "Workflows");
      tab?.click();
    });
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll(".pack-row")];
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        packs: rows.length,
        // The repo URL must wrap inside its row rather than push the row
        // wider than the pane that holds it.
        escaped: rows.filter((row) => {
          const box = row.getBoundingClientRect();
          return [...row.querySelectorAll("button, .pack-repo")].some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1);
          });
        }).length,
      };
    });
  `);
  // Zero packs is a legitimate catalog, and an engine that never answered
  // looks identical from here — so this reports rather than fails, and the
  // dialog check below is skipped rather than silently passed.
  if (packs.packs === 0) {
    console.log("NOTE Workflows: no node packs listed - the grant dialog went unchecked");
  }
  check(
    "1200px Workflows: adds no horizontal scroll",
    packs.scrollWidth <= packs.innerWidth + 1,
    JSON.stringify(packs),
  );
  check(
    "1200px Workflows: nothing overflows its pack row",
    packs.escaped === 0,
    JSON.stringify(packs),
  );
  await shoot("workflows-1200.png");

  if (packs.packs > 0) {
    const grant = await evalInApp(`
      await page.evaluate(() => {
        const enable = [...document.querySelectorAll(".pack-row button")].find(
          (b) => (b.textContent || "").trim() === "Enable");
        enable?.click();
      });
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      return page.evaluate(() => {
        // Addressed by its role rather than a class: every dialog in the
        // app is the one shell now, and only one is ever open at a time.
        // A per-dialog class would exist only to be selected here.
        const modal = document.querySelector('[role="dialog"]');
        const box = modal.getBoundingClientRect();
        const confirm = [...modal.querySelectorAll(".modal-foot button")].pop();
        return {
          warned: !!modal.querySelector(".banner.warning")?.textContent?.trim(),
          // The dangerous button starts unpressable, and stays that way
          // until a version is typed AND the box is ticked.
          confirmDisabled: confirm.disabled,
          checkbox: !!modal.querySelector('input[type="checkbox"]'),
          insideViewport: box.top >= 0 && box.bottom <= window.innerHeight + 1,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
    `);
    check(
      "1200px Workflows: the grant dialog warns, and cannot be confirmed unread",
      grant.warned && grant.confirmDisabled && grant.checkbox,
      JSON.stringify(grant),
    );
    check(
      "1200px Workflows: the grant dialog fits the window",
      grant.insideViewport && grant.scrollWidth <= grant.innerWidth + 1,
      JSON.stringify(grant),
    );
    await shoot("workflows-grant.png");
    await evalInApp(`await page.keyboard.press("Escape"); return null;`);
  }

  // Leave Settings so the walk's last screenshots show Home, as before.
  await evalInApp(`
    await page.evaluate(() => {
      const close = document.querySelector(".settings-head .icon-btn");
      close?.click();
    });
    return null;
  `);

  const report = await health();
  // A 409 is a refusal the product is designed to make and to explain — the
  // canvas stop deliberately opens projects until one works, and a state
  // file written by a build older than the store's encoding fix answers 409
  // by design. Chromium logs every failed response as a console error, so
  // that one status is filtered — but only among the errors the canvas stop
  // itself produced. Everything before it, 4xx of any other kind, every 5xx
  // and every app-level error still fail the walk.
  const noise = /Failed to load resource[^|]*409 \(Conflict\)|engine 409:/;
  // Same shape, same marker — the workspace first mounts inside the canvas
  // stop, and mounting it is what fires these. The peaks route answers 422
  // for an artifact that is not decodable audio, which is every narration
  // and music file the MOCK backend writes: JSON placeholders with a .wav
  // name. U5's audio lanes ask for peaks on every one of them. The lanes are
  // built to degrade on exactly that — `useArtifactPeaks` returns null and
  // the segment draws its empty variant — but Chromium logs the failed
  // response whatever the app does with it. Everything before the first
  // workspace, and every other status after it, still fails the walk.
  const peaksNoise = /Failed to load resource[^|]*422 \(Unprocessable/;
  const consoleErrors = report.consoleErrors.filter(
    (line, at) => !(at >= beforeCanvas && (noise.test(line) || peaksNoise.test(line))),
  );
  check(
    "no console errors during the walk",
    consoleErrors.length === 0 && report.pageErrors.length === 0,
    JSON.stringify([...consoleErrors, ...report.pageErrors].slice(0, 3)),
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
