/**
 * The on-screen mark and the master SVG are the same mark.
 *
 * branding/logo.svg is what every shipped icon is rendered from — the exe
 * resource, the .icns, the Linux PNG, the favicon. BrandMark.tsx is the same
 * geometry retyped as JSX, because an <img> would not let the gradient take
 * a unique id per instance. Nothing but a comment in each file held the two
 * together, so a change to one had no way of reaching the other: the app
 * would show one logo and every icon around it a different one, and the
 * diff that caused it would look complete on its own.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

const here = path.dirname(fileURLToPath(import.meta.url));
const masterPath = path.join(here, "..", "..", "..", "..", "branding", "logo.svg");

/** A paint value, normalised for the two differences that are not drift: CSS
 * hex is case-blind and the two files disagree on it today, and the gradient
 * reference carries an id that is deliberately different — BrandMark mints a
 * unique one per instance so two marks on screen cannot collide. */
const PAINTS = new Set(["fill", "stop-color"]);
const paint = (value: string | null): string | null =>
  value === null ? null : value.toLowerCase().replace(/^url\(#.+\)$/, "url(#gradient)");

/** Compared as a parsed tree, not as text: the two files are written by hand
 * in different languages, so indentation, attribute order and the JSX
 * self-closing style differ and none of that is drift.
 *
 * Every attribute that decides what the mark LOOKS like is in here. Comparing
 * only the path data and the stop colours left the gradient's direction, the
 * stop positions, the fills and the tile's own box free to diverge — each of
 * them a change every shipped icon would pick up and the on-screen mark
 * would not, which is the whole failure this file exists to prevent. */
function shapeOf(root: Element) {
  // Only a paint goes through `paint()`: lowercasing path data as well would
  // turn absolute commands into relative ones and hide a real geometry change.
  const attrs = (node: Element | null | undefined, ...names: string[]) =>
    node
      ? Object.fromEntries(
          names.map((name) => {
            const value = node.getAttribute(name);
            return [name, PAINTS.has(name) ? paint(value) : value];
          }),
        )
      : null;
  return {
    viewBox: root.getAttribute("viewBox"),
    tile: attrs(root.querySelector("rect"), "x", "y", "width", "height", "rx", "fill"),
    gradient: attrs(root.querySelector("linearGradient"), "x1", "y1", "x2", "y2"),
    stops: [...root.querySelectorAll("stop")].map((node) => attrs(node, "offset", "stop-color")),
    paths: [...root.querySelectorAll("path")].map((node) => attrs(node, "d", "fill")),
  };
}

describe("the Cut-Play mark", () => {
  it("matches branding/logo.svg, which every app icon is rendered from", () => {
    const master = new DOMParser().parseFromString(
      readFileSync(masterPath, "utf8"),
      "image/svg+xml",
    ).documentElement;
    const { container } = render(<BrandMark />);
    const onScreen = container.querySelector("svg");

    expect(onScreen).not.toBeNull();
    // Guard the fixture: an unreadable or reshaped master would otherwise
    // make this pass by comparing two sets of nulls.
    expect(master.querySelectorAll("path")).toHaveLength(2);

    expect(shapeOf(onScreen!)).toEqual(shapeOf(master));
  });
});
