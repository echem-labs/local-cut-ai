/**
 * End-to-end acceptance walk (plan doc 11). Grows with each phase; U0
 * scope: a fresh profile boots into first-run, Skip lands on Home with
 * the prompt focused (the FR1 bridge), Settings opens and closes, and
 * the session produces no console errors.
 *
 * A fresh profile comes from LOCALCUT_USERDATA (dev-only override in
 * electron/main.ts) — the real profile is never touched. The engine the
 * app spawns still uses the shared engine data dir; this walk is
 * read-only toward it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evalInApp, health, makeCheck, shotsDir, startRig, stopRig } from "./rig.mjs";

const dir = shotsDir("e2e");
const check = makeCheck();
const profile = mkdtempSync(path.join(tmpdir(), "localcut-e2e-"));

const rig = await startRig({ LOCALCUT_USERDATA: profile });
try {
  const shoot = (name) =>
    evalInApp(`await page.screenshot({ path: ${JSON.stringify(path.join(dir, name))} }); return null;`);

  // 1. Fresh profile boots into first-run.
  await evalInApp("await page.waitForSelector('.setup', { timeout: 30000 }); return null;");
  check("fresh profile shows first-run", true);
  await shoot("01-first-run.png");

  // 2. Skip -> Home, prompt focused (review 4 FR1 bridge).
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
  rmSync(profile, { recursive: true, force: true });
}

console.log(`shots: ${dir}`);
if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("e2e-walkthrough: all checks passed");
