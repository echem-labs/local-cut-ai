/**
 * Dialog gate — every dialog against the instrument-panel spec, live.
 *
 * Design review v13 states the family in numbers: a well is `--inset-bg`
 * with a 1px border, 10px radius and 12/16/8 padding; a severity dot is 6px;
 * a key cap is 22px tall in the mono face; a price column is right-aligned
 * 12px secondary. A screenshot proves none of that — it proves what a JPEG
 * of it looked like. So this gate MEASURES: it opens each dialog in the real
 * app and reads `getComputedStyle` back out of the live DOM, then shoots the
 * frame for the record.
 *
 * True to scale, so a CSS pixel is a device pixel and the numbers below are
 * comparable to the spec at all (see startRigTrueToScale — this display
 * folds GNOME's text scale into the app's own zoom).
 *
 * Usage: node scripts/rig/dialogs.mjs [--shots <dir>]
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evalInApp, makeCheck, shotsDir, startRigTrueToScale, stopRig } from "./rig.mjs";

const shotsArg = process.argv.indexOf("--shots");
const dir = shotsArg >= 0 ? path.resolve(process.argv[shotsArg + 1]) : shotsDir("dialogs");
mkdirSync(dir, { recursive: true });

const check = makeCheck();

/** The design's own numbers. A mismatch here is a drawing and a build that
 *  disagree — which is the only thing this file is for. */
const SPEC = {
  well: { radius: "10px", padding: "12px 16px 8px", borderWidth: "1px" },
  wellCompact: { radius: "6px", padding: "8px 12px 4px" },
  dot: "6px",
  row: 28,
  rowWithControls: 40,
  cap: 22,
  chip: 22,
};

/** A solid-colour PNG, written here rather than read from disk.
 *
 * The photo viewer and the new-scene dialog both need a real picture to
 * open on, and this file used to point at one in whichever scratchpad the
 * author happened to be using — a run from anywhere else died on ENOENT
 * halfway through, after the checks above it had already passed. There is
 * no ImageMagick on the box either, so the bytes are assembled: IHDR,
 * one zlib-deflated scanline block, IEND.
 */
function samplePng(file, width, height, [red, green, blue]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // A filter byte per row, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
  return file;
}

const samplePhoto = samplePng(
  path.join(mkdtempSync(path.join(tmpdir(), "lc-dialogs-media-")), "sample-photo.png"),
  640,
  360,
  [178, 84, 30],
);

const shoot = (name) =>
  evalInApp(
    `await page.screenshot({ path: ${JSON.stringify(path.join(dir, name))} }); return null;`,
  );

/** Shoot just the dialog card, so the frame is the artefact rather than the
 *  window around it. Device pixels == CSS pixels here (true to scale), so
 *  the box needs no DPR correction. */
const shootDialog = (name, selector = ".modal") =>
  evalInApp(`
    // Park the pointer and the focus ring first. Both are real — a
    // dialog with no fields lands focus on its close button, and Tip
    // shows on :focus-visible — but a bubble hanging over the title is
    // the rig's fingerprint on the frame rather than the design's.
    await page.mouse.move(4, 4);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(250);
    const box = await page.$(${JSON.stringify(selector)});
    if (!box) return null;
    const clip = await box.boundingBox();
    await page.screenshot({
      path: ${JSON.stringify(path.join(dir, name))},
      clip: { x: clip.x - 12, y: clip.y - 12, width: clip.width + 24, height: clip.height + 24 },
    });
    return null;
  `);

// Its own everything: a profile (or a leftover home draft opens a quick
// tool instead of the video prompt), a data dir (never the real
// ~/.localcut), and a port — the app refuses to spawn an engine onto a
// port something else already holds, and a rig that inherits the ambient
// environment inherits whichever app the shell left running.
const child = await startRigTrueToScale({
  LOCALCUT_USERDATA: mkdtempSync(path.join(tmpdir(), "lc-dialogs-profile-")),
  LOCALCUT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "lc-dialogs-data-")),
  // A FRESH port per run, not a fixed one: the previous run's engine holds
  // its socket in TIME_WAIT for a minute or so, and the app refuses to
  // spawn onto a port anything still owns — which reads, from up here, as
  // every dialog having vanished at once.
  LOCALCUT_ENGINE_PORT: String(
    process.env.RIG_ENGINE_PORT || 7800 + (process.pid % 90),
  ),
});
try {
  // ---- 1. Past first-run, pinned to the theme the design is drawn in.
  const engineUp = await evalInApp(`
    await page.waitForSelector('.setup, .home', { timeout: 30000 });
    await page.evaluate(() => {
      localStorage.setItem("localcut.firstRunDone", "1");
      localStorage.setItem("localcut.theme", "dark");
      localStorage.setItem("localcut.rail.expanded", "1");
      localStorage.setItem(
        "localcut.defaults.v1",
        JSON.stringify({ aspect: "16:9", duration: 60, style: "cinematic", mode: "prompt", voice: "", videoModel: null }),
      );
    });
    await page.reload();
    await page.waitForSelector('.home', { timeout: 30000 });
    // The engine is what everything below needs; a rig that raced it reads
    // as a dozen missing dialogs.
    const up = await page.waitForFunction(
      () => !document.body.textContent.includes('not connected'),
      { timeout: 60000 },
    ).then(() => true).catch(() => false);
    await page.waitForTimeout(1500);
    return up;
  `);
  // Said once, loudly: without an engine every check below fails for the
  // same reason, and a wall of red hides which one it was.
  check("the engine is up", engineUp);
  if (!engineUp) throw new Error("engine never connected - is another app holding the port?");

  // ---- 2. The gate, where it actually fires: an all-mock chain serves
  // every kind with a stand-in, so the FIRST render click is guarded.
  const gate = await evalInApp(`
    await page.fill('.prompt-box textarea', 'a short film about snakes');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.prompt-box button')].find(
        (b) => (b.textContent || '').trim() === 'Generate',
      );
      button?.click();
    });
    const shown = await page
      .waitForSelector('[role="alertdialog"]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return null;
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const well = dialog.querySelector('.well');
      const style = getComputedStyle(well);
      const foot = dialog.querySelector('.modal-foot');
      const buttons = [...foot.querySelectorAll('button')];
      const row = dialog.querySelector('.prow');
      return {
        width: Math.round(dialog.getBoundingClientRect().width),
        radius: style.borderRadius,
        padding: style.padding,
        borderWidth: style.borderTopWidth,
        edge: style.borderLeftWidth,
        wellBg: style.backgroundColor,
        dot: getComputedStyle(dialog.querySelector('.pdot')).width,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        priceAlign: getComputedStyle(dialog.querySelector('.price')).textAlign,
        monoIntro: getComputedStyle(dialog.querySelector('.gate-intro .readout')).fontFamily,
        scopeHint: (dialog.querySelector('.scope-hint')?.textContent ?? '').length,
        primaryLast: /render anyway/i.test(buttons[buttons.length - 1].textContent || ''),
        gradient: getComputedStyle(buttons[buttons.length - 1]).backgroundImage.includes('gradient'),
        causeOnce:
          new Set([...dialog.querySelectorAll('.whead')].map((n) => n.textContent)).size ===
          dialog.querySelectorAll('.whead').length,
      };
    });
  `);
  if (gate) {
    check("gate: sits at the m width (520)", gate.width === 520);
    check(`gate: well radius ${SPEC.well.radius}`, gate.radius === SPEC.well.radius);
    check(`gate: well padding ${SPEC.well.padding}`, gate.padding === SPEC.well.padding);
    check("gate: well border is 1px", gate.borderWidth === SPEC.well.borderWidth);
    check("gate: well carries a 2px severity edge", gate.edge === "2px");
    check(`gate: severity dot is ${SPEC.dot}`, gate.dot === SPEC.dot);
    check(`gate: a status row is ${SPEC.row}px`, gate.rowHeight === SPEC.row);
    check("gate: the price column is right-aligned", gate.priceAlign === "right");
    check("gate: the count is a mono readout", /mono|consolas|cascadia/i.test(gate.monoIntro));
    check("gate: each cause is stated once", gate.causeOnce);
    check("gate: the scope hint is on screen, not in a tooltip", gate.scopeHint > 0);
    check("gate: the gradient is on Render anyway, and it is last", gate.primaryLast && gate.gradient);
    await shootDialog("01-readiness-gate.png");
  } else {
    check("gate: opens from the render click", false);
  }

  // The scope control hugs its three buttons on every choice. `.seg-toggle`
  // is `display: flex`, which is BLOCK-level, so inside a right-aligned
  // column it stretched to the width of the hint line underneath — and the
  // hint for "Always" is twice the length of the other two. The bordered
  // box grew a fourth, empty segment on that one choice.
  const scope = await evalInApp(`
    const dialog = await page.$('[role="alertdialog"]');
    if (!dialog) return null;
    const widths = {};
    for (const label of ['This session', 'This project', 'Always']) {
      await page.evaluate((want) => {
        const button = [...document.querySelectorAll('.gate-scope .seg-toggle button')].find(
          (b) => (b.textContent || '').trim() === want,
        );
        button?.click();
      }, label);
      await page.waitForTimeout(120);
      widths[label] = await page.evaluate(() => {
        const toggle = document.querySelector('.gate-scope .seg-toggle');
        const buttons = [...toggle.querySelectorAll('button')];
        return {
          toggle: Math.round(toggle.getBoundingClientRect().width),
          // The three buttons plus the box's own two borders is all the
          // width there is any reason for.
          content:
            Math.round(buttons.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0)) + 2,
          hint: (document.querySelector('.scope-hint')?.textContent ?? '').length,
        };
      });
    }
    return widths;
  `);
  if (scope) {
    const widths = Object.values(scope).map((entry) => entry.toggle);
    check(
      "gate: the scope toggle is the same width on every choice",
      new Set(widths).size === 1,
      JSON.stringify(scope),
    );
    check(
      "gate: and holds no segment its buttons do not fill",
      Object.values(scope).every((entry) => Math.abs(entry.toggle - entry.content) <= 1),
    );
    // The hints really do differ in length — otherwise the check above
    // passes on a build where the bug is simply unreachable.
    check(
      "gate: the choices carry hints of different lengths",
      new Set(Object.values(scope).map((entry) => entry.hint)).size > 1,
    );
  } else {
    check("gate: the scope control is measurable", false);
  }

  // ---- 3. Through it, into the project the gate was holding.
  const made = await evalInApp(`
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.modal-foot button')].find((b) =>
        /render anyway/i.test(b.textContent || ''),
      );
      button?.click();
    });
    const board = await page
      .waitForSelector('.dockview-theme-localcut', { timeout: 120000 })
      .then(() => true)
      .catch(() => false);
    // The mock renders fast; the readiness fetch is a round trip after it.
    await page.waitForTimeout(4000);
    return board;
  `);
  check("a project opens on the board", made);

  // ---- 4. The banner: the same GapList component, compacted, on the
  // board it sits above.
  const banner = await evalInApp(`
    const strip = await page.$('.banner.readiness');
    if (!strip) return null;
    return page.evaluate(() => {
      const strip = document.querySelector('.banner.readiness');
      const well = strip.querySelector('.well');
      const dot = strip.querySelector('.pdot');
      const row = strip.querySelector('.prow');
      const price = strip.querySelector('.price');
      const wellStyle = getComputedStyle(well);
      return {
        edge: getComputedStyle(strip).borderLeftWidth,
        wells: strip.querySelectorAll('.well').length,
        radius: wellStyle.borderRadius,
        padding: wellStyle.padding,
        dotSize: getComputedStyle(dot).width,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        priceAlign: getComputedStyle(price).textAlign,
        causeOnce:
          new Set([...strip.querySelectorAll('.whead')].map((n) => n.textContent)).size ===
          strip.querySelectorAll('.whead').length,
      };
    });
  `);
  if (banner) {
    check("banner: strip carries a 2px severity edge", banner.edge === "2px");
    check(`banner: wells compact to ${SPEC.wellCompact.padding}`, banner.padding === SPEC.wellCompact.padding);
    check("banner: compact well radius 6px", banner.radius === SPEC.wellCompact.radius);
    check("banner: severity dot is 6px", banner.dotSize === SPEC.dot);
    check("banner: each cause is stated once", banner.causeOnce);
    check("banner: price column is right-aligned", banner.priceAlign === "right");
    await shoot("01-banner-in-place.png");
    await shootDialog("02-banner.png", ".banner.readiness");

    // Folding is the answer to "can I close this?". What has to survive the
    // fold is the claim itself and the count — a strip that folded to
    // nothing would be a dismissal wearing a chevron.
    const folded = await evalInApp(`
      const open = await page.evaluate(
        () => Math.round(document.querySelector('.banner.readiness').getBoundingClientRect().height),
      );
      await page.click('.banner.readiness .row .icon-btn-sm');
      await page.waitForTimeout(200);
      return page.evaluate((open) => {
        const strip = document.querySelector('.banner.readiness');
        if (!strip) return null;
        const row = strip.querySelector('.row');
        return {
          open,
          title: (strip.querySelector('b')?.textContent ?? '').length,
          chips: strip.querySelectorAll('.sev-chip').length,
          rows: strip.querySelectorAll('.prow').length,
          height: Math.round(strip.getBoundingClientRect().height),
          // Nothing below the title row survives, which is the claim the
          // height alone cannot make on a board of any given size.
          rowHeight: Math.round(row.getBoundingClientRect().height),
          padding: getComputedStyle(strip).paddingTop,
        };
      }, open);
    `);
    if (folded) {
      check(
        "banner: folds to its title row and nothing else",
        folded.height === folded.rowHeight + 2 * parseInt(folded.padding, 10) + 2 &&
          folded.height < folded.open / 2,
        `open ${folded.open} -> ${folded.height} (row ${folded.rowHeight})`,
      );
      check("banner: and still says what it is about", folded.title > 0 && folded.chips > 0);
      check("banner: the detail is what goes", folded.rows === 0);
      await shootDialog("03-banner-folded.png", ".banner.readiness");
      await evalInApp(`
        await page.click('.banner.readiness .row .icon-btn-sm');
        await page.waitForTimeout(200);
        return null;
      `);
    } else {
      check("banner: folds", false);
    }
  } else {
    check("banner: present on a machine with gaps", false);
  }

  // ---- 4b. Removing a scene, the verb the board never had. Driven the way
  // a user reaches it: hover the card, press its trash, read the confirm.
  const removal = await evalInApp(`
    const card = await page.$('.scene-card');
    if (!card) return null;
    const before = await page.evaluate(() => document.querySelectorAll('.scene-card:not(.scene-add)').length);
    if (before < 2) return { before, skipped: true };
    await page.hover('.scene-card');
    const button = await page.$('.scene-card .act-remove');
    if (!button) return { before, missing: true };
    await button.click();
    const asked = await page
      .waitForSelector('[role="alertdialog"]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!asked) return { before, asked: false };
    const confirm = await page.evaluate(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const act = [...dialog.querySelectorAll('.modal-foot button')].pop();
      return {
        victim: dialog.querySelector('.confirm-victim')?.textContent ?? '',
        danger: getComputedStyle(act).backgroundColor,
        label: (act.textContent || '').trim(),
      };
    });
    return { before, asked: true, confirm };
  `);
  if (removal?.asked) {
    check("scene: the board can remove one", true);
    check("scene: the confirm shows which scene, and its words", /Scene \d/.test(removal.confirm.victim));
    check("scene: the act is a danger button", /rgb\(2[0-9][0-9]/.test(removal.confirm.danger));
    await shootDialog("13-confirm-remove-scene.png");
    const after = await evalInApp(`
      await page.evaluate(() => {
        const act = [...document.querySelectorAll('[role="alertdialog"] .modal-foot button')].pop();
        act?.click();
      });
      await page.waitForTimeout(2500);
      return page.evaluate(() => ({
        cards: document.querySelectorAll('.scene-card:not(.scene-add)').length,
        error: document.querySelector('.board-scroll .alert')?.textContent ?? '',
      }));
    `);
    check(
      "scene: and the board is one shorter, with nothing refused",
      after.cards === removal.before - 1 && after.error === "",
      `${removal.before} -> ${after.cards} ${after.error}`,
    );
  } else if (removal?.skipped) {
    check("scene: removal is reachable", true, "SKIPPED - a one-scene cut keeps its last scene");
  } else {
    check("scene: removal is reachable from the card", false, JSON.stringify(removal));
  }

  // ---- 4. Save points, its empty state, and the confirm it now asks.
  const save = await evalInApp(`
    // Behind the board's "Project options" menu, which has to be opened
    // before its items exist in the DOM at all.
    await page.click('[aria-label="Project options"]');
    await page.waitForSelector('.menu-pop [role="menuitem"]', { timeout: 5000 });
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.menu-pop [role="menuitem"]')].find((b) =>
        /save point/i.test(b.textContent || ''),
      );
      item?.click();
    });
    const shown = await page
      .waitForSelector('.savepoint-new', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return null;
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      return {
        emptyWell: !!dialog.querySelector('.well .well-empty'),
        footer: !!dialog.querySelector('.modal-foot'),
        primaryInBody: !!dialog.querySelector('.savepoint-new .btn-primary'),
      };
    });
  `);
  if (save) {
    check("save points: the empty state is a well, not a bare line", save.emptyWell);
    check("save points: no footer — Save lives beside its field", !save.footer && save.primaryInBody);
    await shootDialog("04-savepoints-empty.png");

    const listed = await evalInApp(`
      await page.fill('.savepoint-new input', 'before the music');
      await page.click('.savepoint-new .btn-primary');
      await page.waitForTimeout(800);
      return page.evaluate(() => {
        const row = document.querySelector('.vrow');
        if (!row) return null;
        const stamp = row.querySelector('.readout');
        return {
          height: Math.round(row.getBoundingClientRect().height),
          stamp: stamp?.textContent ?? '',
          mono: getComputedStyle(stamp).fontFamily,
        };
      });
    `);
    if (listed) {
      check(`save points: a row with controls is ${SPEC.rowWithControls}px`, listed.height >= SPEC.rowWithControls);
      check("save points: the timestamp is shown at all", listed.stamp.length > 0);
      check("save points: and set as a readout", /mono|consolas|cascadia/i.test(listed.mono));
      await shootDialog("05-savepoints.png");

      const confirm = await evalInApp(`
        await page.click('.sp-delete');
        const shown = await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 })
          .then(() => true).catch(() => false);
        if (!shown) return null;
        return page.evaluate(() => {
          const dialog = document.querySelector('[role="alertdialog"]');
          const victim = dialog.querySelector('.confirm-victim');
          return {
            victim: victim?.textContent ?? '',
            edge: victim ? getComputedStyle(victim).borderLeftWidth : '0px',
            danger: !!dialog.querySelector('.btn-danger'),
          };
        });
      `);
      if (confirm) {
        check("confirm: the victim is on screen as evidence", confirm.victim.includes("before the music"));
        check("confirm: and wears the red edge", confirm.edge === "2px");
        check("confirm: the act is a danger button", confirm.danger);
        await shootDialog("06-confirm-delete.png");
        await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(200); return null;`);
      } else {
        check("confirm: delete asks first", false);
      }
    }
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("save points: reachable from the board", false);
  }

  // ---- 5. Shortcuts and the glossary.
  const keys = await evalInApp(`
    await page.keyboard.press('?');
    const shown = await page.waitForSelector('.modal .kcaps', { timeout: 5000 }).then(() => true).catch(() => false);
    if (!shown) return null;
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      const cap = dialog.querySelector('.kcaps kbd');
      const combo = [...dialog.querySelectorAll('.prow')]
        .map((row) => [...row.querySelectorAll('kbd')].map((k) => k.textContent))
        .find((caps) => caps.length > 2);
      return {
        wells: dialog.querySelectorAll('.well').length,
        capHeight: Math.round(cap.getBoundingClientRect().height),
        capMono: getComputedStyle(cap).fontFamily,
        combo: combo ?? [],
        footer: !!dialog.querySelector('.modal-foot'),
      };
    });
  `);
  if (keys) {
    check("shortcuts: grouped into wells", keys.wells >= 3);
    check(`shortcuts: a key cap is ${SPEC.cap}px`, keys.capHeight === SPEC.cap);
    check("shortcuts: caps are mono", /mono|consolas|cascadia/i.test(keys.capMono));
    check("shortcuts: a combo is one cap per key", keys.combo.length >= 3);
    check("shortcuts: no footer — nothing here acts", !keys.footer);
    await shootDialog("07-shortcuts.png");
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("shortcuts: opens on ?", false);
  }

  const gloss = await evalInApp(`
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('localcut:open-glossary')));
    const shown = await page.waitForSelector('.gentry', { timeout: 5000 }).then(() => true).catch(() => false);
    if (!shown) return null;
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      const term = dialog.querySelector('.gentry dt');
      const def = dialog.querySelector('.gentry dd');
      const head = dialog.querySelector('.glossary-head');
      return {
        entries: dialog.querySelectorAll('.gentry').length,
        chipHeight: Math.round(term.getBoundingClientRect().height),
        chipTinted: getComputedStyle(term).backgroundColor,
        runIn: getComputedStyle(def).display,
        sticky: getComputedStyle(head).position,
        // The dialog's field recipe outranks a bare class; when it wins,
        // this padding collapses and the icon lands on the placeholder.
        searchPad: getComputedStyle(dialog.querySelector('.glossary-search')).paddingLeft,
        sameLine:
          Math.abs(term.getBoundingClientRect().top - def.getBoundingClientRect().top) < 8,
      };
    });
  `);
  if (gloss) {
    check("glossary: every term is listed", gloss.entries > 20);
    check(`glossary: the term chip is ${SPEC.chip}px`, gloss.chipHeight === SPEC.chip);
    check("glossary: the chip is accent-tinted", /rgba?\(124, 108, 248/.test(gloss.chipTinted));
    check("glossary: the definition runs in beside it", gloss.runIn === "inline" && gloss.sameLine);
    check("glossary: the search is sticky", gloss.sticky === "sticky");
    check("glossary: the search box leaves room for its icon", gloss.searchPad === "32px");
    await shootDialog("08-glossary.png");
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("glossary: opens from the help menu", false);
  }

  // ---- 6. The publish kit, which needs its two nodes rendered first.
  const publish = await evalInApp(`
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        /publish kit/i.test((b.textContent || '') + (b.getAttribute('aria-label') || '')),
      );
      button?.click();
    });
    const shown = await page.waitForSelector('.publish-hero', { timeout: 30000 }).then(() => true).catch(() => false);
    if (!shown) return null;
    await page.waitForTimeout(2000);
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      const hero = dialog.querySelector('.publish-hero');
      const thumb = dialog.querySelector('.publish-thumb');
      const body = dialog.querySelector('.modal-body');
      const foot = dialog.querySelector('.modal-foot');
      const buttons = [...foot.querySelectorAll('button')];
      const last = buttons[buttons.length - 1];
      return {
        heroFull:
          Math.abs(
            thumb.getBoundingClientRect().width -
              (body.clientWidth - 48),
          ) < 3,
        tray: !!dialog.querySelector('.hero-tray'),
        counters: dialog.querySelectorAll('.char-count').length,
        chips: dialog.querySelectorAll('.tag-chip').length,
        chipHeight: dialog.querySelector('.tag-chip')
          ? Math.round(dialog.querySelector('.tag-chip').getBoundingClientRect().height)
          : 0,
        // Chips and the entry share one row; a full-width entry (the field
        // recipe's default) puts every chip on a line of its own.
        chipsOnOneRow: (() => {
          const chips = [...dialog.querySelectorAll('.tag-chip')];
          if (chips.length < 2) return true;
          const first = chips[0].getBoundingClientRect().top;
          return chips.every((c) => Math.abs(c.getBoundingClientRect().top - first) < 2);
        })(),
        primaryIsCopy: /copy all/i.test(last.textContent || ''),
        // The errand is the text: if the first field is below the fold on
        // open, the hero has eaten the dialog.
        titleVisible: (() => {
          const field = dialog.querySelector('.publish-field input');
          if (!field) return false;
          const box = field.getBoundingClientRect();
          const view = body.getBoundingClientRect();
          return box.top >= view.top && box.bottom <= view.bottom + 1;
        })(),
        closeIsGhost: buttons.some(
          (b) => /close/i.test(b.textContent || '') && b.className.includes('btn-ghost'),
        ),
        // The copy control is an affix INSIDE the field's right edge (the
        // design's arrangement), not a button beside it stealing 30px of
        // every field's width. Measured as containment, which is what the
        // eye reads, plus the design's own 24px box and 4/5 offsets.
        affix: (() => {
          const row = dialog.querySelector('.publish-field .field-row');
          const input = row?.querySelector('input');
          const button = row?.querySelector('.icon-btn-sm');
          if (!input || !button) return null;
          const field = input.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          return {
            inside: box.right <= field.right + 1 && box.left >= field.left,
            size: Math.round(box.width),
            top: Math.round(box.top - field.top),
            right: Math.round(field.right - box.right),
            // And the field runs the body's full width again, like every
            // other field in the app.
            fieldFull: Math.abs(field.width - (body.clientWidth - 48)) < 3,
            // Text stops before the affix rather than running under it.
            padRight: getComputedStyle(input).paddingRight,
          };
        })(),
        // At rest a chip is the design's clean word; the remove appears on
        // approach. It stays in the tab order either way — the reveal is
        // width, not display, and :focus-within opens it for a keyboard.
        chipRestWidth: (() => {
          const remove = dialog.querySelector('.tag-remove');
          return remove ? Math.round(remove.getBoundingClientRect().width) : -1;
        })(),
        chipRemoveReachable: !!dialog.querySelector('.tag-remove'),
        // A chip's two runs sit on one line. The dialog field recipe used
        // to reach them - every span inside a field was styled as its
        // LABEL - which gave the chip 10px uppercase type and an 8px
        // bottom margin, and that margin lifted each hash mark exactly 4px
        // above its own word on the centred row.
        chipType: (() => {
          const chip = dialog.querySelector('.tag-chip');
          const hash = chip?.querySelector('.hash');
          const copy = chip?.querySelector('.tag-copy');
          if (!hash || !copy) return null;
          const range = document.createRange();
          range.selectNode(copy.childNodes[1]);
          const word = range.getBoundingClientRect();
          const style = getComputedStyle(chip);
          return {
            size: style.fontSize,
            transform: style.textTransform,
            margin: getComputedStyle(hash).marginBottom,
            drift: Math.round(Math.abs(hash.getBoundingClientRect().top - word.top)),
          };
        })(),
      };
    });
  `);
  if (publish) {
    if (publish.affix) {
      check("publish: the copy control sits inside the field", publish.affix.inside);
      check("publish: at the design's 24px", publish.affix.size === 24);
      check(
        "publish: inset 4 from the top and 5 from the right",
        publish.affix.top === 4 && publish.affix.right === 5,
        `top ${publish.affix.top} right ${publish.affix.right}`,
      );
      check("publish: so the field is full width again", publish.affix.fieldFull);
      check("publish: and the text stops before it", publish.affix.padRight === "34px");
    } else {
      check("publish: the copy affix is measurable", false);
    }
    check("publish: a chip is a clean word at rest", publish.chipRestWidth === 0);
    if (publish.chipType) {
      check(
        "publish: the # sits on the same line as its tag",
        publish.chipType.drift === 0,
        `${publish.chipType.drift}px apart, margin ${publish.chipType.margin}`,
      );
      check(
        "publish: and the chip is a tag, not a field label",
        publish.chipType.size === "12px" && publish.chipType.transform === "none",
        `${publish.chipType.size} ${publish.chipType.transform}`,
      );
    } else {
      check("publish: the chip's type is measurable", false);
    }
    check("publish: with its remove still in the DOM for a keyboard", publish.chipRemoveReachable);
    check("publish: the hero runs the body's full width", publish.heroFull);
    check("publish: the image carries its own copy/save tray", publish.tray);
    check("publish: title and description are counted", publish.counters === 2);
    check("publish: hashtags are chips", publish.chips > 0);
    check(`publish: a chip is ${SPEC.chip}px`, publish.chipHeight === SPEC.chip);
    check("publish: the chips share a row with the entry", publish.chipsOnOneRow);
    check("publish: the gradient is on Copy all, and Close is a ghost", publish.primaryIsCopy && publish.closeIsGhost);
    check("publish: the title field is on screen without scrolling", publish.titleVisible);
    await shootDialog("09-publish-kit.png");
    // The hashtag well on its own: the rig's window is short enough that
    // the chips sit below the fold in the frame above, and they are the
    // part of this dialog with the most to get wrong.
    await evalInApp(`
      await page.evaluate(() => document.querySelector('.publish-tags')?.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(250);
      return null;
    `);
    await shootDialog("09b-publish-hashtags.png", ".publish-tags");
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("publish: the kit opens and renders", false);
  }

  // ---- 7. The photo viewer, reached the way a user reaches it: a picture
  // attached to a scene, then opened from its thumbnail.
  const photo = await evalInApp(`
    await page.evaluate(() => {
      const card = document.querySelector('.scene-card');
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    const input = await page.$('#inspector-asset');
    if (!input) return null;
    await input.setInputFiles(${JSON.stringify(samplePhoto)});
    const thumb = await page
      .waitForSelector('.photo-thumb-open', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!thumb) return null;
    await page.click('.photo-thumb-open');
    const shown = await page.waitForSelector('.photo-stage', { timeout: 5000 })
      .then(() => true).catch(() => false);
    if (!shown) return null;
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      const stage = dialog.querySelector('.photo-stage');
      return {
        subtitle: dialog.querySelector('.modal-sub')?.textContent ?? '',
        ground: getComputedStyle(stage).backgroundColor,
        hasFooter: !!dialog.querySelector('.modal-foot'),
        gradient: [...dialog.querySelectorAll('.modal-foot button, .modal-foot a')].some((b) =>
          getComputedStyle(b).backgroundImage.includes('gradient'),
        ),
      };
    });
  `);
  if (photo) {
    check("photo: the dialog says what it is showing", /\d+×\d+/.test(photo.subtitle));
    check("photo: the exhibit sits on the darkest ground", photo.ground === "rgb(14, 15, 18)");
    check("photo: it finally has a way to keep the image", photo.hasFooter);
    check("photo: and no gradient — nothing here is the product's verb", !photo.gradient);
    await shootDialog("10-photo-viewer.png");
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("photo: opens from a scene's picture", false, "SKIPPED - no scene card or asset input");
  }

  // ---- 8. New scene from a dropped picture. Synthesised rather than
  // driven by a real pointer: Playwright cannot start an OS drag, but the
  // handler this dialog hangs off is an ordinary React `onDrop`.
  const scene = await evalInApp(`
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const dropped = await page.evaluate(async () => {
      const target =
        document.querySelector('.scene-board') ??
        document.querySelector('.board') ??
        document.querySelector('.dockview-theme-localcut');
      if (!target) return false;
      // A 1x1 PNG is enough: the dialog is about the fields, and the
      // preview reads whatever bytes it is handed.
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      );
      const file = new File([bytes], 'a-photograph.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      }
      return true;
    });
    if (!dropped) return null;
    const shown = await page
      .waitForSelector('.scene-runtime', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) return null;
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const dialog = document.querySelector('.modal');
      const readout = dialog.querySelector('.scene-runtime .readout');
      const foot = dialog.querySelector('.modal-foot');
      const primary = [...foot.querySelectorAll('button')].pop();
      return {
        emptyRate: readout?.textContent ?? '',
        mono: getComputedStyle(readout).fontFamily,
        note: foot.querySelector('.foot-note')?.textContent ?? '',
        disabled: primary?.disabled ?? false,
      };
    });
  `);
  if (scene) {
    check("new scene: the runtime line states the rate before anything is typed", /200 words/.test(scene.emptyRate));
    check("new scene: and it is a readout", /mono|consolas|cascadia/i.test(scene.mono));
    check("new scene: the footer says why Add is disabled", scene.disabled && scene.note.length > 0);
    await shootDialog("11-new-scene.png");

    const typed = await evalInApp(`
      await page.fill('.modal textarea', 'One two three four five six seven eight nine ten.');
      await page.waitForTimeout(300);
      return page.evaluate(() => document.querySelector('.scene-runtime .readout')?.textContent ?? '');
    `);
    check("new scene: typing turns it into a count", /10 words/.test(typed), typed);
    await shootDialog("12-new-scene-typed.png");
    await evalInApp(`await page.keyboard.press('Escape'); await page.waitForTimeout(300); return null;`);
  } else {
    check("new scene: opens from a dropped picture", false, "SKIPPED - no drop target");
  }
} finally {
  await stopRig(child);
}

const failed = check.failures();
console.log(`\nshots: ${dir}`);
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("every dialog matches the design spec");
