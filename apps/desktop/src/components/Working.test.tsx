import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { t } from "../i18n";
import { ELAPSED_AFTER_S, Elapsed, Spinner } from "./Working";

/**
 * The publish kit's busy line and the project's script wait were written a day
 * apart and had each grown their own spinner, their own clock and their own
 * answer on announcing it — one of which was wrong. These pin what they now
 * share.
 */

describe("the wait mark", () => {
  it("draws a partial arc, not a near-closed ring", () => {
    // The whole reason this is not an icon-set loader: those are rings with a
    // small gap, and turning one at this size moves only the gap, so a
    // correctly rotating spinner reads as a circle sitting still. The dash
    // pattern is what makes the motion legible, so it is what gets pinned.
    const { container } = render(<Spinner />);
    const arc = container.querySelector(".wait-ring .arc");

    expect(arc?.getAttribute("stroke-dasharray")).toBe("25 75");
    expect(arc?.getAttribute("pathLength")).toBe("100");
    expect(container.querySelector(".wait-ring.spin")).not.toBeNull();
  });
});

describe("the wait counter", () => {
  it("says nothing until the wait has earned a number", () => {
    render(<Elapsed seconds={ELAPSED_AFTER_S - 1} />);
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });

  it("is hidden from the accessibility tree", () => {
    // It lives inside a role="status", which is an ATOMIC live region: it
    // re-reads its whole contents on any change. An exposed counter therefore
    // makes a screen reader repeat the same sentence once a second, which is
    // what the publish kit's line did. The status text carries the meaning.
    render(<Elapsed seconds={9} />);
    const counter = screen.getByText(t("common.elapsedSeconds", { seconds: 9 }));

    expect(counter.closest("[aria-hidden='true']")).not.toBeNull();
  });
});
