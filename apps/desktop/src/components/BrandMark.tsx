import { useId } from "react";

/** The Cut-Play mark (design review 2, pick A): a play button sliced clean
 * through — the gap is the cut. Master SVGs (gradient + mono) live in
 * branding/ at the repo root; keep geometry changes in sync. */
export function BrandMark({ size = 22 }: { size?: number }) {
  // Gradient ids are document-global in SVG — unique per instance so two
  // marks on screen never fight over the same defs.
  const gradientId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a395ff" />
          <stop offset="1" stopColor="#5f4fd8" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="24" fill={`url(#${gradientId})`} />
      <path d="M34 26 L52.3 35.5 L45.5 47.5 L34 74 Z" fill="#fff" />
      <path d="M57.5 38.2 L74 48 L40.5 74 L50.8 50.2 Z" fill="#fff" />
    </svg>
  );
}
