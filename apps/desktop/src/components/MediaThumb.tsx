import { useEffect, useState, type ReactNode } from "react";

/**
 * An artifact image with a fallback for the two ways it can be absent: there
 * is no render yet, and there is one whose bytes will not load.
 *
 * Extracted because the second case is the easy one to get wrong. The tile
 * hid the broken image with `style.display = "none"`, which leaves the empty
 * frame the fallback existed to fill — the icon is the OTHER branch of the
 * ternary and by then it is not rendered. Both consumers (tiles, canvas
 * nodes) now fall back the same way, and the behaviour has one test instead
 * of none.
 *
 * Decorative by default. The thing an artifact belongs to — a tile, a node —
 * already carries the accessible name, so a second one here would read the
 * project or node twice. Pass `alt` only where the image is the content.
 */
export function MediaThumb({
  src,
  alt = "",
  className,
  fallback = null,
}: {
  /** The artifact URL, or null when nothing has been rendered yet. */
  src: string | null;
  alt?: string;
  className?: string;
  /** Shown when there is no `src`, and when the one there fails to load. */
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  // A new artifact deserves a fresh attempt: without this, one 404 would
  // keep the fallback in place for every later render of the same tile.
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return <>{fallback}</>;
  return (
    <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  );
}
