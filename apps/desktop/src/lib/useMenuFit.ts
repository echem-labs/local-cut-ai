import { useCallback, useEffect, useRef } from "react";

/**
 * Keep an open popover inside the window.
 *
 * A `.menu-pop` is placed against its trigger and sized by its contents, so
 * one with enough rows in it simply runs off the bottom of the screen. The
 * board menu is the one that does — history, audio, captions, frame rate,
 * resolution, the pro-editor handoff and workspace come to about twenty rows,
 * and the last sections were unreachable at any ordinary window height. There
 * was no scrollbar to say so either: the menu was drawn in full and the
 * window simply ended.
 *
 * The stylesheet cannot fix this alone, which is why it stayed broken — CSS
 * has no way to know how far down the page the trigger sits. So measure once
 * the browser has placed the menu and cap it to the room actually left;
 * `overflow-y: auto` on the menu turns that cap into a scroll rather than a
 * clip.
 *
 * Which way the menu opens is read off where it landed rather than passed in.
 * Two of these open upward (the composer's readiness popover, the canvas Add
 * menu) and both do it from the stylesheet, so a direction flag per call site
 * would be a second copy of that fact — wrong in exactly the case nobody
 * looks at.
 *
 * One shared hook, like `useOutsideClick` beside it: every menu in the app
 * wants this and none of them should be deciding it for themselves.
 */

/** Breathing room between the menu and the window edge. */
const EDGE = 8;

/** A cap tighter than this is not a menu any more. If the trigger is that
 *  close to the edge the placement is what needs fixing, and clamping to a
 *  sliver would hide the problem behind three scrollable rows. */
const FLOOR = 120;

export function useMenuFit(): (element: HTMLElement | null) => void {
  const elementRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    // Drop the previous cap before measuring. It changes nothing for the two
    // placements that exist today — both pin the very edge this measures
    // from, so the height cannot feed back into it — but that is a property
    // of the stylesheet, not of this function, and a menu anchored any other
    // way would otherwise ratchet smaller on every resize.
    element.style.maxHeight = "";
    const menu = element.getBoundingClientRect();
    // The offsetParent is the positioned wrapper the menu is anchored to.
    const anchor = (element.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const opensUp = anchor !== undefined && menu.bottom <= anchor.top;
    const room = opensUp ? menu.bottom - EDGE : window.innerHeight - menu.top - EDGE;
    element.style.maxHeight = `${Math.max(room, FLOOR)}px`;
  }, []);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // A ref callback rather than a ref plus an effect: it runs the moment the
  // node is attached, so the menu is never painted at its full height first
  // and then snapped shorter.
  return useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element;
      if (element) measure();
    },
    [measure],
  );
}
