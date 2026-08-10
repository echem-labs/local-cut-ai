/**
 * Phase U7's shell behaviours, in a running app (plan doc 11, U7).
 *
 * These four each cross a boundary the unit suites cannot: the real preload,
 * the real IPC, the real engine process. `main.test.ts` proves the handler
 * shows a notification and clears a progress bar against a stubbed Electron;
 * it cannot prove the renderer ever calls it, that the preload exposes what
 * the store expects, or that a genuinely dead engine reaches the banner.
 *
 * The engine kill is the one worth the whole script. It is also the only
 * check here that would have caught the bug U7 opened with: `taskkill /T /F`
 * exits 1, which is exactly what a clean quit produced, so "the app noticed
 * the engine died" and "the app noticed the user closed it" were the same
 * observation until they were told apart.
 *
 * Usage: node u7.mjs
 */
import { execFileSync } from "node:child_process";
import { evalInApp, makeCheck, startRig, stopRig } from "./rig.mjs";

const check = makeCheck();
const ENGINE_PORT = Number(process.env.LOCALCUT_ENGINE_PORT || 7830);

/** PIDs listening on a port, without assuming which tool exists. */
function listenersOn(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
      });
      return [
        ...new Set(
          out
            .split("\n")
            .filter(
              (line) =>
                line.includes(`:${port} `) && line.includes("LISTENING"),
            )
            .map((line) => line.trim().split(/\s+/).at(-1))
            .filter((pid) => pid && pid !== "0"),
        ),
      ];
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Kill the engine the way a crash would: no warning, no clean shutdown. */
function killEngine(port) {
  const pids = listenersOn(port);
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(Number(pid), "SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}

/** Dispatch a drag/drop event carrying files, as the browser delivers one. */
const dispatchDrop = (name, files) => `
  await page.evaluate(({ name, files }) => {
    const made = files.map((f) => new File(["rig"], f.name, { type: f.type }));
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        files: name === "drop" ? made : [],
        items: made.map((f) => ({ type: f.type })),
        types: ["Files"],
      },
    });
    window.dispatchEvent(event);
  }, ${JSON.stringify({ name, files })});
  await page.waitForTimeout(150);
  return null;
`;

// The seed hook poses a render in flight without waiting on a real one.
// Gated at preload time, so it has to be in the environment at launch.
const rig = await startRig({ LOCALCUT_SEED_HOOK: "1" });
try {
  await evalInApp(
    "await page.waitForSelector('.home, .setup', { timeout: 30000 }); return null;",
  );

  /* ---------------------------------------------------------- drop -- */

  await evalInApp(
    dispatchDrop("dragenter", [{ name: "shot.png", type: "image/png" }]),
  );
  const overlay = await evalInApp(`
    return page.evaluate(() => {
      const el = document.querySelector(".drop-overlay");
      return el ? el.textContent.trim() : null;
    });
  `);
  check(
    "a dragged image raises the drop overlay",
    overlay !== null,
    JSON.stringify({ overlay }),
  );

  await evalInApp(
    dispatchDrop("dragleave", [{ name: "shot.png", type: "image/png" }]),
  );
  const cleared = await evalInApp(
    `return page.evaluate(() => document.querySelector(".drop-overlay") === null);`,
  );
  check("the overlay goes away when the drag leaves", cleared === true);

  // A voice sample must not be uploadable by dropping it: the dialog is the
  // consent, and `graph/patch.py` refuses a voice_ref without one.
  await evalInApp(
    dispatchDrop("drop", [{ name: "me.wav", type: "audio/wav" }]),
  );
  const consent = await evalInApp(`
    return page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const confirm = [...dialog.querySelectorAll("button")].find((b) =>
        /use this sample/i.test(b.textContent || ""),
      );
      return { open: true, confirmDisabled: confirm ? confirm.disabled : null };
    });
  `);
  check(
    "a dropped audio file asks for consent first",
    consent?.open === true,
    JSON.stringify({ consent }),
  );
  check(
    "and cannot be confirmed unticked",
    consent?.confirmDisabled === true,
    JSON.stringify({ consent }),
  );

  await evalInApp(`
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      [...dialog.querySelectorAll("button")]
        .find((b) => /cancel/i.test(b.textContent || ""))?.click();
    });
    await page.waitForTimeout(150);
    return null;
  `);

  // What the drop SAYS afterwards has to stay out of the flow. `.app` is a
  // flex row whose children are the rail and the content, and this surface
  // is mounted alongside them — so a static banner became a third column
  // the full height of the window and shoved the whole app sideways. jsdom
  // cannot see this: the unit suite renders the component with no `.app`
  // around it and therefore no layout to disturb.
  const railBefore = await evalInApp(
    `return page.evaluate(() => Math.round(document.querySelector(".rail").getBoundingClientRect().x));`,
  );
  await evalInApp(
    dispatchDrop("drop", [{ name: "notes.pdf", type: "application/pdf" }]),
  );
  const afterNotice = await evalInApp(`
    return page.evaluate(() => {
      const notice = document.querySelector(".drop-notice");
      return {
        shown: notice !== null,
        position: notice ? getComputedStyle(notice).position : null,
        railX: Math.round(document.querySelector(".rail").getBoundingClientRect().x),
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
  `);
  check(
    "a refused file says so",
    afterNotice?.shown === true,
    JSON.stringify({ afterNotice }),
  );
  check(
    "and says it without moving the app",
    afterNotice?.railX === railBefore,
    JSON.stringify({ railBefore, railX: afterNotice?.railX }),
  );
  check(
    "nor pushing the document wider than the window",
    (afterNotice?.docScrollWidth ?? 0) <= (afterNotice?.innerWidth ?? 0),
    JSON.stringify({ afterNotice }),
  );

  /* ------------------------------------------------ shell progress -- */

  // The window title is main's, not the document's, so it has to be read
  // from the main process — which is also the point: this is the one check
  // that proves the renderer's derivation actually reaches Electron.
  await evalInApp(`
    await page.evaluate(() => {
      window.__localcutSeed({
        projects: [{ id: "p-rig", title: "A film about bees", mode: "prompt" }],
        board: { scenes: [{ clip: { status: "final" } }, { clip: { status: "rendering" } }], aux: {} },
        jobs: [{ id: "j1", project_id: "p-rig", status: "rendering", progress: 0.5,
                 created_at: 1, spec: { node_id: "clip", kind: "clip" } }],
        allJobs: [{ id: "j1", project_id: "p-rig", status: "rendering", progress: 0.5,
                    created_at: 1, spec: { node_id: "clip", kind: "clip" } }],
      });
    });
    await page.waitForTimeout(400);
    return null;
  `);
  const rendering = await evalInApp(`
    return app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { title: win.getTitle() };
    });
  `);
  check(
    "a running render reaches the window title",
    /Rendering\s+1\/2/.test(rendering?.title ?? ""),
    JSON.stringify({ title: rendering?.title }),
  );

  // And an idle app gets its name back rather than keeping a stale claim.
  await evalInApp(`
    await page.evaluate(() => {
      window.__localcutSeed({ jobs: [], allJobs: [] });
    });
    await page.waitForTimeout(400);
    return null;
  `);
  const idle = await evalInApp(`
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  `);
  check(
    "and an idle app goes back to its own name",
    idle === "LocalCut AI",
    JSON.stringify({ idle }),
  );

  /* ------------------------------------------------------- dialogs -- */

  // A dialog must not inherit the context of whatever opened it. The rail's
  // Help menu renders its dialog beside the ? button, which put the dialog
  // inside `.rail` — where `.rail .tip-wrap { width: 100% }` reached the
  // close button's tooltip wrapper and stretched the ✕ across the header.
  // The title, its flex sibling, was squeezed to 0px and rendered one
  // letter per line down the side of the dialog.
  //
  // Only a browser can see this: jsdom computes no layout, so every unit
  // test on `Modal` passed throughout. The assertion is on the geometry
  // rather than on the portal, because the portal is one way to be
  // independent of the ancestor and the geometry is what independence is
  // FOR — a rail rule invented tomorrow fails this the same way.
  const dialog = await evalInApp(`
    await page.evaluate(() => window.dispatchEvent(new Event("localcut:open-shortcuts")));
    await page.waitForSelector(".modal", { timeout: 5000 });
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const h2 = document.querySelector(".modal h2");
      const close = document.querySelector(".modal-close");
      const head = document.querySelector(".modal-head");
      return {
        title: Math.round(h2.getBoundingClientRect().width),
        titleHeight: Math.round(h2.getBoundingClientRect().height),
        close: Math.round(close.getBoundingClientRect().width),
        closeHeight: Math.round(close.getBoundingClientRect().height),
        head: Math.round(head.getBoundingClientRect().width),
        insideRail: !!close.closest(".rail"),
      };
    });
  `);
  check(
    "a dialog opened from the rail keeps its title on one line",
    (dialog?.title ?? 0) > (dialog?.head ?? 0) / 2 && (dialog?.titleHeight ?? 0) < 60,
    JSON.stringify({ dialog }),
  );
  check(
    "and its close button stays the square it is drawn as",
    Math.abs((dialog?.close ?? 0) - (dialog?.closeHeight ?? 0)) <= 2,
    JSON.stringify({ dialog }),
  );

  await evalInApp(`
    await page.evaluate(() => document.querySelector(".modal-close")?.click());
    await page.waitForTimeout(200);
    return null;
  `);

  /* ------------------------------------------------- engine crash -- */

  const killed = killEngine(ENGINE_PORT);
  check(
    `the engine was found and killed on ${ENGINE_PORT}`,
    killed > 0,
    JSON.stringify({ killed }),
  );

  const banner = await evalInApp(`
    const found = await page
      .waitForSelector(".engine-crash", { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    return page.evaluate((found) => {
      const el = document.querySelector(".engine-crash");
      if (!el) return { found, text: null };
      return {
        found,
        role: el.getAttribute("role"),
        buttons: [...el.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
      };
    }, found);
  `);
  check(
    "a killed engine raises the crash banner",
    banner?.found === true,
    JSON.stringify({ banner }),
  );
  check(
    "announced as an alert, not quietly",
    banner?.role === "alert",
    JSON.stringify({ banner }),
  );
  check(
    "carrying both a way back and a report",
    (banner?.buttons ?? []).length >= 2,
    JSON.stringify({ buttons: banner?.buttons }),
  );

  // The bar sits above the screen rather than inside it, so nothing tells it
  // how wide that screen's column is: left alone it spanned the window while
  // Home's column sat centred and far narrower, and it read as window chrome
  // rather than as this page speaking. Measured against the column itself,
  // not against a number, so the check survives a change to either token.
  const measured = await evalInApp(`
    return page.evaluate(() => {
      const bars = document.querySelector(".content-banners");
      const column = document.querySelector(".home > *");
      if (!bars || !column) return null;
      const b = bars.getBoundingClientRect();
      const c = column.getBoundingClientRect();
      return {
        barsWidth: Math.round(b.width),
        columnWidth: Math.round(c.width),
        barsLeft: Math.round(b.x),
        columnLeft: Math.round(c.x),
        gapBelow: Math.round(c.y - b.bottom),
      };
    });
  `);
  check(
    "the crash bar takes the width of the screen under it",
    measured !== null &&
      Math.abs(measured.barsWidth - measured.columnWidth) <= 2 &&
      Math.abs(measured.barsLeft - measured.columnLeft) <= 2,
    JSON.stringify({ measured }),
  );
  check(
    "and leaves air between itself and the heading it interrupts",
    (measured?.gapBelow ?? 0) >= 20,
    JSON.stringify({ measured }),
  );

  // And the way back actually works — the whole claim of "crash-safe".
  const recovered = await evalInApp(`
    await page.evaluate(() => {
      const el = document.querySelector(".engine-crash");
      [...el.querySelectorAll("button")][0]?.click();
    });
    return page
      .waitForFunction(() => document.querySelector(".engine-crash") === null, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
  `);
  check(
    "and restarting from the banner brings the engine back",
    recovered === true,
  );
} finally {
  await stopRig(rig);
}

if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("u7: all checks passed");
