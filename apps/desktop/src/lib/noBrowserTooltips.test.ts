/**
 * The app's bubble, not the browser's.
 *
 * `title` is the thing `<Tip>` replaced: it waits about a second, it never
 * appears for a keyboard user, it draws in the OS's style rather than the
 * app's — and Chromium delivers no pointer events at all to a DISABLED
 * control, so the tooltips that most needed to be read (the ones explaining
 * why a button cannot be pressed) were the ones that never appeared.
 *
 * `Settings.tips.test.tsx` asserts this for the settings dialog by rendering
 * it. That cannot scale to the whole app: most of these live on surfaces that
 * need a project, a board and a canvas to mount. So this reads the source
 * instead, and keeps a named allowlist — the point is not that the number is
 * small but that every survivor has a reason somebody wrote down.
 *
 * Told apart from the React prop of the same name: `title=` on a
 * <Component> is a prop (`Modal`, `ConfirmDialog`), on a lowercase tag it is
 * the HTML attribute. The scan walks back from each match to the tag that
 * opens it — with `=>` blanked first, or an arrow function in a preceding
 * prop reads as the end of the previous tag and hides everything after it.
 */
import { describe, expect, it } from "vitest";

/**
 * The sources, read through Vite rather than `node:fs`: the renderer project
 * is typed against `vite/client` alone and has no node types, and reaching
 * for them here would mean either a second tsconfig or `any`.
 */
const SOURCES: Record<string, string> = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Where the browser's tooltip is still the right answer, and why.
 *
 * Two reasons appear here, both real:
 *
 * - **A paragraph.** `.tip` is `white-space: nowrap`, so it cannot wrap. A
 *   tool project is titled by its own prompt and ellipsizes in the header;
 *   revealing that needs something that wraps.
 * - **A text field.** `Tip` shows on `:focus-visible`, and Chromium matches
 *   `:focus-visible` on a text input however it was focused — so the bubble
 *   would sit over the surface for as long as someone is typing into the
 *   field it describes.
 * - **A sized layout box.** These are not controls with a hit area but
 *   regions whose inline `width` is load-bearing (and, for the ruler, a drag
 *   surface). A wrapper would take over what the parent lays out.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "screens/Project.tsx": {
    count: 2,
    why: "a tool project's title is a paragraph, and .tip cannot wrap",
  },
  "components/TimelineStrip.tsx": {
    count: 2,
    why: "the timecode field is a text input; the ruler is a sized drag surface",
  },
  "components/NodeCanvas.tsx": { count: 1, why: "the canvas search field is a text input" },
  "components/AudioLanes.tsx": {
    count: 2,
    why: "both are width-driven lane containers, not controls",
  },
};

/** Every component source, keyed as it reads in the allowlist. */
const components = (): [string, string][] =>
  Object.entries(SOURCES)
    .filter(([file]) => !file.endsWith(".test.tsx"))
    .map(([file, source]) => [file.replace(/^\.\.\//, ""), source]);

/**
 * Where the tag opening at `open` closes, or -1 if it never does.
 *
 * The `>` that ends a tag is the one at brace depth zero *counted from this
 * tag* — anything inside a `{…}` prop belongs to JavaScript, not to the tag.
 * That distinction is the whole point: `disabled={… || matches.length > 0}`
 * used to read as the end of the tag, which hid every attribute written
 * after it. Not hypothetical — it is how the composer's send button, a
 * DISABLED control whose `title` could therefore never appear at all, sat in
 * this file's blind spot while the suite reported clean.
 *
 * Depth is counted from the tag rather than over the whole file because a
 * component's own body brace puts all of its JSX at depth ≥ 1, which makes a
 * global count say "expression" about everything and decide nothing.
 *
 * A `>` inside a quoted attribute value would still fool this. No such value
 * exists here, and the cost is a missed report rather than a false one.
 */
function tagClose(source: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ">" && depth === 0) return i;
  }
  return -1;
}

/** Line numbers carrying an HTML `title` attribute. */
function htmlTitles(source: string): number[] {
  const found: number[] = [];
  for (const match of source.matchAll(/\btitle=/g)) {
    const at = match.index!;
    const open = source.lastIndexOf("<", at);
    if (open < 0) continue;
    // `title=` on a <Component> is a React prop (`Modal`, `ConfirmDialog`);
    // on a lowercase tag it is the HTML attribute this rule is about.
    const tag = /^<\s*([A-Za-z][\w.]*)/.exec(source.slice(open));
    if (!tag || tag[1][0] !== tag[1][0].toLowerCase()) continue;
    // The nearest `<` going backwards is only OUR tag if it has not already
    // closed — otherwise this `title=` is loose text, not an attribute.
    const close = tagClose(source, open);
    if (close !== -1 && close < at) continue;
    found.push(source.slice(0, at).split("\n").length);
  }
  return found;
}

/** Line numbers where a `<Tip>` wraps a text field directly. */
function tipWrappedFields(source: string): number[] {
  const found: number[] = [];
  for (const match of source.matchAll(/<Tip\b/g)) {
    const close = tagClose(source, match.index!);
    if (close === -1) continue;
    if (/^\s*<(input|textarea)\b/.test(source.slice(close + 1))) {
      found.push(source.slice(0, match.index!).split("\n").length);
    }
  }
  return found;
}

describe("no control falls back to the browser tooltip", () => {
  const offenders = new Map<string, number[]>();
  for (const [file, source] of components()) {
    const lines = htmlTitles(source);
    if (lines.length) offenders.set(file, lines);
  }

  it("finds the files it is meant to be reading", () => {
    // A scan that matches nothing passes every assertion under it. `Tip` is
    // used widely enough that its absence means the walk broke, not that the
    // app stopped explaining itself.
    const withTips = components().filter(([, source]) => source.includes("<Tip"));
    expect(withTips.length).toBeGreaterThan(10);
  });

  it("leaves only the cases with a written reason", () => {
    const unexpected = [...offenders]
      .filter(([file]) => !(file in ALLOWED))
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(unexpected).toEqual([]);
  });

  it("holds each allowed file to the count its reason covers", () => {
    // So a NEW `title` in a file that already has an allowed one still fails
    // rather than hiding behind its neighbour's reason.
    const drifted = Object.entries(ALLOWED)
      .map(([file, { count }]) => [file, count, offenders.get(file)?.length ?? 0] as const)
      .filter(([, want, got]) => want !== got)
      .map(([file, want, got]) => `${file}: allowed ${want}, found ${got}`);
    expect(drifted).toEqual([]);
  });

  it("keeps text fields out of the app's own bubble as well", () => {
    // The other half of the same rule. `Tip` shows on `:focus-visible`, and
    // Chromium matches that on a TEXT input however it was focused — so a
    // wrapped field parks a bubble over the row above it for as long as
    // someone types, which is why two `title`s survive in the allowlist. The
    // rule was written down in three comments and held nowhere: a Tip around
    // an <input> is invisible both to the `title=` scan above and to
    // `Settings.tips.test.tsx`, which enumerates buttons. Put the
    // explanation on an InfoDot beside the label, as Home's voice field does.
    const wrapped = components()
      .map(([file, source]) => [file, tipWrappedFields(source)] as const)
      .filter(([, lines]) => lines.length)
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(wrapped).toEqual([]);
  });

  it("keeps a reason on every entry", () => {
    for (const [file, { why }] of Object.entries(ALLOWED)) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
