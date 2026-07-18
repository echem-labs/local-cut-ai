# LocalCut AI — brand assets

The mark is the **Cut Play** (design review 2): a play button sliced clean
through — the gap *is* the cut. Pure geometry, no letterforms.

| File | Use |
| --- | --- |
| `logo.svg` | Master mark on the brand-gradient tile. Scales losslessly — export PNGs at any size from this. |
| `logo-mono.svg` | One-color variant (`#5F4FD8`) for light grounds and print; recolor to `#fff` for dark grounds. |

The Windows app icon (`apps/desktop/build/icon.ico`) is generated from
`logo.svg` by `apps/desktop/scripts/make-icon.mjs` — re-run it after any
geometry change (`npm run icon` in `apps/desktop`).

## Palette — "Electric Iris"

| Token | Dark theme | Light theme |
| --- | --- | --- |
| Accent | `#7C6CF8` | `#5B49D6` |
| Accent hover | `#948AF9` | `#4E3BC9` |
| Ground | `#0E0F12` | `#F6F5F9` |
| Brand gradient | `#A395FF → #5F4FD8` (135°) | same |

The gradient is reserved for exactly two places — the logo mark and the
primary CTA. Everything else uses the flat accent; that restraint is what
keeps the gradient feeling premium. Status colors (amber draft, green
final, red failed) are reserved and never decorative.

In-app the mark is drawn by `apps/desktop/src/components/BrandMark.tsx`;
keep its geometry in sync with `logo.svg`.
