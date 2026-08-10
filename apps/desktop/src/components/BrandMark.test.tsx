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

/** Compared as a parsed tree, not as text: the two files are written by hand
 * in different languages, so indentation, attribute order and the JSX
 * self-closing style differ and none of that is drift. */
function shapeOf(root: Element) {
  return {
    viewBox: root.getAttribute("viewBox"),
    tileRadius: root.querySelector("rect")?.getAttribute("rx"),
    paths: [...root.querySelectorAll("path")].map((node) => node.getAttribute("d")),
    // Case-insensitive: CSS hex is case-blind and the two files disagree on
    // it today, which is not a difference worth failing over.
    gradient: [...root.querySelectorAll("stop")].map((node) =>
      node.getAttribute("stop-color")?.toLowerCase(),
    ),
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
