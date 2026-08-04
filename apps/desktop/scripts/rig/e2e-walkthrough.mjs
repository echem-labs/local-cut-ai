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
    const machine = !!(await page.$(".spec-chips"));
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

  const report = await health();
  check(
    "no console errors across the walkthrough",
    report.consoleErrors.length === 0 && report.pageErrors.length === 0,
    JSON.stringify([...report.consoleErrors, ...report.pageErrors].slice(0, 3)),
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
