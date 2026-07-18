import { useEffect, type RefObject } from "react";

/** Close-on-outside-click for menus and popovers: while `active`, a
 * mousedown outside `ref` calls `onOutside`. One shared hook instead of
 * the same listener block re-typed per component. */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
