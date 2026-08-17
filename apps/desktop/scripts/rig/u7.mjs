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
import { evalInApp, health, makeCheck, startRig, stopRig } from "./rig.mjs";

const check = makeCheck();
const ENGINE_PORT = Number(process.env.LOCALCUT_ENGINE_PORT || 7830);
/** The words the engine leads with when it could not claim the port. The
 * third place this is written down - cli.py and electron/engine.ts are the
 * others - and `test_ui_contract.py` keeps all three in step, because a
 * reworded message would leave this gate silently counting nothing. */
const BIND_REFUSED = "cannot bind ";
/** What every engine line is filed under in the app log. Counted WITH the
 * prefix, because electron/engine.ts decides to retry on
 * `startsWith(LOG_PREFIX + BIND_REFUSED)` - a traceback quoting the phrase is
 * not a refused bind there, and must not be one here either, or a run that
 * never held a port at all reports refusals and then demands a recognition
 * that could not have happened. */
const LOG_PREFIX = "[engine] ";
/** How the app says it recognised one of those as a port winding down.
 * Written in electron/engine.ts as `PORT_HELD_BY_SOCKET` and matched here for
 * the same reason and with the same risk as the line above - so
 * `test_ui_contract.py` keeps this pair in step too. */
const PORT_HELD_BY_SOCKET = "is still held by a closed socket";
/** And how it says the holder turned out to be an orphan of ours instead.
 * Not contract-tested: this one only ever widens what counts as recognised,
 * so a rewording costs the gate nothing it was not already getting from the
 * line above. */
const STALE_ENGINE = "held by a stale engine";

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
    // -sTCP:LISTEN, or this returns the app as well as the engine. `lsof`
    // reports every process holding a socket on the port, and the app holds
    // one: it is the engine's client. Without the filter the SIGKILL below
    // takes the window with it, and the crash banner cannot be checked
    // because there is nothing left to check it in — "Target page, context
    // or browser has been closed", three checks after the kill. The Windows
    // branch above has always filtered for LISTENING; this one had not.
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
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

  // Pose an app that has been used before. Every behaviour below belongs to
  // the running app rather than to setup, and which of the two is showing is
  // a property of the PROFILE — the developer's own has been through first
  // run, a fresh one (CI, or `LOCALCUT_USERDATA` pointed somewhere new) has
  // not. Left to chance, the bar checks measure `.home` on one machine and
  // find nothing on the other.
  await evalInApp(`
    const setup = await page.$(".setup");
    if (setup) {
      await page.evaluate(() => localStorage.setItem("localcut.firstRunDone", "1"));
      await page.reload();
    }
    await page.waitForSelector(".home", { timeout: 30000 });
    return null;
  `);

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
      const rect = notice ? notice.getBoundingClientRect() : null;
      return {
        shown: notice !== null,
        position: notice ? getComputedStyle(notice).position : null,
        railX: Math.round(document.querySelector(".rail").getBoundingClientRect().x),
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        fromBottom: rect ? Math.round(window.innerHeight - rect.bottom) : null,
        width: rect ? Math.round(rect.width) : null,
        tone: notice ? notice.className : null,
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
  // Where it is, not just that it is out of flow. `bottom` and `max-width`
  // both read an undefined `--space-5`, and an undefined custom property
  // invalidates the WHOLE declaration — so the notice took `bottom: auto`
  // and `max-width: none` and sat across the top of the window, over the
  // project header. Both checks above stayed green throughout: it was still
  // `position: fixed` and it still moved nothing.
  check(
    "and puts it at the foot of the window, where it was aimed",
    (afterNotice?.fromBottom ?? -1) >= 0 && (afterNotice?.fromBottom ?? 999) <= 64,
    JSON.stringify({ fromBottom: afterNotice?.fromBottom }),
  );
  check(
    "at a width it was actually given",
    (afterNotice?.width ?? 0) > 0 && (afterNotice?.width ?? 9999) <= 560,
    JSON.stringify({ width: afterNotice?.width }),
  );
  check(
    "and coloured for the refusal it is",
    /\bwarning\b/.test(afterNotice?.tone ?? ""),
    JSON.stringify({ tone: afterNotice?.tone }),
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

  // The workspace has no narrower column, so the bar spans the content box.
  // That is a different code path from the two above: `.content.project-mode`
  // is a flex COLUMN, and an auto inline margin on a flex item absorbs the
  // free space in preference to `stretch` — the bar shrank to the width of
  // its own sentence and sat centred over a workspace it should have spanned.
  //
  // Posed by putting the class and a bar on the real container rather than by
  // opening a real project: by this point the engine is dead, and entering
  // the workspace needs one. What is under test is a rule about a flex
  // column and an auto margin, and the stylesheet and layout engine here are
  // the real ones — so this isolates the rule rather than approximating it.
  // It is NOT end-to-end: it would not notice `measure-full` being handed to
  // the wrong screen, which is what the two checks above cover for Home.
  const workspace = await evalInApp(`
    return page.evaluate(() => {
      const content = document.querySelector(".content");
      const bars = document.createElement("div");
      bars.className = "content-banners measure-full";
      bars.innerHTML = '<div class="banner error">The engine stopped unexpectedly.</div>';
      content.prepend(bars);
      const width = () => Math.round(bars.getBoundingClientRect().width);
      content.classList.add("project-mode");
      const posed = { bars: width(), content: Math.round(content.getBoundingClientRect().width) };
      const pad = getComputedStyle(content).paddingLeft;
      content.classList.remove("project-mode");
      bars.remove();
      return { ...posed, pad: Math.round(parseFloat(pad)) };
    });
  `);
  check(
    "and spans the workspace, which has no column to match",
    workspace !== null &&
      Math.abs(workspace.bars - (workspace.content - 2 * workspace.pad)) <= 2,
    JSON.stringify({ workspace }),
  );

  // And the way back actually works — the whole claim of "crash-safe".
  //
  // The budget is minutes, not seconds, and that is the finding rather than a
  // slow test. The engine we just SIGKILLed had this app's WebSocket open, so
  // its accepted sockets sit in TIME_WAIT holding the port for 61s (measured;
  // TCP_TIMEWAIT_LEN is compiled into Linux), and `serve` does not set
  // SO_REUSEADDR. The restart cannot bind until the kernel lets go — so what
  // is under test is that the app OUTLASTS that rather than failing at the
  // first attempt, which is what it used to do. Timed from the click, which
  // is already a few seconds into the window.
  const clickedAt = Date.now();
  const recovered = await evalInApp(`
    await page.evaluate(() => {
      const el = document.querySelector(".engine-crash");
      [...el.querySelectorAll("button")][0]?.click();
    });
    return page
      .waitForFunction(
        () => document.querySelector(".engine-crash") === null,
        // The arg slot, not the options. waitForFunction takes (fn, arg,
        // options), so the timeout this check has carried since it was
        // written was silently the 30s default - which is shorter than the
        // wait it is here to measure, and is what made a working restart
        // read as a broken one.
        null,
        { timeout: 180000 },
      )
      .then(() => true)
      .catch(() => false);
  `);
  const took = Math.round((Date.now() - clickedAt) / 1000);
  check(
    "and restarting from the banner brings the engine back",
    recovered === true,
    `${took}s after the click`,
  );
  // Whether the kernel actually made this app wait is not ours to decide —
  // TIME_WAIT only forms if the dying engine's sockets closed with a FIN
  // rather than a RST, which depends on what was in flight when it was
  // killed. So the wait itself is reported rather than required, and what is
  // asserted instead is that every refused bind on the way was outlived: the
  // app saw it for what it was and said so, rather than surfacing it to the
  // user as a failed restart. That is the half a reworded message breaks —
  // the count alone would just quietly fall to zero and still read green.
  const log = (await health()).mainLog ?? [];
  const refused = log.filter((line) => line.includes(LOG_PREFIX + BIND_REFUSED)).length;
  // Either way the app has of RECOGNISING one, not just the wait: a refused
  // bind whose holder turns out to be an orphan of ours is answered by
  // reclaiming the port instead, and a run that recovers that way logs no
  // wait at all - so asking only about the wait fails the gate against an app
  // that did exactly the right thing.
  const handled = log.some(
    (line) => line.includes(PORT_HELD_BY_SOCKET) || line.includes(STALE_ENGINE),
  );
  // Not `&& recovered` as well: the check above already owns that, and folding
  // it in here means one failed restart prints two FAIL lines - the second
  // under a detail string that cannot explain the term that caused it.
  check(
    "and every refused bind on the way was outlived rather than reported",
    refused === 0 || handled,
    `${refused} refused bind(s), ${handled ? "recognised" : "NOT recognised"} as one the app handles`,
  );
  console.log(`  note ${took}s to recover, over ${refused} refused bind(s)`);
} finally {
  await stopRig(rig);
}

if (check.failures() > 0) {
  console.error(`${check.failures()} check(s) failed`);
  process.exit(1);
}
console.log("u7: all checks passed");
