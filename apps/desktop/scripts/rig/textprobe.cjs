/**
 * The convergence probe: where does the TEXT sit?
 *
 * A pixel gate answers "how many pixels differ", which is the right question
 * for a gate and the wrong one for fixing it — 23640 is not something anyone
 * can act on. Converging a frame needs the difference stated as elements:
 * this label is 7px right of where the mock puts it, that row is 3px out.
 *
 * Matching mock elements to app elements by SELECTOR does not work here: the
 * mocks were written by hand and share almost no class names with the
 * implementation (the mock's `.tool .well` is the app's
 * `.quick-tools .tool-well`). Every existing map between them was written by
 * hand, one selector at a time.
 *
 * So match on the text itself. It is the same string on both sides — that is
 * what makes it comparable at all — and text is precisely where the residual
 * lives. Elements carrying no text of their own are not measured here; the
 * pixel diff still owns those.
 *
 * The same function runs in both renderers, so a difference in the readings
 * can only come from the pages.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Collect every element that owns visible text, with the box it occupies.
 *  Returned as a string to be eval'd in either page. */
const COLLECT = `(() => {
  /* Direct text only: an ancestor repeats every descendant's words, so
     measuring both would match a label against the card that contains it. */
  const nodes = (el) => [...el.childNodes].filter((node) => node.nodeType === 3);
  const own = (el) =>
    nodes(el)
      .map((node) => node.textContent)
      .join("")
      .replace(/\\s+/g, " ")
      .trim();

  /* The INK, not the element. The two sides wrap their text differently —
     the mock's rail label is a text node inside the button, the app's is a
     span inside it — so element boxes compare a button against a span and
     report a 32px "shift" that is really a difference in markup. A Range
     over the text nodes measures the glyphs themselves, which is the thing
     that has to land in the same place. */
  const inkBox = (el) => {
    const range = document.createRange();
    let box = null;
    for (const node of nodes(el)) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      box = box
        ? {
            left: Math.min(box.left, r.left),
            top: Math.min(box.top, r.top),
            right: Math.max(box.right, r.right),
            bottom: Math.max(box.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return box && { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top };
  };

  /* The box the text sits IN, found without a selector map.
     Ink positions say a row moved; they cannot say which box changed height
     to move it. Walk up to the nearest ancestor that is drawn — one with a
     border or a background of its own — and report that too. It is the
     button, chip or card the label belongs to, on both sides, without
     either having to name it. */
  const controlBox = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const bordered = parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
      /* backgroundImage too: the CTA on both sides is a gradient, and a
         gradient leaves backgroundColor transparent — so a colour-only test
         walks straight past the button and reports the row around it. */
      const filled =
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
        (style.backgroundImage && style.backgroundImage !== "none");
      if (!bordered && !filled) continue;
      const r = node.getBoundingClientRect();
      if (r.height < 1) continue;
      return { boxY: Math.round(r.top), boxH: Math.round(r.height), boxX: Math.round(r.left), boxW: Math.round(r.width) };
    }
    return null;
  };

  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const text = own(el);
    if (!text) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    const r = inkBox(el);
    if (!r || r.width < 1 || r.height < 1) continue;
    out.push({
      text,
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      size: style.fontSize,
      weight: style.fontWeight,
      spacing: style.letterSpacing,
      family: style.fontFamily.split(",")[0].replace(/['"]/g, ""),
      ...(controlBox(el) ?? {}),
    });
  }
  /* A placeholder is text the user sees and no text node holds — there is
     nothing to put a Range around. Inset by the padding instead, which is
     where the first glyph starts: the mocks draw their prompt as a DIV with
     the same padding, so this compares ink against ink. Taking the element
     box would report the app's 16px of padding as a 16px shift. */
  for (const el of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    const style = getComputedStyle(el);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    out.push({
      text: el.placeholder.replace(/\\s+/g, " ").trim(),
      x: Math.round(r.left + padLeft),
      y: Math.round(r.top + padTop),
      width: Math.round(r.width - padLeft - padRight),
      height: Math.round(r.height),
      size: style.fontSize,
      weight: style.fontWeight,
      spacing: style.letterSpacing,
      family: style.fontFamily.split(",")[0].replace(/['"]/g, ""),
      ...(controlBox(el) ?? {}),
      placeholder: true,
    });
  }
  return out;
})()`;

/**
 * Write one frame's probe beside its screenshot, if RIG_PROBE asked for it.
 *
 * A no-op otherwise, and deliberately: the gate's own answer is the pixel
 * count, and the probe costs a page evaluation per frame for a file only
 * `converge.mjs` reads. Every gate calls this, so a frame that goes red is
 * one env var away from saying which element moved — the session set spent
 * a run failing five frames with no probe to read.
 */
async function writeProbe(dir, name, evalInApp) {
  if (!process.env.RIG_PROBE) return;
  const rows = await evalInApp(
    `return page.evaluate(${JSON.stringify(COLLECT)});`,
  );
  fs.writeFileSync(
    path.join(dir, `${name}.text.json`),
    JSON.stringify(rows, null, 1),
  );
}

module.exports = { COLLECT, writeProbe };
