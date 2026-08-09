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

/** Line numbers carrying an HTML `title` attribute. */
function htmlTitles(source: string): number[] {
  // Same length, so offsets still line up.
  const scan = source.replace(/=>/g, "==").replace(/->/g, "--");
  const found: number[] = [];
  for (const match of source.matchAll(/\btitle=/g)) {
    let i = match.index!;
    while (i > 0) {
      i -= 1;
      if (scan[i] === ">") break;
      if (scan[i] === "<") {
        const tag = /^<\s*([A-Za-z][\w.]*)/.exec(scan.slice(i));
        if (tag && tag[1][0] === tag[1][0].toLowerCase()) {
          found.push(source.slice(0, match.index).split("\n").length);
        }
        break;
      }
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

  it("keeps a reason on every entry", () => {
    for (const [file, { why }] of Object.entries(ALLOWED)) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
