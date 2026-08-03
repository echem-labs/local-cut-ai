import { useEffect, useState } from "react";

/** Reactive media-query match. SSR is not a concern (Electron renderer),
 * so the initial state reads the real match rather than defaulting false —
 * a rail that mounts expanded and snaps compact a frame later flickers. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
