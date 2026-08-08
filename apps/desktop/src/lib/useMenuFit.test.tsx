import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMenuFit } from "./useMenuFit";

/**
 * jsdom performs no layout — every rect it reports is zero — so where the
 * menu and its anchor sit is the test's to state. That is fine here: the
 * thing under test is the arithmetic between a placement and a cap, and the
 * placements below are the two the app actually produces.
 */
const WINDOW_H = 800;

/** Places the menu, and the wrapper it is anchored to, in the window. */
function place(menu: { top: number; height: number }, anchorTop: number | null) {
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 230 }) as DOMRect;

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.role === "anchor" ? rect(anchorTop ?? 0, 28) : rect(menu.top, menu.height);
  });
  // jsdom leaves offsetParent null, so the hook would read every menu as
  // opening downward. Give it the wrapper the stylesheet anchors against.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return anchorTop === null ? null : (this.parentElement as HTMLElement | null);
  });
}

function Menu() {
  const fit = useMenuFit();
  return (
    <div data-role="anchor">
      <div data-testid="menu" ref={fit} />
    </div>
  );
}

const capOf = (container: HTMLElement) =>
  (container.querySelector<HTMLElement>('[data-testid="menu"]') as HTMLElement).style.maxHeight;

afterEach(() => vi.restoreAllMocks());

describe("useMenuFit", () => {
  it("caps a menu drawn below its trigger to the room under it", () => {
    // The board menu: a header trigger and about twenty rows, which came to
    // more than the window had left and simply ran off the bottom.
    vi.stubGlobal("innerHeight", WINDOW_H);
    place({ top: 96, height: 620 }, 60);
    const { container } = render(<Menu />);
    // 800 - 96, less the 8px it keeps off the window edge.
    expect(capOf(container)).toBe("696px");
  });

  it("caps a menu drawn above its trigger to the room over it", () => {
    // The composer's readiness popover and the canvas Add menu both open
    // upward, from the stylesheet. Passing the direction in per call site
    // would be a second copy of that fact, wrong in the case nobody looks at.
    vi.stubGlobal("innerHeight", WINDOW_H);
    place({ top: 40, height: 500 }, 620);
    const { container } = render(<Menu />);
    // The menu's bottom edge is 540 and it grows toward the top of the
    // window, so the room is what is above it — not what is below.
    expect(capOf(container)).toBe("532px");
  });

  it("re-measures when the window resizes", () => {
    vi.stubGlobal("innerHeight", WINDOW_H);
    place({ top: 96, height: 620 }, 60);
    const { container } = render(<Menu />);
    expect(capOf(container)).toBe("696px");

    vi.stubGlobal("innerHeight", 500);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(capOf(container)).toBe("396px");

    vi.stubGlobal("innerHeight", WINDOW_H);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(capOf(container)).toBe("696px");
  });

  it("stops caring below a cap that is no longer a menu", () => {
    // A trigger this close to the window's edge is a placement bug. Clamping
    // to a sliver would hide it behind three scrollable rows.
    vi.stubGlobal("innerHeight", WINDOW_H);
    place({ top: 780, height: 300 }, 750);
    const { container } = render(<Menu />);
    expect(capOf(container)).toBe("120px");
  });

  it("drops its listener on unmount", () => {
    vi.stubGlobal("innerHeight", WINDOW_H);
    place({ top: 96, height: 620 }, 60);
    const remove = vi.spyOn(window, "removeEventListener");
    render(<Menu />).unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});

/**
 * Every menu, not only the one that was reported.
 *
 * The board menu is what ran off the bottom of the screen, but nothing about
 * it is special — it is the tallest, so it got there first. Eight other
 * popovers wear the same two classes and would each arrive as its own
 * screenshot the first time someone gave one another section.
 */
const SOURCES = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("every popover is bounded", () => {
  it("has no menu placed without a height it cannot exceed", () => {
    // Either the shared hook, or an explicit `maxHeight` of its own. The
    // composer's scope menu is the second: it hangs off its chip in VIEWPORT
    // coordinates under `position: fixed`, so it has no offsetParent to
    // measure against and computes its own ceiling at the moment it opens.
    // Converting it to the hook would undo the fix that made it size to the
    // chip rather than to the window.
    //
    // `[^>]*` spans the whole opening tag however prettier wraps it — none
    // of these tags contains a `>` of its own.
    const tags = /<div[^>]*className="(?:menu-pop|dropdown-menu)[^>]*>/g;
    const offenders = Object.entries(SOURCES)
      .filter(([file]) => !file.endsWith(".test.tsx"))
      .flatMap(([file, source]) =>
        (source.match(tags) ?? [])
          .filter((tag) => !tag.includes("ref={fit}") && !tag.includes("maxHeight"))
          .map(() => file),
      );
    expect(offenders).toEqual([]);
  });

  it("is reading sources, not an empty glob", () => {
    // The CSS half of this rule had to move to the engine's contract suite
    // because vitest stubs stylesheet imports to "" — a check that passes
    // against nothing passes against anything. `.tsx` really is read here,
    // and this is what says so.
    const tagged = Object.values(SOURCES).filter((source) =>
      /className="(?:menu-pop|dropdown-menu)/.test(source),
    );
    expect(tagged.length).toBeGreaterThanOrEqual(8);
  });
});
