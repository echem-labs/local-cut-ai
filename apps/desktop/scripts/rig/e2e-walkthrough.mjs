/**
 * End-to-end acceptance walk (plan doc 11). Grows with each phase; U0
 * scope: a fresh profile boots into first-run, Skip lands on Home with
 * the prompt focused (the FR1 bridge), Settings opens and closes, and
 * the session produces no console errors.
 *
 * Isolation is the whole point of this file's setup, and it takes three
 * variables, not one:
 *   LOCALCUT_USERDATA    a fresh Electron profile (dev-only override in
 *                        electron/main.ts) - first-run state, empty layout
 *   LOCALCUT_DATA_DIR    a fresh engine data dir (EngineConfig maps every
 *                        field to LOCALCUT_<FIELD>) - its own queue.db, so
 *                        two engines never write one database
 *   LOCALCUT_ENGINE_PORT off 7830 - the app RECLAIMS a busy engine port by
 *                        killing whatever holds it, which on the default
 *                        port is the engine the developer is using
 * Without the last two, "the real profile is never touched" was true of the
 * profile and false of everything the engine owns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evalInApp, health, makeCheck, shotsDir, startRig, stopRig } from "./rig.mjs";

const dir = shotsDir("e2e");
const check = makeCheck();
const profile = mkdtempSync(path.join(tmpdir(), "localcut-e2e-"));
const engineData = mkdtempSync(path.join(tmpdir(), "localcut-e2e-engine-"));

const rig = await startRig({
  LOCALCUT_USERDATA: profile,
  LOCALCUT_DATA_DIR: engineData,
  LOCALCUT_ENGINE_PORT: process.env.RIG_ENGINE_PORT || "7930",
  // The app spawns its engine with `local,mock`, so on a machine running
  // Ollama this walkthrough writes its script with a REAL model - and if
  // that model is not the one installed, generation fails, there is no
  // script to promote, and the run dies waiting for a workspace that is
  // never coming. Every step here is about the pipeline's shape rather
  // than what any model wrote. (sweep.mjs learned this first.)
  // Deferring to an exported value rather than overriding it, the way
  // rig.mjs's own default does: `startRig` merges this LAST, so a literal
  // would beat `LOCALCUT_BACKEND=local npm run rig:e2e` - and since rig:gate
  // is this walkthrough plus the walk, a literal here means the release gate
  // can never be pointed at the real generation chain at all.
  LOCALCUT_BACKEND: process.env.LOCALCUT_BACKEND || "mock",
});
try {
  const shoot = (name) =>
    evalInApp(`await page.screenshot({ path: ${JSON.stringify(path.join(dir, name))} }); return null;`);

  // 1. Fresh profile boots into the wizard's welcome step (U1).
  const setup = await evalInApp(`
    await page.waitForSelector('.setup.wizard', { timeout: 30000 });
    return page.evaluate(() => ({
      welcome: !!document.querySelector(".setup .wiz-body h1"),
      stepper: document.querySelectorAll(".stepper .step-label").length,
    }));
  `);
  check("fresh profile shows the wizard's welcome step", setup.welcome && setup.stepper === 4);
  await shoot("01-first-run.png");

  // 2. Walk forward and back: welcome -> machine -> models -> machine.
  // Button lookup is by accessible order within .setup-actions; the
  // PRIMARY is index 0 on every step, Skip is LAST (the wizard keeps the
  // e2e's positional contract).
  const walked = await evalInApp(`
    const primary = async () => (await page.$$(".setup-actions button"))[0].click();
    await primary(); // Get started -> machine
    await page.waitForSelector(".setup-machine", { timeout: 5000 });
    // Waited like the rail below, for the same reason: the chips render
    // from /system, and a cold engine can still be booting when the click
    // lands — the instant $() read absence where there was only lag.
    const machine = await page
      .waitForSelector(".spec-chips", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    await primary(); // Continue -> models (rail may need system+models)
    const rail = await page
      .waitForSelector(".pipe-rail", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    let filter = null;
    let back = false;
    if (rail) {
      // Second action on the rail opens the full library. Its fit filter is
      // the app's seg-toggle in its first BLOCK context, where a flex
      // container fills its parent unless told otherwise - so measure that
      // it wraps its two labels instead of ruling a line across the card.
      const railActions = await page.$$(".setup-actions button");
      await railActions[1].click();
      await page.waitForSelector(".filter-tabs", { timeout: 5000 });
      filter = await page.evaluate(() => {
        const tabs = document.querySelector(".filter-tabs");
        return {
          own: tabs.getBoundingClientRect().width,
          labels: [...tabs.querySelectorAll("button")].reduce(
            (sum, button) => sum + button.getBoundingClientRect().width,
            0,
          ),
          card: document.querySelector(".setup.wizard").getBoundingClientRect().width,
        };
      });
      const libActions = await page.$$(".setup-actions button");
      await libActions[1].click(); // back to the recommended rail
      await page.waitForSelector(".pipe-rail", { timeout: 5000 });
      const buttons = await page.$$(".setup-actions button");
      await buttons[buttons.length - 1].click(); // Back -> machine
      back = await page
        .waitForSelector(".setup-machine", { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }
    return { machine, rail, filter, back };
  `);
  check("machine step shows the hardware chips", walked.machine);
  check("models step shows the pipeline rail", walked.rail);
  check(
    "the library's fit filter hugs its labels, not the card",
    // 2px of container border, and a card an order of magnitude wider.
    walked.filter !== null &&
      walked.filter.own <= walked.filter.labels + 3 &&
      walked.filter.own < walked.filter.card - 40,
    JSON.stringify(walked.filter),
  );
  check("Back returns to the machine step", walked.back);
  await shoot("02-wizard-machine.png");

  // 3. Skip -> Home, prompt focused (review 4 FR1 bridge).
  const landed = await evalInApp(`
    const buttons = await page.$$(".setup-actions button");
    await buttons[buttons.length - 1].click();
    await page.waitForSelector(".home", { timeout: 15000 });
    await page.waitForTimeout(400);
    return page.evaluate(() => ({
      promptFocused: document.activeElement === document.querySelector(".prompt-box textarea"),
    }));
  `);
  check("skip lands on Home with the prompt focused", landed.promptFocused);
  await shoot("02-home.png");

  // 3b. The Library is a destination of its own (U2): the rail reaches it,
  // its filters split what this machine has made, and Home is one click
  // back. A screen the walk cannot reach is a screen nothing gates.
  const library = await evalInApp(`
    await page.evaluate(() => {
      const label = (button) =>
        (button.textContent || "") + " " + (button.getAttribute("aria-label") || "");
      const row = [...document.querySelectorAll(".rail button")].find((button) =>
        label(button).includes("Library"),
      );
      row?.click();
    });
    const shown = await page
      .waitForSelector(".library", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return { shown };
    const tabs = await page.$$(".library-bar .filter-tabs button");
    await tabs[2].click();
    await page.waitForTimeout(200);
    const filtered = await page.evaluate(() => ({
      tabs: document.querySelectorAll(".library-bar .filter-tabs button").length,
      searchable: !!document.querySelector(".library-search input"),
      sortable: !!document.querySelector(".sort-menu-wrap button"),
    }));
    await page.evaluate(() => {
      const label = (button) =>
        (button.textContent || "") + " " + (button.getAttribute("aria-label") || "");
      const row = [...document.querySelectorAll(".rail button")].find((button) =>
        label(button).includes("Home"),
      );
      row?.click();
    });
    const home = await page
      .waitForSelector(".home", { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    return { shown, ...filtered, home };
  `);
  check("the rail opens the Library", library.shown === true);
  check(
    "the Library filters, searches and sorts",
    library.tabs === 3 && library.searchable && library.sortable,
    JSON.stringify(library),
  );
  check("Home is one click back", library.home === true);
  await shoot("02b-library.png");

  // 3c. Run the Script tool for real (U3): panel opens with its preset
  // chips, a chip writes into the visible prompt, Generate lands on the
  // session page, and the session page carries the recipe card, the table
  // and the promote action. The engine behind this run is the rig's own,
  // so the render is the mock backend's and settles in seconds.
  const session = await evalInApp(`
    await page.evaluate(() => {
      const scriptTool = [...document.querySelectorAll(".quick-tools button")].find((button) =>
        (button.getAttribute("aria-label") || "").startsWith("Script"),
      );
      scriptTool?.click();
    });
    await page.waitForSelector(".tool-panel .chip-row", { timeout: 5000 });
    await page.type(".tool-panel textarea", "How Istanbul was captured");
    const chips = await page.$$(".tool-panel .chip-row .chip");
    await chips[1].click(); // Shorts — scaffolds the prompt, visibly
    const scaffolded = await page.evaluate(
      () => document.querySelector(".tool-panel textarea").value,
    );
    const buttons = await page.$$(".tool-panel .row button");
    await buttons[buttons.length - 1].click(); // Generate script
    await page.waitForSelector(".tool-shell", { timeout: 30000 });
    const table = await page
      .waitForSelector(".script-table", { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    const shape = await page.evaluate(() => ({
      // The run's inputs read from the status row (the chip-only recipe
      // card retired in the 2026-08-05 feedback round).
      statusChips: document.querySelectorAll(".tool-status .badge").length,
      composer: !!document.querySelector(".tool-composer.prompt-box"),
      promote: [...document.querySelectorAll(".tool-actions button")].some((button) =>
        button.textContent.includes("Turn into a video"),
      ),
    }));
    return { scaffolded, table, ...shape };
  `);
  check(
    "a script preset writes into the visible prompt",
    session.scaffolded.startsWith("How Istanbul was captured") &&
      session.scaffolded.length > "How Istanbul was captured".length,
    JSON.stringify(session.scaffolded),
  );
  check("the script session renders its table", session.table === true);
  check(
    "the session page carries the input chips, the composer and the promote action",
    session.statusChips >= 2 && session.composer && session.promote,
    JSON.stringify(session),
  );
  await shoot("02c-script-session.png");

  // 2d. Promote the script into a real project, then the flowchart and the
  // round trip Add node makes through /patch (U4). Promote is the bridge a
  // tool session already offers, and it is what gives this walk a full
  // pipeline graph without a second trip through Home.
  //
  // Everything from here on has a project workspace mounted, which is what
  // makes the peaks 422 below possible; nothing before it is excused.
  const beforeWorkspace = (await health()).consoleErrors.length;
  const canvas = await evalInApp(`
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".tool-actions button")].find((b) =>
        /turn into a video/i.test(b.textContent || ""));
      button?.click();
    });
    // Promote creates the project AND opens it (store.promote), so the
    // workspace is what to wait for.
    await page.waitForSelector(".dockview-theme-localcut", { timeout: 60000 });
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
    await page.waitForSelector(".canvas-stage", { timeout: 20000 });
    const before = await page.evaluate(() => document.querySelectorAll(".canvas-node").length);

    await page.evaluate(() => {
      document.querySelector('[aria-label="Add a node to the graph"]').click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
        /music/i.test(b.textContent || ""));
      item?.click();
    });
    // The graph is re-read from the engine after the patch; wait for the
    // node to appear there rather than for a timeout to expire.
    await page.waitForSelector('[data-node^="music-"]', { timeout: 20000 });
    // ...and then for it to be SELECTED, which is the other half of what
    // this step checks and lands later: the store selects on patchGraph
    // RESOLVING, while the node itself is painted by the graph refresh the
    // patch triggers - which can arrive first. Waiting only for the node
    // read the selection before it existed and failed roughly one run in
    // three. Swallowed on timeout so a real regression is still reported
    // by the check below, with its numbers, rather than as a hang here.
    await page
      .waitForSelector('.canvas-node.selected[data-node^="music-"]', { timeout: 5000 })
      .catch(() => {});

    // \`before\` is a Node-side value; page.evaluate runs in the renderer,
    // so it has to travel as an argument rather than a closure.
    return page.evaluate((before) => ({
      before,
      after: document.querySelectorAll(".canvas-node").length,
      selected: document.querySelector(".canvas-node.selected")?.dataset.node ?? null,
      zoom: document.querySelector(".canvas-zoom-value")?.textContent ?? null,
    }), before);
  `);
  check(
    "Add node reaches the engine and comes back in the graph",
    canvas.after === canvas.before + 1 && (canvas.selected || "").startsWith("music-"),
    JSON.stringify(canvas),
  );
  await shoot("02d-canvas-add-node.png");

  // 2e. The publish kit (U5). `POST /package` is the last project-level
  // engine verb the desktop had never called, and it is a real round trip
  // here: the mock backend implements the metadata task, so the two nodes
  // it adds to the graph actually render and come back through the queue.
  //
  // Driven from the palette rather than the export row, because the kit's
  // own surface waits for a finished export and this walk has no time to
  // render one — the round trip is what is being checked, not the gating.
  const publish = await evalInApp(`
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    // .cmdk, which is what the palette's root and input actually are.
    await page.waitForSelector(".cmdk input", { timeout: 5000 });
    await page.type(".cmdk input", "publish");
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.cmdk [role="option"]')].find((b) =>
        /prepare to publish/i.test(b.textContent || ""),
      );
      row?.click();
    });
    // Both nodes join the GRAPH, so the flowchart is where they show up.
    await page.waitForSelector('[data-node="metadata"]', { timeout: 30000 });
    return page.evaluate(() => ({
      metadata: !!document.querySelector('[data-node="metadata"]'),
      thumbnail: !!document.querySelector('[data-node="thumbnail"]'),
    }));
  `);
  check(
    "Prepare to publish adds both kit nodes to the graph",
    publish.metadata && publish.thumbnail,
    JSON.stringify(publish),
  );
  await shoot("02e-publish-kit.png");

  // Back to Home for the stops that follow.
  await evalInApp(`
    await page.evaluate(() => {
      const label = (button) =>
        (button.textContent || "") + " " + (button.getAttribute("aria-label") || "");
      const row = [...document.querySelectorAll(".rail button")].find((button) =>
        label(button).includes("Home"),
      );
      row?.click();
    });
    await page.waitForSelector(".home", { timeout: 5000 });
    return null;
  `);

  // 3. Settings overlay opens and closes without unmounting Home.
  const settings = await evalInApp(`
    const buttons = await page.$$("nav button");
    for (const b of buttons) { if ((await b.textContent()).includes("Settings")) { await b.click(); break; } }
    await page.waitForSelector(".settings-layer", { timeout: 5000 });
    const open = await page.evaluate(() => ({
      settings: !!document.querySelector(".settings-layer"),
      homeStillMounted: !!document.querySelector(".home"),
    }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !document.querySelector(".settings-layer"));
    return { ...open, closed };
  `);
  check("settings opens as an overlay above Home", settings.settings && settings.homeStillMounted);
  check("escape closes settings", settings.closed);
  await shoot("03-after-settings.png");

  // 3b. The two U6 panes, each against the live engine rather than a
  // fixture — About reads /system and /storage, Workflows reads
  // /comfy/node-packs. Both render something without either call, which is
  // exactly why a component test cannot stand in for this stop: the
  // failure being looked for is a real response landing nowhere.
  const panes = await evalInApp(`
    const buttons = await page.$$("nav button");
    for (const b of buttons) { if ((await b.textContent()).includes("Settings")) { await b.click(); break; } }
    await page.waitForSelector(".settings-layer", { timeout: 5000 });
    const open = async (label) => {
      await page.evaluate((name) => {
        const tab = [...document.querySelectorAll(".settings-grid nav button")].find(
          (b) => (b.textContent || "").trim() === name);
        tab?.click();
      }, label);
      await page.waitForTimeout(500);
    };
    await open("Workflows");
    const workflows = await page.evaluate(() => ({
      packs: document.querySelectorAll(".pack-row").length,
      importable: !!document.querySelector('input[type="file"]'),
    }));
    await open("About");
    await page.waitForSelector(".about", { timeout: 5000 });
    const about = await page.evaluate(() => ({
      versions: document.querySelector(".about-versions")?.textContent?.trim() ?? "",
      // The chips come from /system and the folder from /storage — two
      // different calls, so they fail independently.
      chips: document.querySelectorAll(".about-card .spec-chip").length,
      dataFolder: [...document.querySelectorAll(".about-kv dd")].pop()?.textContent?.trim() ?? "",
    }));
    await page.keyboard.press("Escape");
    return { workflows, about };
  `);
  check(
    "About names this build and the machine the engine reported",
    /app\s+\d+\.\d+\.\d+/.test(panes.about.versions) && panes.about.chips > 0,
    JSON.stringify(panes.about),
  );
  check(
    "About names the folder the engine measures its storage from",
    panes.about.dataFolder.length > 0 &&
      panes.about.dataFolder !== "-" &&
      !/does not report/.test(panes.about.dataFolder),
    panes.about.dataFolder,
  );
  check(
    "Workflows lists the engine's node-pack catalog and offers an import",
    panes.workflows.packs > 0 && panes.workflows.importable,
    JSON.stringify(panes.workflows),
  );
  await shoot("03b-settings-panes.png");

  const report = await health();
  // The peaks route answers 422 for an artifact that is not decodable audio,
  // which is every narration and music file the MOCK backend writes: JSON
  // placeholders with a .wav name. U5's audio lanes ask for peaks on each of
  // them the moment a timeline is on screen, and Chromium logs the failed
  // response however gracefully the app handles it (`useArtifactPeaks`
  // returns null; the segment draws empty). Scoped to after the first
  // workspace and to that one status — the walk filters the same thing the
  // same way, and every other status still fails here.
  const peaksNoise = /Failed to load resource[^|]*422 \(Unprocessable/;
  const consoleErrors = report.consoleErrors.filter(
    (line, at) => !(at >= beforeWorkspace && peaksNoise.test(line)),
  );
  check(
    "no console errors across the walkthrough",
    consoleErrors.length === 0 && report.pageErrors.length === 0,
    JSON.stringify([...consoleErrors, ...report.pageErrors].slice(0, 3)),
  );
} finally {
  await stopRig(rig);
  // Retries: on Windows the profile's LevelDB handles outlive the process
  // by a beat, and an EPERM thrown here would mask the real failure.
  const scrub = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  rmSync(profile, scrub);
  rmSync(engineData, scrub);
}

console.log(`shots: ${dir}`);
if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("e2e-walkthrough: all checks passed");
