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
      placeholder: true,
    });
  }
  return out;
})()`;

module.exports = { COLLECT };
