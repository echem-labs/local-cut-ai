/**
 * The shared artifact image (plan doc 11's component inventory: consumers
 * are the tiles and the canvas nodes).
 *
 * The case worth pinning is the failed load. Both consumers had their own
 * copy of it, and the copy they had hid the broken image outright — leaving
 * the empty frame that the fallback exists to fill.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaThumb } from "./MediaThumb";

describe("MediaThumb", () => {
  it("shows the artifact when there is one", () => {
    render(<MediaThumb src="http://engine/p1/abc" />);
    const img = document.querySelector("img")!;
    expect(img).toHaveAttribute("src", "http://engine/p1/abc");
    // Decorative: the tile or node around it already carries the name.
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("shows the fallback when there is no artifact yet", () => {
    render(<MediaThumb src={null} fallback={<span>no render</span>} />);
    expect(screen.getByText("no render")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("falls back when the artifact fails to load, rather than leaving a hole", () => {
    render(<MediaThumb src="http://engine/p1/gone" fallback={<span>no render</span>} />);
    fireEvent.error(document.querySelector("img")!);
    expect(screen.getByText("no render")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("tries again when the artifact changes", () => {
    // One 404 must not condemn every later render of the same tile: the
    // node re-renders with a new hash precisely because it succeeded.
    const { rerender } = render(<MediaThumb src="http://engine/p1/gone" />);
    fireEvent.error(document.querySelector("img")!);
    expect(document.querySelector("img")).toBeNull();

    rerender(<MediaThumb src="http://engine/p1/fresh" />);
    expect(document.querySelector("img")).toHaveAttribute("src", "http://engine/p1/fresh");
  });

  it("takes a name only where the image is the content", () => {
    render(<MediaThumb src="http://engine/p1/abc" alt="a bee on a flower" />);
    expect(screen.getByRole("img", { name: "a bee on a flower" })).toBeInTheDocument();
  });
});
